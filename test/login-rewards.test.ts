import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { catalog } from "../src/cosmetics";
import { CATALOG_KEY, loadCatalog } from "../src/catalog-store";
import { loginRewardCommand } from "../src/cosmetics-admin";
import { LOGIN_REWARD_DURATION_MS, LoginRewards } from "../src/login-rewards";
import { SESSION_IDLE_TIMEOUT_MS } from "../src/protocol";
import { connect, hub, installFakeIssuer, login, type Client } from "./helpers";

let rewardItem = { ...catalog.items[0]!, id: "fixture:login-reward", free: false };
let release = { ...catalog, version: catalog.version + 1, items: [...catalog.items, rewardItem] };
const clients: Client[] = [];
beforeAll(installFakeIssuer);
beforeEach(() => {
  rewardItem = { ...rewardItem, id: "fixture:login-" + crypto.randomUUID() };
  release = { ...catalog, version: catalog.version + 1, items: [...catalog.items, rewardItem] };
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => (client.close(), client.closed)));
  await env.COSMETIC_ASSETS.delete(CATALOG_KEY);
  await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
});

/** Publishes only synthetic metadata so the public tests never require private artwork. */
async function publish(): Promise<void> {
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify(release));
  await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
}

it("starts only for a published restricted item and retains its deadline across retries and wake", async () => {
  expect(await hub().startLoginReward(rewardItem.id)).toBeNull();
  await publish();
  expect(await hub().startLoginReward(catalog.items[0]!.id)).toBeNull();
  const first = (await hub().startLoginReward(rewardItem.id))!;
  expect(first.ends_at - first.starts_at).toBe(LOGIN_REWARD_DURATION_MS);
  await runInDurableObject(hub(), async (_instance, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(first.ends_at + LOGIN_REWARD_DURATION_MS);
    try { expect(await new Hub(state, env).startLoginReward(rewardItem.id)).toEqual(first); }
    finally { clock.mockRestore(); }
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_rewards WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(1);
  });
});

it("includes the start, excludes the exact end, and preserves grants after expiry", async () => {
  await runInDurableObject(hub(), (_instance, state) => {
    const rewards = new LoginRewards(state.storage);
    const window = rewards.start(rewardItem.id, 1_000);
    const claim = (xuid: string, now: number) => state.storage.transactionSync(() => rewards.claim(xuid, now));
    expect(claim("1", window.starts_at - 1)).toBe(false);
    expect(claim("2", window.starts_at)).toBe(true);
    expect(claim("3", window.ends_at - 1)).toBe(true);
    expect(claim("4", window.ends_at)).toBe(false);
    expect(claim("5", window.ends_at + 1)).toBe(false);
    expect(new LoginRewards(state.storage).claim("6", window.ends_at + 1)).toBe(false);
    expect(state.storage.sql.exec("SELECT xuid FROM cosmetic_entitlements WHERE item_id = ? ORDER BY xuid", rewardItem.id).toArray())
      .toEqual([{ xuid: "2" }, { xuid: "3" }]);
  });
});

it("grants during verified sign-in before welcome, including invisible accounts, and persists on reconnect", async () => {
  await publish();
  await hub().startLoginReward(rewardItem.id);
  for (const visible of [true, false]) {
    const xuid = visible ? "101" : "102";
    const first = await login({ xuid, visible }); clients.push(first.client);
    expect(first.welcome.owned_cosmetics).toContain(rewardItem.id);
    first.client.close(); await first.client.closed;
    const second = await login({ xuid, visible }); clients.push(second.client);
    expect(second.welcome.owned_cosmetics).toEqual(first.welcome.owned_cosmetics);
  }
  await runInDurableObject(hub(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_reward_claims WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(2);
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_entitlements WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(2);
  });
});

it("includes fresh accounts already connected at activation while excluding unauthenticated and stale sockets", async () => {
  await publish();
  const stale = await login({ xuid: "201" }); clients.push(stale.client);
  const open = await connect(); clients.push(open);
  const active = await login({ xuid: "202", visible: false }); clients.push(active.client);
  await runInDurableObject(hub(), (_instance, state) => {
    const ws = state.getWebSockets().find((socket) => socket.deserializeAttachment()?.xuid === "201")!;
    const attachment = ws.deserializeAttachment();
    attachment.lastSeen = Date.now() - SESSION_IDLE_TIMEOUT_MS - 1;
    attachment.traffic.startedAt = attachment.lastSeen;
    ws.serializeAttachment(attachment);
  });
  await runInDurableObject(hub(), async (_instance, state) => {
    await new Hub(state, env).startLoginReward(rewardItem.id);
    expect(state.storage.sql.exec("SELECT xuid FROM cosmetic_entitlements WHERE item_id = ?", rewardItem.id).toArray()).toEqual([{ xuid: "202" }]);
  });
  expect(await active.client.next()).toEqual({ type: "cosmetic_ownership", owned_cosmetics: expect.arrayContaining([rewardItem.id]) });
});

it("does not let a claim ledger bypass an explicit revocation during the active week", async () => {
  await publish(); await hub().startLoginReward(rewardItem.id);
  const first = await login({ xuid: "301" }); clients.push(first.client);
  expect(first.welcome.owned_cosmetics).toContain(rewardItem.id);
  const remaining = (first.welcome.owned_cosmetics as string[]).filter((id) => id !== rewardItem.id);
  await hub().setCosmeticEntitlements("301", [rewardItem.id], false);
  expect(await first.client.next()).toEqual({ type: "cosmetic_ownership", owned_cosmetics: remaining });
  first.client.close(); await first.client.closed;
  const second = await login({ xuid: "301" }); clients.push(second.client);
  expect(second.welcome.owned_cosmetics).toEqual(remaining);
});

