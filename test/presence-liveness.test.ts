import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { MAX_CONNECTIONS_PER_XUID, SESSION_IDLE_TIMEOUT_MS } from "../src/protocol";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const open: Client[] = [];
let now: number;
let clock: ReturnType<typeof vi.spyOn>;
beforeAll(installFakeIssuer);
beforeEach(() => {
  now = Date.now();
  clock = vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(async () => {
  clock.mockRestore();
  await Promise.all(open.splice(0).map((client) => (client.close(), client.closed)));
});

/** Authenticates an account and retains its connection for cleanup. */
async function player(options: Parameters<typeof login>[0] = {}) {
  const { client } = await login(options);
  open.push(client);
  return client;
}

it("excludes a silent open account at the idle deadline, including after a wake", async () => {
  await player();
  await runInDurableObject(hub(), (instance: Hub, state) => {
    clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS - 1);
    expect(instance.onlineCount()).toBe(1);
    clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
    expect(instance.onlineCount()).toBe(0);
    expect(new Hub(state, env).onlineCount()).toBe(0);
  });
});

it("refreshes the public count without retaining an expired account", async () => {
  await player();
  const response = await exports.default.fetch("https://api.test/v1/presence/count");
  expect(await response.json()).toEqual({ online: 1 });
  clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
  const expired = await exports.default.fetch("https://api.test/v1/presence/count");
  expect(await expired.json()).toEqual({ online: 0 });
});

it("renews the idle deadline on ordinary client messages", async () => {
  await player();
  await runInDurableObject(hub(), async (instance: Hub, state) => {
    const ws = state.getWebSockets()[0]!;
    clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS - 1);
    await instance.webSocketMessage(ws, '{"type":"lookup","id":1,"xuids":[]}');
    clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
    expect(new Hub(state, env).onlineCount()).toBe(1);
    clock.mockReturnValue(now + 2 * SESSION_IDLE_TIMEOUT_MS - 1);
    expect(instance.onlineCount()).toBe(0);
  });
});

it("uses the runtime heartbeat timestamp after hibernation without renewing silent sockets", async () => {
  const client = await player();
  client.send("ping");
  expect(await client.next()).toEqual({ type: "pong" });
  await evictDurableObject(hub());
  await runInDurableObject(hub(), (instance: Hub, state) => {
    const ws = state.getWebSockets()[0]!;
    expect(state.getWebSocketAutoResponseTimestamp(ws)).not.toBeNull();
    const heartbeat = now + SESSION_IDLE_TIMEOUT_MS / 2;
    const timestamp = vi.spyOn(state, "getWebSocketAutoResponseTimestamp").mockReturnValue(new Date(heartbeat));
    try {
      clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
      expect(instance.onlineCount()).toBe(1);
      expect(new Hub(state, env).onlineCount()).toBe(1);
      clock.mockReturnValue(heartbeat + SESSION_IDLE_TIMEOUT_MS);
      expect(new Hub(state, env).onlineCount()).toBe(0);
    } finally {
      timestamp.mockRestore();
    }
  });
});

it.each([true, false])("ignores a stale duplicate while a fresh socket is visible=%s", async (visible) => {
  await player({ xuid: "101" });
  clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS - 1);
  await player({ xuid: "101", visible });
  clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
  await runInDurableObject(hub(), (instance: Hub) => {
    expect(instance.onlineCount()).toBe(visible ? 1 : 0);
  });
});

it("closes idle accounts on maintenance while retaining a recently active peer", async () => {
  const stale = await player({ xuid: "101" });
  await player({ xuid: "102" });
  await runInDurableObject(hub(), async (instance: Hub, state) => {
    const ws = state.getWebSockets().find((socket) => socket.deserializeAttachment()?.xuid === "102")!;
    const heartbeat = now + SESSION_IDLE_TIMEOUT_MS / 2;
    const timestamp = vi.spyOn(state, "getWebSocketAutoResponseTimestamp")
      .mockImplementation((socket) => socket === ws ? new Date(heartbeat) : null);
    try {
      clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(instance.onlineCount()).toBe(1);
      expect(new Hub(state, env).onlineCount()).toBe(1);
      expect(await state.storage.getAlarm()).toBe(heartbeat + SESSION_IDLE_TIMEOUT_MS);
    } finally {
      timestamp.mockRestore();
    }
  });
  expect((await stale.closed).code).toBe(1001);
});

it("reclaims stale account slots before admitting a reconnect", async () => {
  for (let i = 0; i < MAX_CONNECTIONS_PER_XUID; i++) await player();
  clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
  await player();
  await runInDurableObject(hub(), (instance: Hub) => expect(instance.onlineCount()).toBe(1));
});

it("bounds old attachments without an activity field instead of refreshing them on every wake", async () => {
  await player();
  await runInDurableObject(hub(), (_, state) => {
    const ws = state.getWebSockets()[0]!;
    const attachment = ws.deserializeAttachment();
    delete attachment.lastActivity;
    ws.serializeAttachment(attachment);
    clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
    expect(new Hub(state, env).onlineCount()).toBe(0);
    expect(new Hub(state, env).onlineCount()).toBe(0);
  });
});
