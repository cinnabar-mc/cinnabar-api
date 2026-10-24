import catalogJson from "./catalog.json";
import schema from "../schema/v1.json";
import type { MiddlewareHandler } from "hono";
import { loadCatalog, refreshCatalogOnMiss, type Catalog } from "./catalog-store";

export const catalog = catalogJson;
export type Item = typeof catalog.items[number];
const slots = new Set<string>(schema.$defs.CosmeticSlot["x-known-slots"]);
type Asset = Item["assets"]["geometry"];
type AssetEntry = { kind: string; asset: Asset; license: string };
const assetIndexes = new WeakMap<Catalog, Map<string, AssetEntry>>();
const catalogBodies = new WeakMap<Catalog, Promise<{ body: string; etag: string }>>();

/** Builds the digest lookup once per admitted release instead of allocating and scanning every descriptor per request. */
function assetsFor(current: Catalog): Map<string, AssetEntry> {
  let entries = assetIndexes.get(current);
  if (!entries) {
    entries = new Map();
    for (const item of current.items) {
      for (const [kind, asset] of Object.entries(item.assets)) {
        if (!entries.has(asset.sha256)) entries.set(asset.sha256, { kind, asset, license: item.license });
      }
    }
    for (const item of current.emotes) {
      if (!entries.has(item.clip.sha256)) entries.set(item.clip.sha256, { kind: "clip", asset: item.clip, license: item.license });
    }
    assetIndexes.set(current, entries);
  }
  return entries;
}

/** Encodes and hashes each immutable catalog value once, sharing only completed JSON metadata between requests. */
async function encodedCatalog(current: Catalog): Promise<{ body: string; etag: string }> {
  let encoded = catalogBodies.get(current);
  if (!encoded) {
    const body = JSON.stringify(current);
    encoded = crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)).then((digest) => ({
      body, etag: `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`,
    }));
    catalogBodies.set(current, encoded);
  }
  return encoded;
}

/** Ignores unsupported content and rejects a whole loadout for wrong-slot or unowned known items. */
export function admitLoadout(
  requested: Record<string, string | null>, owns: (id: string) => boolean, items: readonly Item[] = catalog.items,
): Record<string, string | null> | null {
  const result: Record<string, string | null> = {};
  for (const [slot, id] of Object.entries(requested)) {
    if (!slots.has(slot)) continue;
    if (id === null) { result[slot] = null; continue; }
    const item = items.find((item) => item.id === id);
    if (!item) continue;
    if (item.slot !== slot || (!item.free && !owns(id))) return null;
    result[slot] = id;
  }
  return result;
}

/** Serves a versioned catalog whose ETag binds every item and asset digest. */
export async function catalogResponse(bucket?: R2Bucket): Promise<Response> {
  const { body, etag } = await encodedCatalog(bucket ? await loadCatalog(bucket) : catalog);
  return new Response(body, { headers: { ETag: etag, "Content-Type": "application/json" } });
}

/** Applies conditional GETs after cache lookup, so cold and cached catalog responses share ETag behavior. */
export const revalidateCatalog: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status !== 200) return;
  const etag = c.res.headers.get("ETag");
  const matches = c.req.header("If-None-Match")?.split(",").some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
  if (matches) c.res = new Response(null, { status: 304, headers: c.res.headers });
};

/** Serves only reviewed, catalog-addressed R2 objects; clients verify the declared digest and size. */
export async function assetResponse(hash: string, bucket: R2Bucket): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return new Response(null, { status: 404 });
  const current = await loadCatalog(bucket);
  const entry = assetsFor(current).get(hash) ?? assetsFor(await refreshCatalogOnMiss(bucket)).get(hash);
  if (!entry) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=10" } });
  const object = await bucket.get(hash);
  if (!object) return new Response(null, { status: 404 });
  if (object.size !== entry.asset.bytes) { await object.body.cancel(); return new Response(null, { status: 404 }); }
  return new Response(object.body, { headers: {
    "Content-Type": entry.kind === "texture" ? "image/png" : "application/json",
    ETag: `"${hash}"`,
    "X-Content-Type-Options": "nosniff", Link: `<${entry.license}>; rel="license"`,
  } });
}