it("retries a claim after transaction rollback without losing the permanent grant", async () => {
  await runInDurableObject(hub(), (_instance, state) => {
    const rewards = new LoginRewards(state.storage); rewards.start(rewardItem.id, 1_000);
    expect(() => state.storage.transactionSync(() => {
      expect(rewards.claim("401", 1_000)).toBe(true);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_entitlements WHERE item_id = ?", rewardItem.id).toArray()).toEqual([]);
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_reward_claims WHERE item_id = ?", rewardItem.id).toArray()).toEqual([]);
    expect(state.storage.transactionSync(() => rewards.claim("401", 1_000))).toBe(true);
  });
});

it("keeps granting an activated reward when a later metadata fallback omits the item", async () => {
  await publish(); await hub().startLoginReward(rewardItem.id);
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify({ ...catalog, version: release.version + 1 }));
  await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
  const joined = await login({ xuid: "501" }); clients.push(joined.client);
  expect(joined.welcome.owned_cosmetics).toContain(rewardItem.id);
});

it("requires administrative authentication and accepts no client-selected duration or account", async () => {
  for (const [method, authorization] of [
    ["POST", undefined], ["POST", "Bearer forged"], ["DELETE", undefined], ["DELETE", "Bearer forged"],
  ]) {
    const response = await exports.default.fetch("https://api.test/v1/cosmetics/login-rewards", {
      method, headers: authorization ? { Authorization: authorization } : undefined,
      body: JSON.stringify({ item_id: rewardItem.id }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(loginRewardCommand({ item_id: rewardItem.id })).toEqual({ item_id: rewardItem.id });
  for (const value of [null, [], {}, { item_id: "invalid" }, { item_id: rewardItem.id, ends_at: 1 },
    { item_id: rewardItem.id, xuid: "1" }, { item_id: rewardItem.id, duration_days: 8 }]) {
    expect(loginRewardCommand(value)).toBeNull();
  }
});

it("stops claims, revokes only the selected item, refreshes live ownership and permits a later fresh window", async () => {
  const other = { ...rewardItem, id: "fixture:retained-" + crypto.randomUUID() };
  release.items.push(other);
  await publish(); await hub().startLoginReward(rewardItem.id);
  await hub().setCosmeticEntitlements("601", [other.id], true);
  const first = await login({ xuid: "601", visible: false }); clients.push(first.client);
  expect(first.welcome.owned_cosmetics).toContain(rewardItem.id);
  expect(await hub().stopLoginReward(rewardItem.id)).toEqual({ item_id: rewardItem.id, revoked_accounts: 1 });
  const remaining = (first.welcome.owned_cosmetics as string[]).filter((id) => id !== rewardItem.id);
  expect(await first.client.next()).toEqual({ type: "cosmetic_ownership", owned_cosmetics: remaining });
  expect(await hub().stopLoginReward(rewardItem.id)).toEqual({ item_id: rewardItem.id, revoked_accounts: 0 });
  first.client.close(); await first.client.closed;
  const second = await login({ xuid: "601" }); clients.push(second.client);
  expect(second.welcome.owned_cosmetics).toEqual(remaining);
  const fresh = await login({ xuid: "602" }); clients.push(fresh.client);
  expect(fresh.welcome.owned_cosmetics).not.toContain(rewardItem.id);
  await runInDurableObject(hub(), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_rewards WHERE item_id = ?", rewardItem.id).toArray()).toEqual([]);
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_reward_claims WHERE item_id = ?", rewardItem.id).toArray()).toEqual([]);
    new LoginRewards(state.storage).claim("603", Date.now());
    expect(state.storage.sql.exec("SELECT * FROM cosmetic_entitlements WHERE xuid = ? AND item_id = ?", "603", rewardItem.id).toArray()).toEqual([]);
  });
  const restarted = await hub().startLoginReward(rewardItem.id);
  expect(restarted!.ends_at - restarted!.starts_at).toBe(LOGIN_REWARD_DURATION_MS);
  expect(await second.client.next()).toEqual({ type: "cosmetic_ownership", owned_cosmetics: expect.arrayContaining([other.id, rewardItem.id]) });
});

it("does not disable the in-memory window when the revocation transaction rolls back", async () => {
  await runInDurableObject(hub(), (_instance, state) => {
    const rewards = new LoginRewards(state.storage);
    rewards.start(rewardItem.id, 1_000);
    expect(rewards.claim("701", 1_000)).toBe(true);
    state.storage.sql.exec(`CREATE TRIGGER reject_reward_revoke BEFORE DELETE ON cosmetic_entitlements
      BEGIN SELECT RAISE(ABORT, 'reject revocation'); END`);
    try {
      expect(() => rewards.stop(rewardItem.id)).toThrow();
      expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_rewards WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM cosmetic_login_reward_claims WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM cosmetic_entitlements WHERE item_id = ?", rewardItem.id).toArray()).toHaveLength(1);
      expect(rewards.claim("702", 1_000)).toBe(true);
    } finally { state.storage.sql.exec("DROP TRIGGER reject_reward_revoke"); }
  });
});
