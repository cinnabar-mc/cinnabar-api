import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Hub } from "../src/hub";
import { clientKey, connect, hello, hub, installFakeIssuer, login, mintToken, sign, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
beforeEach(() => runInDurableObject(hub(), (_: Hub, state) => {
  state.storage.sql.exec("DELETE FROM unique_users");
}));
afterEach(() => Promise.all(open.splice(0).map(client => (client.close(), client.closed))));

/** Authenticates a verified account and registers its socket for cleanup. */
async function player(xuid: string, visible = true): Promise<Client> {
  const { client } = await login({ xuid, visible });
  open.push(client);
  return client;
}

it("publishes only the anonymous total with CORS and a bounded cache lifetime", async () => {
  await player("101");
  const response = await exports.default.fetch("https://api.test/v1/users/count");
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
  expect(await response.json()).toEqual({ unique: 1 });
});

it("starts at zero and excludes pending and rejected authentication", async () => {
  expect(await hub().uniqueUserCount()).toBe(0);
  const key = await clientKey();
  const client = await connect();
  open.push(client);
  client.send(hello(await mintToken({ cpk: key.cpk, xid: "101" })));
  const challenge = await client.next();
  expect(challenge.type).toBe("challenge");
  expect(await hub().uniqueUserCount()).toBe(0);
  client.send({ type: "proof", signature: await sign(await clientKey(), challenge.nonce as string) });
  expect((await client.next()).type).toBe("error");
  await client.closed;
  expect(await hub().uniqueUserCount()).toBe(0);
});

it("deduplicates devices and reconnects, including visibility-off accounts", async () => {
  const first = await player("101");
  await player("101");
  const hidden = await player("102", false);
  expect(await hub().uniqueUserCount()).toBe(2);
  expect(await hub().onlineCount()).toBe(1);
  first.close();
  await first.closed;
  await player("101");
  hidden.send({ type: "visibility", visible: true });
  await hidden.lookup([]);
  expect(await hub().uniqueUserCount()).toBe(2);
});

it("retains the total and deduplication after disconnects and object eviction", async () => {
  const client = await player("101");
  client.close();
  await client.closed;
  await evictDurableObject(hub());
  expect(await hub().uniqueUserCount()).toBe(1);
  await player("101");
  await player("102");
  expect(await hub().uniqueUserCount()).toBe(2);
});

it("stores only salted digests, without account names or raw identifiers", async () => {
  await player("2535412345678901");
  await runInDurableObject(hub(), (_: Hub, state) => {
    const rows = state.storage.sql.exec("SELECT * FROM unique_users").toArray();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toEqual(["digest"]);
    expect(rows[0]!.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(rows)).not.toContain("2535412345678901");
  });
});
