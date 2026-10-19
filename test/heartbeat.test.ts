import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { SESSION_IDLE_TIMEOUT_MS } from "../src/protocol";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

/** Authenticates a tracked client without sending any automatic heartbeats. */
async function player(xuid = "101", visible = true) {
  const { client } = await login({ xuid, visible });
  open.push(client);
  return client;
}

it.each(["current", "legacy"])("excludes a silent account with a %s attachment before its disconnect is detected", async (format) => {
  const before = Date.now();
  await player();
  const after = Date.now();
  await runInDurableObject(hub(), (instance: Hub, state) => {
    if (format === "legacy") {
      const ws = state.getWebSockets().find((socket) => socket.deserializeAttachment()?.xuid === "101")!;
      const attachment = ws.deserializeAttachment();
      delete attachment.lastSeen;
      ws.serializeAttachment(attachment);
      instance = new Hub(state, env);
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(before + SESSION_IDLE_TIMEOUT_MS - 1);
    try {
      expect(instance.onlineCount()).toBe(1);
      clock.mockReturnValue(after + SESSION_IDLE_TIMEOUT_MS);
      expect(instance.onlineCount()).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

it.each(["current", "legacy"])("uses automatic heartbeats across hibernation with a %s attachment", async (format) => {
  const client = await player();
  client.send("ping");
  expect(await client.next()).toEqual({ type: "pong" });
  await runInDurableObject(hub(), (_, state) => {
    const ws = state.getWebSockets().find((socket) => socket.deserializeAttachment()?.xuid === "101")!;
    const heartbeat = state.getWebSocketAutoResponseTimestamp(ws);
    expect(heartbeat).not.toBeNull();
    const attachment = ws.deserializeAttachment();
    attachment.traffic.startedAt = heartbeat!.getTime() - SESSION_IDLE_TIMEOUT_MS;
    if (format === "legacy") delete attachment.lastSeen;
    else attachment.lastSeen = attachment.traffic.startedAt;
    ws.serializeAttachment(attachment);
    const clock = vi.spyOn(Date, "now").mockReturnValue(heartbeat!.getTime() + SESSION_IDLE_TIMEOUT_MS - 1);
    try {
      expect(new Hub(state, env).onlineCount()).toBe(1);
      clock.mockReturnValue(heartbeat!.getTime() + SESSION_IDLE_TIMEOUT_MS);
      expect(new Hub(state, env).onlineCount()).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

it("keeps recent client traffic online and closes silent sockets during maintenance", async () => {
  const silent = await player();
  const active = await player("101", false);
  await runInDurableObject(hub(), async (instance: Hub, state) => {
    const ws = state.getWebSockets().find((socket) => socket.deserializeAttachment()?.visible === false)!;
    const now = Date.now() + SESSION_IDLE_TIMEOUT_MS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await instance.webSocketMessage(ws, JSON.stringify({ type: "visibility", visible: true }));
      await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 1, xuids: [] }));
      expect(instance.onlineCount()).toBe(1);
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(new Hub(state, env).onlineCount()).toBe(1);
      clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS - 1);
      expect(new Hub(state, env).onlineCount()).toBe(1);
      clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS);
      expect(new Hub(state, env).onlineCount()).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
  expect((await active.next()).type).toBe("lookup_result");
  expect((await silent.closed).code).toBe(1001);
});
