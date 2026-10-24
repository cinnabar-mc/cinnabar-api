import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CATALOG_KEY, loadCatalog } from "../src/catalog-store";
import { assetResponse, catalog } from "../src/cosmetics";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("shares public responses across irrelevant parameters and authorization headers", async () => {
  const edge = await caches.open("cinnabar-api-v1");
  vi.spyOn(caches, "open").mockResolvedValue(edge);
  const get = vi.spyOn(env.HUB, "get");
  const origin = `https://${crypto.randomUUID()}.api.test`;
  for (const [suffix, headers] of [
    ["", undefined], ["?unused=one", undefined], ["?unused=two", undefined],
    ["", { Authorization: "Bearer arbitrary" }], ["", { Authorization: "Bearer another" }],
  ] as const) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${origin}/v1/presence/count${suffix}`, { headers }), env, ctx);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await waitOnExecutionContext(ctx);
  }
  expect(get).toHaveBeenCalledTimes(1);
});

it("bounds catalog refreshes across different unknown asset hashes", async () => {
  const get = vi.fn().mockResolvedValue({ size: 1, json: async () => catalog });
  const bucket = { get } as unknown as R2Bucket;
  await loadCatalog(bucket, 0);
  const clock = vi.spyOn(Date, "now");
  for (let second = 2; second < 30; second++) {
    clock.mockReturnValue(second * 1000);
    expect((await assetResponse(second.toString(16).padStart(64, "0"), bucket)).status).toBe(404);
  }
  expect(get.mock.calls.filter(([key]) => key === CATALOG_KEY).length).toBeLessThanOrEqual(2);
});

it("backs off persistently unavailable catalogs instead of restarting a retry burst", async () => {
  const get = vi.fn().mockRejectedValue(new Error("R2 unavailable"));
  const bucket = { get } as unknown as R2Bucket;
  for (let second = 0; second < 240; second++) await loadCatalog(bucket, second * 1000);
  expect(get.mock.calls.length).toBeLessThanOrEqual(10);
});

it("reuses paid ownership across recipients and revisions while applying revocation", async () => {
  installFakeIssuer();
  const clients: Client[] = [];
  const paid = { ...catalog.items[0]!, id: "fixture:cached-paid", free: false };
  const owner = "999900001", peers = ["999900002", "999900003"];
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify({ ...catalog, version: catalog.version + 1, items: [...catalog.items, paid] }));
  await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
  try {
    await hub().setCosmeticEntitlements(owner, [paid.id], true);
    for (const xuid of [owner, ...peers]) {
      const { client } = await login({ xuid });
      clients.push(client);
      client.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: xuid === owner ? peers : [owner] });
      await client.lookup([]);
    }
    await runInDurableObject(hub(), async (instance, state) => {
      const socket = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === owner)!;
      const exec = vi.spyOn(state.storage.sql, "exec");
      try {
        for (const revision of [1, 2]) {
          await instance.webSocketMessage(socket, JSON.stringify({ type: "loadout", revision, slots: { head: paid.id } }));
        }
        expect(exec.mock.calls.filter(([sql]) => sql.includes("FROM cosmetic_entitlements"))).toHaveLength(0);
      } finally {
        exec.mockRestore();
      }
      await instance.setCosmeticEntitlements(owner, [paid.id], false);
      await instance.webSocketMessage(socket, JSON.stringify({ type: "loadout", revision: 3, slots: { head: paid.id } }));
      expect(socket.deserializeAttachment().loadout.revision).toBe(2);
    });
  } finally {
    await Promise.all(clients.map((client) => (client.close(), client.closed)));
    await env.COSMETIC_ASSETS.delete(CATALOG_KEY);
    await loadCatalog(env.COSMETIC_ASSETS, Date.now(), true);
  }
});
