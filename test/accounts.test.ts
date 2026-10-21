import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { clientKey, connect, hello, hub, installFakeIssuer, login, mintToken, sign, type Client } from "./helpers";

const open: Client[] = [];
const roster = Array.from({ length: 128 }, (_, i) => String(1000 + i));
beforeAll(installFakeIssuer);
beforeEach(async () => {
  await runInDurableObject(hub(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(hub());
});
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Logs in and retains the client for cleanup. */
async function player(xuid = "1") {
  const { client } = await login({ xuid });
  open.push(client);
  return client;
}

/** Spends all 1,024 XUID tokens in eight full batches. */
async function drain(client: Client) {
  for (let i = 0; i < 8; i++) expect((await client.lookup(roster, i)).type).toBe("lookup_result");
}

describe("per-account admission", () => {
  it("allows four ready sockets and refuses the fifth with a stay-away delay, including after wake", async () => {
    for (let i = 0; i < 4; i++) await player();
    await evictDurableObject(hub());
    const key = await clientKey();
    const client = await connect();
    open.push(client);
    client.send(hello(await mintToken({ cpk: key.cpk, xid: "1" })));
    const challenge = await client.next();
    client.send({ type: "proof", signature: await sign(key, challenge.nonce as string) });
    expect(await Promise.race([client.closed, client.next()])).toEqual({ code: 4429, reason: "retry_after=10" });
    open[0]!.close();
    await open[0]!.closed;
    expect((await (await player()).lookup([])).type).toBe("lookup_result");
    expect((await (await player("2")).lookup([])).type).toBe("lookup_result");
  }, 10_000);
});

describe("per-account lookup bucket", () => {
  beforeEach(() => {
    // Token refill advances only when a test explicitly advances this clock.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    return () => clock.mockRestore();
  });

  it("keeps a visibility opt-out while a refused lookup is completing", async () => {
    const client = await player();
    await drain(client);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      const lookup = instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 99, xuids: ["9"] }));
      await instance.webSocketMessage(ws, JSON.stringify({ type: "visibility", visible: false }));
      await lookup;
      expect(ws.deserializeAttachment().visible).toBe(false);
    });
    expect((await client.next()).code).toBe("rate_limited");
  });

  it("closes after three concurrent rate-limited lookups", async () => {
    const client = await player();
    await drain(client);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      await Promise.all([20, 21, 22].map((id) => instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id, xuids: ["9"] }))));
      expect(ws.readyState).toBe(WebSocket.CLOSING);
    });
    expect((await client.closed).code).toBe(1008);
  });

  it("charges XUIDs rather than messages and shares the budget across sockets", async () => {
    const first = await player();
    await drain(first);
    const second = await player();
    expect(await second.lookup(["9"], 99)).toEqual({ type: "error", code: "rate_limited", id: 99 });
    expect((await first.lookup([])).type).toBe("lookup_result");
    expect((await (await player("2")).lookup(roster)).type).toBe("lookup_result");
  });

  it("stores a bucket row only when the account's last socket leaves", async () => {
    const first = await player();
    await drain(first);
    const rows = () => runInDurableObject(hub(), (_, state) => state.storage.sql.exec("SELECT xuid FROM lookup_budgets").toArray());
    expect(await rows()).toEqual([]);
    first.close();
    await first.closed;
    expect(await rows()).toHaveLength(1);
  });

  it("keeps a spent bucket after the last disconnect and hibernation", async () => {
    const first = await player();
    await drain(first);
    first.close();
    await first.closed;
    await evictDurableObject(hub());
    expect((await (await player()).lookup(["9"])).code).toBe("rate_limited");
  });

  it("refills 512 XUIDs per minute without granting more than capacity", async () => {
    const client = await player();
    await drain(client);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 15_001);
      try {
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 20, xuids: roster }));
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 21, xuids: ["9"] }));
        clock.mockReturnValue(now + 240_000);
        for (let id = 30; id < 38; id++) {
          await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id, xuids: roster }));
        }
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 38, xuids: ["9"] }));
      } finally {
        clock.mockRestore();
      }
    });
    expect(await client.next()).toMatchObject({ type: "lookup_result", id: 20 });
    expect(await client.next()).toEqual({ type: "error", code: "rate_limited", id: 21 });
    for (let id = 30; id < 38; id++) expect(await client.next()).toMatchObject({ type: "lookup_result", id });
    expect(await client.next()).toEqual({ type: "error", code: "rate_limited", id: 38 });
  });

  it("closes after three rate-limited replies", async () => {
    const client = await player();
    await drain(client);
    for (let id = 20; id < 23; id++) {
      expect(await client.lookup(["9"], id)).toEqual({ type: "error", code: "rate_limited", id });
    }
    expect((await client.closed).code).toBe(1008);
  });

  it("expires unused account budgets after five minutes", async () => {
    const client = await player();
    await client.lookup(["9"]);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
      try {
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT * FROM lookup_budgets").toArray()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });
  });
});
