import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const ALEX = "2535400000000101";
const STEVE = "2535400000000102";
const ALEX_UUID = "67ee0087-98f0-325d-be73-da634a187b80";
const STEVE_UUID = "e367d8c0-b340-3da7-8b77-90d9a5934061";
const NOBODY_UUID = "a8a84e9b-539a-3eea-b942-0f60b1980667";
const open: Client[] = [];

beforeAll(installFakeIssuer);
beforeEach(async () => {
  await runInDurableObject(hub(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(hub());
});
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

/** Logs in and retains each socket for cleanup. */
async function player(options: Parameters<typeof login>[0] = {}): Promise<Client> {
  const { client } = await login(options);
  open.push(client);
  return client;
}

/** Sends either identifier array and surfaces unexpected closes without waiting for a message. */
async function lookup(client: Client, identifiers: { xuids?: string[]; uuids?: string[] }, id = 1) {
  client.send({ type: "lookup", id, ...identifiers });
  return Promise.race([client.next(), client.closed]);
}

describe("UUID lookup", () => {
  it("returns only requested matches, deduplicated in each array's order", async () => {
    const me = await player();
    await player({ xuid: ALEX });
    await player({ xuid: STEVE, visible: false });
    expect(await lookup(me, { uuids: [NOBODY_UUID, ALEX_UUID, STEVE_UUID, ALEX_UUID] }, 7)).toEqual({
      type: "lookup_result", id: 7, cinnabar: [], cinnabar_uuids: [ALEX_UUID],
    });
    expect(await lookup(me, { xuids: [STEVE], uuids: [ALEX_UUID] })).toEqual({
      type: "lookup_result", id: 1, cinnabar: [], cinnabar_uuids: [ALEX_UUID],
    });
    expect(await lookup(me, { xuids: [ALEX, ALEX], uuids: [STEVE_UUID] })).toEqual({
      type: "lookup_result", id: 1, cinnabar: [ALEX], cinnabar_uuids: [],
    });
    expect(await me.lookup([ALEX])).toEqual({ type: "lookup_result", id: 1, cinnabar: [ALEX] });
  });

  it("rebuilds UUID presence after hibernation and follows visibility changes", async () => {
    const me = await player();
    const alex = await player({ xuid: ALEX });
    await player({ xuid: STEVE, visible: false });
    await evictDurableObject(hub());
    expect(await lookup(me, { uuids: [ALEX_UUID, STEVE_UUID] })).toMatchObject({ cinnabar_uuids: [ALEX_UUID] });
    alex.send({ type: "visibility", visible: false });
    expect(await lookup(me, { uuids: [ALEX_UUID] })).toMatchObject({ cinnabar_uuids: [] });
    alex.send({ type: "visibility", visible: true });
    expect(await lookup(me, { uuids: [ALEX_UUID] })).toMatchObject({ cinnabar_uuids: [ALEX_UUID] });
  }, 10_000);

  it("lingers by both identifiers for thirty minutes, then expires", async () => {
    const me = await player();
    const alex = await player({ xuid: ALEX });
    alex.close();
    await alex.closed;
    expect(await lookup(me, { xuids: [ALEX], uuids: [ALEX_UUID] })).toMatchObject({
      cinnabar: [ALEX], cinnabar_uuids: [ALEX_UUID],
    });
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000 + 1);
      try {
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 8, xuids: [ALEX], uuids: [ALEX_UUID] }));
        await instance.alarm();
      } finally {
        clock.mockRestore();
      }
    });
    expect(await me.next()).toEqual({ type: "lookup_result", id: 8, cinnabar: [], cinnabar_uuids: [] });
  });

  it.each(["reconnect", "visibility"])("clears both retained identifiers on hidden %s", async (mode) => {
    const me = await player();
    const shown = await player({ xuid: ALEX });
    const hidden = mode === "visibility" ? await player({ xuid: ALEX, visible: false }) : undefined;
    shown.close();
    await shown.closed;
    expect(await lookup(me, { uuids: [ALEX_UUID] })).toMatchObject({ cinnabar_uuids: [ALEX_UUID] });
    if (hidden) hidden.send({ type: "visibility", visible: false });
    else await player({ xuid: ALEX, visible: false });
    expect(await lookup(me, { xuids: [ALEX], uuids: [ALEX_UUID] })).toMatchObject({ cinnabar: [], cinnabar_uuids: [] });
  });

  it("answers empty lookups with empty results, free and without closing", async () => {
    const me = await player();
    await player({ xuid: ALEX });
    expect(await lookup(me, {}, 2)).toEqual({ type: "lookup_result", id: 2, cinnabar: [] });
    expect(await lookup(me, { xuids: [], uuids: [] }, 3)).toEqual({
      type: "lookup_result", id: 3, cinnabar: [], cinnabar_uuids: [],
    });
    const uuids = Array.from({ length: 128 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    for (let id = 0; id < 8; id++) expect(await lookup(me, { uuids }, id)).toMatchObject({ type: "lookup_result" });
  });

  it("charges both arrays to the same durable account budget", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const me = await player();
      const xuids = Array.from({ length: 64 }, (_, i) => String(1000 + i));
      const uuids = Array.from({ length: 64 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
      for (let id = 0; id < 8; id++) {
        expect(await lookup(me, { xuids, uuids }, id)).toMatchObject({ type: "lookup_result" });
      }
      expect(await lookup(me, { uuids: [NOBODY_UUID] }, 99)).toEqual({ type: "error", code: "rate_limited", id: 99 });
      await evictDurableObject(hub());
      const second = await player();
      expect(await lookup(second, { xuids: ["9"] }, 100)).toEqual({ type: "error", code: "rate_limited", id: 100 });
    } finally {
      clock.mockRestore();
    }
  }, 10_000);

  it("rejects a mixed batch over 128 even when each array fits", async () => {
    const me = await player();
    me.send({ type: "lookup", id: 1, xuids: Array(64).fill(ALEX), uuids: Array(65).fill(ALEX_UUID) });
    expect((await me.closed).code).toBe(1008);
  });
});
