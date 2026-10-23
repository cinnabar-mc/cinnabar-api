import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CATALOG_KEY, loadCatalog } from "../src/catalog-store";
import { catalog } from "../src/cosmetics";

const asset = catalog.items[0]!.assets.texture;
let edge: Cache;
let origin: string;

beforeEach(async () => {
  origin = `https://${crypto.randomUUID()}.api.test`;
  edge = await caches.open("cinnabar-api-v1");
  vi.spyOn(caches, "open").mockResolvedValue(edge);
  await env.COSMETIC_ASSETS.delete(asset.sha256);
  await env.COSMETIC_ASSETS.put(CATALOG_KEY, JSON.stringify(catalog));
  // Expire the metadata cache so an HTTP miss must read R2 in these tests.
  await loadCatalog(env.COSMETIC_ASSETS, Date.now() - 60_000, true);
});
afterEach(() => vi.restoreAllMocks());

/** Sends a request through the real Worker and waits for any background cache writes. */
async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

it.each([
  ["/v1/health", "public, max-age=60", false, false],
  ["/v1/presence/count", "public, max-age=30", true, false],
  ["/v1/presence/history?range=24h", "public, max-age=60", false, false],
  ["/v1/presence/history?range=7d", "public, max-age=60", false, false],
  ["/v1/presence/history?range=30d", "public, max-age=60", false, false],
  ["/v1/cosmetics/catalog", "public, max-age=300", false, true],
  [asset.url, "public, max-age=31536000, immutable", false, true],
])("caches %s at the edge without another Hub or R2 call", async (path, policy, usesHub, usesR2) => {
  await env.COSMETIC_ASSETS.put(asset.sha256, new Uint8Array(asset.bytes).fill(42));
  const hub = vi.spyOn(env.HUB, "get");
  const r2 = vi.spyOn(env.COSMETIC_ASSETS, "get");
  const put = vi.spyOn(edge, "put");

  const first = await request(path);
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe(policy);
  const bytes = await first.arrayBuffer();
  const hubReads = hub.mock.calls.length, r2Reads = r2.mock.calls.length;
  expect(hubReads > 0).toBe(usesHub);
  expect(r2Reads > 0).toBe(usesR2);
  expect(put).toHaveBeenCalledTimes(1);
  const key = put.mock.calls[0]![0];
  expect((await edge.match(key))?.headers.get("Cache-Control")).toBe(policy);

  const second = await request(path);
  expect(second.status).toBe(200);
  expect(second.headers.get("Cache-Control")).toBe(policy);
  expect(await second.arrayBuffer()).toEqual(bytes);
  expect(hub).toHaveBeenCalledTimes(hubReads);
  expect(r2).toHaveBeenCalledTimes(r2Reads);
  expect(put).toHaveBeenCalledTimes(1);
});

it.each(["/v1/presence/count", "/v1/presence/history?range=24h"])("reads fresh Hub state after edge eviction of %s", async (path) => {
  const hub = vi.spyOn(env.HUB, "get");
  const put = vi.spyOn(edge, "put");
  await (await request(path)).text();
  await edge.delete(put.mock.calls[0]![0]);
  await (await request(path)).text();
  expect(hub).toHaveBeenCalledTimes(path.includes("history") ? 0 : 2);
});

it("streams assets from R2 again after edge eviction", async () => {
  const original = new Uint8Array(asset.bytes).fill(42);
  await env.COSMETIC_ASSETS.put(asset.sha256, original);
  const r2 = vi.spyOn(env.COSMETIC_ASSETS, "get");
  const put = vi.spyOn(edge, "put");
  expect(await (await request(asset.url)).arrayBuffer()).toEqual(original.buffer);
  await edge.delete(put.mock.calls[0]![0]);
  expect(await (await request(asset.url)).arrayBuffer()).toEqual(original.buffer);
  expect(r2.mock.calls.filter(([key]) => key === asset.sha256)).toHaveLength(2);
});

it("keeps history ranges in distinct cache entries", async () => {
  const r2 = vi.spyOn(env.API_CACHE, "get");
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const range of ["24h", "7d", "30d"]) {
      expect(await (await request(`/v1/presence/history?range=${range}`)).json()).toMatchObject({ range });
    }
  }
  expect(r2).toHaveBeenCalledTimes(3);
});

