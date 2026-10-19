import { beforeAll, afterEach, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { catalog } from "../src/cosmetics";
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
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify(release));
  expect(await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true)).toEqual(release);
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, "malformed");
  expect(await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true)).toEqual(catalog);
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify({ ...release, version: 0 }));
  expect(await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true)).toEqual(catalog);
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
  expect(entitlementCommand({ xuid: "Player", item_ids: [paid.id], owned: true })).toBeNull();
  expect(entitlementCommand({ xuid: "1", item_ids: [paid.id], owned: true, admin: true })).toBeNull();
});
