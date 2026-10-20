import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import { Hub } from "../src/hub";
import { connect, hub, installFakeIssuer, login, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => (client.close(), client.closed)));
});

/** Logs in a test account and registers its socket for cleanup. */
async function player(options: Parameters<typeof login>[0] = {}) {
  const { client } = await login(options);
  open.push(client);
  return client;
}

let observation = 0;

/** Reads a fresh aggregate with a distinct edge cache key for each observation. */
async function count() {
  const response = await exports.default.fetch(`https://api.test/v1/presence/count?observation=${++observation}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
  const body = await response.json();
  expect(Object.keys(body as object)).toEqual(["online"]);
  return body;
}

it("returns zero and excludes pending authentication", async () => {
  expect(await count()).toEqual({ online: 0 });
  open.push(await connect());
  expect(await count()).toEqual({ online: 0 });
});

it("deduplicates accounts and follows visibility across hibernation", async () => {
  const shown = await player({ xuid: "101" });
  await player({ xuid: "101" });
  const hidden = await player({ xuid: "102", visible: false });
  expect(await count()).toEqual({ online: 1 });
  hidden.send({ type: "visibility", visible: true });
  await hidden.lookup([]);
  expect(await count()).toEqual({ online: 2 });
  shown.send({ type: "visibility", visible: false });
  await shown.lookup([]);
  expect(await count()).toEqual({ online: 2 });
  hidden.send({ type: "visibility", visible: false });
  await hidden.lookup([]);
  await runInDurableObject(hub(), async (_, state) => {
    expect(new Hub(state, env).onlineCount()).toBe(1);
  });
  expect(await count()).toEqual({ online: 1 });
});

it("excludes disconnected accounts while badge lookups still retain them", async () => {
  const observer = await player({ xuid: "101", visible: false });
  const visible = await player({ xuid: "102" });
  expect(await count()).toEqual({ online: 1 });
  visible.close();
  await visible.closed;
  expect((await observer.lookup(["102"])).cinnabar).toEqual(["102"]);
  expect(await count()).toEqual({ online: 0 });
});

it("does not restore a server-closed account before its close completes", async () => {
  await player({ xuid: "101" });
  await runInDurableObject(hub(), async (instance: Hub, state) => {
    const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === "101")!;
    await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 1, xuids: ["bad"] }));
    expect(instance.onlineCount()).toBe(0);
    expect(new Hub(state, env).onlineCount()).toBe(0);
  });
});
