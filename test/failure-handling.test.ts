import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { connect, hub, installFakeIssuer, login, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

describe("session failures", () => {
  it("closes and removes a session even when persisting its departure budget fails", async () => {
    const { client } = await login();
    open.push(client);
    await client.lookup(["999900001"]);
    await runInDurableObject(hub(), async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const exec = vi.spyOn(state.storage.sql, "exec").mockImplementation(() => { throw new Error("SQL quota exhausted"); });
      try {
        await expect(instance.webSocketClose(ws, 1000, "")).rejects.toThrow("SQL quota exhausted");
        expect(ws.readyState).not.toBe(WebSocket.OPEN);
        expect(instance.onlineCount()).toBe(0);
      } finally { exec.mockRestore(); }
    });
    expect((await client.closed).code).toBe(1000);
  });

  it("forgets and closes a session when its attachment update fails", async () => {
    const { client } = await login();
    open.push(client);
    await runInDurableObject(hub(), async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const serialize = vi.spyOn(ws, "serializeAttachment").mockImplementation(() => {
        throw new Error("attachment unavailable");
      });
      try {
        await instance.webSocketMessage(ws, '{"type":"lookup","id":1,"xuids":[]}');
        expect(ws.readyState).not.toBe(WebSocket.OPEN);
      } finally {
        serialize.mockRestore();
        ws.close(1000);
      }
    });
    expect((await client.closed).code).toBe(1011);
  });

  it("keeps closing a socket when writing its closed marker fails", async () => {
    const client = await connect();
    open.push(client);
    await runInDurableObject(hub(), async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      const serialize = vi.spyOn(ws, "serializeAttachment").mockImplementation(() => {
        throw new Error("attachment unavailable");
      });
      try {
        await instance.webSocketClose(ws, 1000, "");
        expect(ws.readyState).not.toBe(WebSocket.OPEN);
      } finally {
        serialize.mockRestore();
      }
    });
    expect((await client.closed).code).toBe(1000);
  });

  it("closes an accepted handshake on alarm failure and retries scheduling on the next admission", async () => {
    await runInDurableObject(hub(), async (_, state) => {
      await state.storage.deleteAlarm();
      const instance = new Hub(state, env);
      const setAlarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm unavailable"));
      const request = new Request("https://api.test/v1/connect", { headers: { Upgrade: "websocket" } });
      try {
        const refused = await instance.fetch(request);
        expect(refused.status).toBe(101);
        refused.webSocket!.accept();
        refused.webSocket!.close(1000);
        expect(state.getWebSockets().every((ws) => ws.readyState !== WebSocket.OPEN)).toBe(true);
        const accepted = await instance.fetch(request);
        expect(accepted.status).toBe(101);
        accepted.webSocket!.accept();
        accepted.webSocket!.close(1000);
        expect(setAlarm).toHaveBeenCalledTimes(2);
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        setAlarm.mockRestore();
        for (const ws of state.getWebSockets()) ws.close(1000);
      }
    });
  });
});
