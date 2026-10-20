import catalogJson from "./catalog.json";
import schema from "../schema/v1.json";
import type { MiddlewareHandler } from "hono";
import { loadCatalog, refreshCatalogOnMiss, type Catalog } from "./catalog-store";

export const catalog = catalogJson;
export type Item = typeof catalog.items[number];
const slots = new Set<string>(schema.$defs.CosmeticSlot["x-known-slots"]);

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
  const body = JSON.stringify(bucket ? await loadCatalog(bucket) : catalog);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const etag = `"${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
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
  /** Finds the immutable descriptor and its delivery headers in an admitted release. */
  const find = (current: Catalog) => [
    ...current.items.flatMap((item) => Object.entries(item.assets).map(([kind, asset]) => ({ kind, asset, license: item.license }))),
    ...current.emotes.map((item) => ({ kind: "clip", asset: item.clip, license: item.license })),
  ].find(({ asset }) => asset.sha256 === hash);
  const current = await loadCatalog(bucket);
  const entry = find(current) ?? find(await refreshCatalogOnMiss(bucket));
  if (!entry) return new Response(null, { status: 404 });
  const object = await bucket.get(hash);
  if (!object || object.size !== entry.asset.bytes) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": entry.kind === "texture" ? "image/png" : "application/json",
    ETag: `"${hash}"`,
    "X-Content-Type-Options": "nosniff", Link: `<${entry.license}>; rel="license"`,
  } });
}
