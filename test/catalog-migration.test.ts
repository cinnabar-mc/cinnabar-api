import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { assetResponse, catalog } from "../src/cosmetics";
import { Hub } from "../src/hub";
import { CATALOG_KEY, loadCatalog } from "../src/catalog-store";
import { authorizePublisher, COSMETICS_ADMIN_AUDIENCE, entitlementCommand } from "../src/cosmetics-admin";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const paid = { ...catalog.items[0]!, id: "fixture:paid", free: false };
const release = { ...catalog, version: catalog.version + 1, items: [...catalog.items, paid] };
const clients: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => (client.close(), client.closed)));
  await env.COSMETIC_ASSETS.delete(CATALOG_KEY);
  await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
});

it("uses R2 catalog metadata and falls back without removing existing free cosmetics", async () => {
  const get = vi.fn().mockResolvedValue(null);
  const bucket = { get } as unknown as R2Bucket;
  expect(await loadCatalog(bucket, 0)).toEqual(catalog);
  get.mockResolvedValue({ size: 1, json: async () => release });
  expect(await loadCatalog(bucket, 1_000)).toEqual(release);
  get.mockRejectedValue(new Error("temporary outage"));
  expect(await loadCatalog(bucket, 61_000)).toEqual(release);
  get.mockResolvedValue({ size: 1, json: async () => ({ ...release, version: release.version + 1 }) });
  expect((await loadCatalog(bucket, 62_000)).version).toBe(release.version + 1);
  get.mockResolvedValue({ size: 1, json: async () => ({ ...release, version: 0 }) });
  expect((await loadCatalog(bucket, 122_000)).version).toBe(release.version + 1);
});

it("revalidates an older isolate catalog before rejecting a newly promoted digest", async () => {
  const bytes = new TextEncoder().encode("fixture").buffer;
  const hash = "a".repeat(64);
  const next = { ...release, items: [...release.items, { ...paid, id: "fixture:new", assets: {
    ...paid.assets, geometry: { ...paid.assets.geometry, sha256: hash, bytes: bytes.byteLength },
  } }] };
  const get = vi.fn(async (key: string) => key === CATALOG_KEY
    ? { size: 1, json: async () => next }
    : { size: bytes.byteLength, body: new Response(new Uint8Array(bytes)).body });
  const bucket = { get } as unknown as R2Bucket;
  get.mockResolvedValueOnce({ size: 1, json: async () => catalog } as never);
  await loadCatalog(bucket, Date.now() - 2_000);
  expect((await assetResponse(hash, bucket)).status).toBe(200);
  expect(get.mock.calls.filter(([key]) => key === CATALOG_KEY)).toHaveLength(2);
  expect((await assetResponse("b".repeat(64), bucket)).status).toBe(404);
  expect(get.mock.calls.filter(([key]) => key === CATALOG_KEY)).toHaveLength(2);
});

it("reports database ownership even when an item is absent from fallback metadata", async () => {
  const owner = "2535400000090003", id = "fixture:capes/unavailable";
  await runInDurableObject(hub(), async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO cosmetic_entitlements (xuid, item_id) VALUES (?, ?)", owner, id);
  });
  const a = await login({ xuid: owner }); clients.push(a.client);
  expect(a.welcome.owned_cosmetics).toEqual([id]);
});

it.each(["close", "error"] as const)("replays paid selections after a hibernated socket %s", async (event) => {
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify(release));
  const owner = "2535400000090004", observer = "2535400000090005";
  await hub().setCosmeticEntitlements(owner, [paid.id], true);
  const a = await login({ xuid: owner }), a2 = await login({ xuid: owner }), b = await login({ xuid: observer });
  clients.push(a.client, a2.client, b.client);
  for (const client of [a.client, a2.client]) {
    client.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [observer] });
    await client.lookup([], 1);
  }
  a.client.send({ type: "loadout", revision: 3, slots: { head: paid.id } });
  await a.client.lookup([], 2);
  b.client.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [owner] });
  expect(await b.client.next()).toMatchObject({ type: "loadout", slots: { head: paid.id } });
  await runInDurableObject(hub(), async (_instance, state) => {
    const publisher = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === owner)!;
    const closing = vi.spyOn(publisher, "readyState", "get").mockReturnValue(WebSocket.CLOSING);
    try {
      const rebuilt = new Hub(state, env);
      if (event === "close") await rebuilt.webSocketClose(publisher, 1000, "");
      else await rebuilt.webSocketError(publisher);
    } finally { closing.mockRestore(); }
  });
  expect(await b.client.next()).toMatchObject({ type: "loadout", revision: 3, slots: { head: paid.id } });
});