it.each([["24h", "30d"], ["30d", "24h"]])("keeps encoded duplicate range %s separate from literal range %s", async (encoded, literal) => {
  const r2 = vi.spyOn(env.API_CACHE, "get");
  expect(await (await request(`/v1/presence/history?%72ange=${encoded}&range=${literal}`)).json())
    .toMatchObject({ range: literal });
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const range of [encoded, literal]) {
      expect(await (await request(`/v1/presence/history?range=${range}`)).json()).toMatchObject({ range });
    }
  }
  expect(r2).toHaveBeenCalledTimes(2);
});

it("revalidates cached catalogs without reading R2 or replacing the full cached response", async () => {
  const r2 = vi.spyOn(env.COSMETIC_ASSETS, "get");
  const put = vi.spyOn(edge, "put");
  const first = await request("/v1/cosmetics/catalog");
  const etag = first.headers.get("ETag")!;
  expect(await first.json()).toEqual(catalog);
  for (const condition of [etag, `W/${etag}`, `"older", W/${etag}`, "*"]) {
    const response = await request("/v1/cosmetics/catalog", { headers: { "If-None-Match": condition } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  }
  const stale = await request("/v1/cosmetics/catalog", { headers: { "If-None-Match": '"older"' } });
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual(catalog);
  expect(await (await request("/v1/cosmetics/catalog")).json()).toEqual(catalog);
  expect(r2).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
});

it("fills the catalog cache even when the first request is conditional", async () => {
  const first = await request("/v1/cosmetics/catalog", { headers: { "If-None-Match": "*" } });
  expect(first.status).toBe(304);
  const r2 = vi.spyOn(env.COSMETIC_ASSETS, "get");
  const full = await request("/v1/cosmetics/catalog");
  expect(full.status).toBe(200);
  expect(full.headers.get("ETag")).toBe(first.headers.get("ETag"));
  expect(await full.json()).toEqual(catalog);
  expect(r2).not.toHaveBeenCalled();
});

it("does not cache errors or retain an asset miss after it is published", async () => {
  const put = vi.spyOn(edge, "put");
  for (const path of ["/v1/presence/history?range=invalid", "/v1/cosmetics/assets/invalid", asset.url]) {
    const response = await request(path);
    expect(response.status).toBe(path.includes("history") ? 400 : 404);
    expect(response.headers.get("Cache-Control")).toBeNull();
  }
  expect(put).not.toHaveBeenCalled();
  await env.COSMETIC_ASSETS.put(asset.sha256, new Uint8Array(asset.bytes));
  expect((await request(asset.url)).status).toBe(200);
});

it("reuses anonymous responses when Authorization is present", async () => {
  const hub = vi.spyOn(env.HUB, "get");
  const put = vi.spyOn(edge, "put");
  await (await request("/v1/presence/count")).text();
  for (let repeat = 0; repeat < 2; repeat++) {
    await (await request("/v1/presence/count", { headers: { Authorization: "Bearer fixture" } })).text();
  }
  expect(hub).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
});

it("never reads or writes the edge cache for the private directory, hooks or connections", async () => {
  const match = vi.spyOn(edge, "match"), put = vi.spyOn(edge, "put");
  const hub = vi.spyOn(env.HUB, "get");
  for (let repeat = 0; repeat < 2; repeat++) {
    const names = await request("/v1/presence/players", { headers: { Authorization: "Bearer test-presence-secret" } });
    expect(names.status).toBe(200);
    expect(names.headers.get("Cache-Control")).toBe("no-store");
    expect(names.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await names.json()).toEqual({ names: [] });
  }
  expect(hub).toHaveBeenCalledTimes(2);
  expect((await request("/v1/presence/players")).status).toBe(401);
  for (const path of ["/v1/releases", "/v1/cosmetics/entitlements"]) {
    expect((await request(path, { method: "POST" })).status).toBe(401);
  }
  expect((await request("/v1/connect")).status).toBe(426);
  expect(match).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("briefly caches unknown digests without retaining misses for known unpublished assets", async () => {
  const hash = "f".repeat(64);
  const get = vi.spyOn(env.COSMETIC_ASSETS, "get");
  for (const suffix of ["", "?unused=one"]) {
    const response = await request(`/v1/cosmetics/assets/${hash}${suffix}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=10");
  }
  expect(get.mock.calls.filter(([key]) => key === CATALOG_KEY)).toHaveLength(1);
});

it.each(["read", "write"])("keeps public responses available during cache %s failures", async (failure) => {
  if (failure === "read") vi.spyOn(caches, "open").mockRejectedValueOnce(new Error("cache unavailable"));
  else vi.spyOn(edge, "put").mockRejectedValueOnce(new Error("cache unavailable"));
  const response = await request("/v1/health");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
  expect(await response.json()).toEqual({ ok: true, api: "v1" });
});
