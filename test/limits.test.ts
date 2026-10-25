import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { HANDSHAKE_TIMEOUT_MS, MAX_CONNECTIONS, MAX_CONNECTIONS_PER_IP } from "../src/protocol";
import { Client, clientKey, hello, hub, installFakeIssuer, mintToken, sign } from "./helpers";

// Exercise the real admission path without opening 20,000 sockets in each test.
vi.mock("../src/protocol", async (original) => ({
  ...(await original<typeof import("../src/protocol")>()),
  MAX_CONNECTIONS: 12,
  MAX_CONNECTIONS_PER_IP: 8,
}));

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Requests an upgrade through the Worker, retaining accepted sockets for cleanup. */
async function upgrade(ip = "192.0.2.1", options?: WebSocketAcceptOptions): Promise<Response> {
  const response = await exports.default.fetch("https://api.test/v1/connect", {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
  });
  if (response.webSocket) open.push(new Client(response.webSocket, options));
  return response;
}

/** Checks that an admission refusal includes a positive retry delay and no socket. */
function expectLimited(response: Response): void {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(response.webSocket).toBeNull();
}

describe("connection caps", () => {
  it("schedules a new handshake before an existing later maintenance alarm", async () => {
    await runInDurableObject(hub(), (_, state) => state.storage.setAlarm(Date.now() + 300_000));
    await upgrade();
    await runInDurableObject(hub(), async (_, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      // Admission can wait on I/O; compare against the actor's clock after it completes.
      expect(alarm).toBeLessThanOrEqual(Date.now() + HANDSHAKE_TIMEOUT_MS);
    });
  });

  it("checks admission counters without scanning attached sockets", async () => {
    await upgrade();
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const scan = vi.spyOn(state, "getWebSockets");
      try {
        const response = await instance.fetch(new Request("https://api.test/v1/connect", {
          headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.1" },
        }));
        expect(response.status).toBe(101);
        response.webSocket!.accept();
        try {
          expect(scan).not.toHaveBeenCalled();
        } finally {
          response.webSocket!.close(1000);
        }
      } finally {
        scan.mockRestore();
      }
    });
  });

  describe.each(["global"] as const)("%s cap for closing sockets", (cap) => {
    it.each(["rejected", "timed out"] as const)("keeps %s sockets counted until their Close reply", async (cause) => {
      const count = cap === "global" ? MAX_CONNECTIONS : MAX_CONNECTIONS_PER_IP;
      for (let i = 0; i < count; i++) {
        await upgrade(cap === "global" ? `192.0.2.${i + 1}` : "192.0.2.1", { allowHalfOpen: true });
      }
      expectLimited(await upgrade());
      if (cause === "rejected") open[0]!.send({ type: "lookup", id: 1, xuids: [] });
      else {
        await runInDurableObject(hub(), (instance: Hub) => {
          instance.expireHandshakes(Date.now() + HANDSHAKE_TIMEOUT_MS + 1);
        });
      }
      expect((await open[0]!.closed).code).toBe(4401);
      expect(open[0]!.ws.readyState).toBe(WebSocket.CLOSING);
      await runInDurableObject(hub(), (_: Hub, state) => {
        const sockets = state.getWebSockets();
        expect(sockets).toHaveLength(count);
        expect(sockets.some((ws) => ws.readyState === WebSocket.CLOSING)).toBe(true);
      });
      for (let i = 0; i < 3; i++) expectLimited(await upgrade());
      if (cap === "global") {
        await evictDurableObject(hub());
        expectLimited(await upgrade());
      }
      open[0]!.close();
      await expect.poll(() => runInDurableObject(hub(), (_: Hub, state) => state.getWebSockets().length)).toBe(count - 1);
      expect((await upgrade()).status).toBe(101);
      expectLimited(await upgrade());
    });
  });

  it("refuses upgrades at the global cap and admits after a close, even after waking", async () => {
    for (let i = 0; i < MAX_CONNECTIONS; i++) expect((await upgrade(`192.0.2.${i + 1}`)).status).toBe(101);
    expectLimited(await upgrade("198.51.100.1"));
    await evictDurableObject(hub());
    expectLimited(await upgrade("198.51.100.1"));
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade("198.51.100.1")).status).toBe(101);
    expectLimited(await upgrade("198.51.100.2"));
  });

  it("limits each IP independently and releases its slot after close", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
    expect((await upgrade("198.51.100.1")).status).toBe(101);
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });

  it.each(["global", "IP"])("releases the %s cap on handshake timeout", async (cap) => {
    const count = cap === "global" ? MAX_CONNECTIONS : MAX_CONNECTIONS_PER_IP;
    for (let i = 0; i < count; i++) await upgrade(cap === "global" ? `192.0.2.${i + 1}` : "192.0.2.1");
    expectLimited(await upgrade());
    await runInDurableObject(hub(), (instance: Hub) => {
      instance.expireHandshakes(Date.now() + HANDSHAKE_TIMEOUT_MS + 1);
    });
    expect((await open[0]!.closed).code).toBe(4401);
    expect((await upgrade()).status).toBe(101);
  });

  it("counts concurrent admissions once and releases errors and repeated cleanup once", async () => {
    const responses = await Promise.all(Array.from({ length: MAX_CONNECTIONS_PER_IP + 4 }, () => upgrade()));
    expect(responses.filter((r) => r.status === 101)).toHaveLength(MAX_CONNECTIONS_PER_IP);
    for (const response of responses.filter((r) => r.status !== 101)) expectLimited(response);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets()[0]!;
      await instance.webSocketError(ws);
      await instance.webSocketError(ws);
      await instance.webSocketClose(ws, 1000, "");
    });
    expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });

  it("holds the global cap during concurrent upgrades from different IPs", async () => {
    const responses = await Promise.all(
      Array.from({ length: MAX_CONNECTIONS + 4 }, (_, i) => upgrade(`192.0.2.${i + 1}`)),
    );
    expect(responses.filter((r) => r.status === 101)).toHaveLength(MAX_CONNECTIONS);
    for (const response of responses.filter((r) => r.status !== 101)) expectLimited(response);
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade("198.51.100.1")).status).toBe(101);
    expectLimited(await upgrade("198.51.100.2"));
  });

  it("buckets equivalent IPv6 addresses by /64 and separates other prefixes", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
      expect((await upgrade(`2001:db8:1234:5678::${i + 1}`)).status).toBe(101);
    }
    expectLimited(await upgrade("2001:0db8:1234:5678:abcd:1234:5678:9999"));
    expect((await upgrade("2001:db8:1234:5679::1")).status).toBe(101);
  });

  it("drops the IP cap after authentication so shared networks can hold more ready sockets", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
      await upgrade();
      const client = open.at(-1)!;
      const key = await clientKey();
      client.send(hello(await mintToken({ cpk: key.cpk, xid: String(100 + i) })));
      const challenge = await client.next();
      client.send({ type: "proof", signature: await sign(key, challenge.nonce as string) });
      expect((await client.next()).type).toBe("welcome");
    }
    expect((await upgrade()).status).toBe(101);
  });

  it("rebuilds pending IP counters after hibernation without retaining raw addresses", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await upgrade();
    expectLimited(await upgrade());
    await evictDurableObject(hub());
    expectLimited(await upgrade());
    await runInDurableObject(hub(), async (_: Hub, state) => {
      for (const ws of state.getWebSockets()) {
        expect(ws.deserializeAttachment()).toMatchObject({ stage: "hello", deadline: expect.any(Number) });
        expect(JSON.stringify(ws.deserializeAttachment())).not.toContain("192.0.2.1");
      }
      expect(JSON.stringify([...await state.storage.list()])).not.toContain("192.0.2.1");
    });
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });
});