it("persists idempotent grants in SQL, isolates accounts, and revokes connected ownership", async () => {
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify(release));
  const owner = "2535400000090001", other = "2535400000090002";
  expect(await hub().setCosmeticEntitlements(owner, [paid.id], true)).toEqual([paid.id]);
  expect(await hub().setCosmeticEntitlements(owner, [paid.id], true)).toEqual([paid.id]);
  const a = await login({ xuid: owner }); clients.push(a.client);
  const b = await login({ xuid: other }); clients.push(b.client);
  expect(a.welcome.owned_cosmetics).toEqual([paid.id]);
  expect(b.welcome.owned_cosmetics).toEqual([]);
  b.client.send({ type: "loadout", revision: 1, slots: { head: paid.id } });
  expect(await b.client.next()).toEqual({ type: "error", code: "invalid_loadout" });
  a.client.send({ type: "loadout", revision: 1, slots: { head: paid.id } });
  expect(await a.client.lookup([], 1)).toMatchObject({ type: "lookup_result" });
  await runInDurableObject(hub(), async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_entitlements WHERE xuid = ?", owner).toArray()).toHaveLength(1);
  });
  expect(await hub().setCosmeticEntitlements(owner, [paid.id], false)).toEqual([]);
  expect(await a.client.next()).toEqual({ type: "cosmetic_ownership", owned_cosmetics: [] });
  a.client.send({ type: "loadout", revision: 2, slots: { head: paid.id } });
  expect(await a.client.next()).toEqual({ type: "error", code: "invalid_loadout" });
  expect(await hub().setCosmeticEntitlements(owner, [catalog.items[0]!.id], true)).toBeNull();
});

it("authenticates only the signed private administration workflow on main", async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), alg: "RS256", kid: "fixture" };
  const verifier = createLocalJWKSet({ keys: [jwk] });
  const claims = { repository_id: env.COSMETICS_REPOSITORY_ID, repository_visibility: "private",
    ref: "refs/heads/main", event_name: "workflow_dispatch", workflow_ref: env.COSMETICS_ADMIN_WORKFLOW };
  /** Signs synthetic workflow claims with a local issuer key. */
  const token = (overrides = {}, audience = COSMETICS_ADMIN_AUDIENCE) => new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(audience).setIssuedAt().setNotBefore("0s").setExpirationTime("5m").sign(pair.privateKey);
  expect(await authorizePublisher(`Bearer ${await token()}`, env, verifier)).toBe(true);
  for (const change of [{ repository_id: "other" }, { ref: "refs/pull/1/merge" },
    { repository_visibility: "public" }, { workflow_ref: "other" }, { event_name: "pull_request" }]) {
    expect(await authorizePublisher(`Bearer ${await token(change)}`, env, verifier)).toBe(false);
  }
  expect(await authorizePublisher(`Bearer ${await token({}, "wrong")}`, env, verifier)).toBe(false);
  expect(await authorizePublisher("Bearer forged", env, verifier)).toBe(false);
});

it("rejects account names, unbounded commands and unknown fields", () => {
  expect(entitlementCommand({ xuid: "1", item_ids: [paid.id, paid.id], owned: true })).toEqual({ xuid: "1", item_ids: [paid.id], owned: true });
  expect(entitlementCommand({ xuid: "1", item_ids: ["fixture:capes/paid"], owned: true })?.item_ids).toEqual(["fixture:capes/paid"]);
  for (const id of ["fixture", ":paid", "fixture:", "fix/ture:paid", "fixture:paid:extra"]) {
    expect(entitlementCommand({ xuid: "1", item_ids: [id], owned: true })).toBeNull();
  }
  expect(entitlementCommand({ xuid: "Player", item_ids: [paid.id], owned: true })).toBeNull();
  expect(entitlementCommand({ xuid: "1", item_ids: [paid.id], owned: true, admin: true })).toBeNull();
});
