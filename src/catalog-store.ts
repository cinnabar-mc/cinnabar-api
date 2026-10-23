import { Validator, type Schema } from "@cfworker/json-schema";
import fallback from "./catalog.json";
import schema from "../schema/v1.json";

export type Catalog = typeof fallback;
export const CATALOG_KEY = "cosmetics/catalog.json";
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 60_000;
const validator = new Validator({ $ref: `${schema.$id}#/$defs/CosmeticsCatalog` }, "2020-12");
validator.addSchema(schema as unknown as Schema);
type CachedCatalog = { at: number; ttl: number; failures: number; value: Promise<Catalog>; lastGood?: Catalog; missRefreshAt: number };
const cached = new WeakMap<R2Bucket, CachedCatalog>();
const RETRY_MS = 1_000;
const MAX_FAILURES = Math.ceil(Math.log2(TTL_MS / RETRY_MS)) + 1;

/** Shares a bounded R2 read, retaining the original free catalog when the private release is unavailable. */
export function loadCatalog(bucket: R2Bucket, now = Date.now(), force = false): Promise<Catalog> {
  let entry = cached.get(bucket);
  if (force || !entry || now < entry.at || now - entry.at >= entry.ttl) {
    const previousFailures = entry?.failures ?? 0;
    const next: CachedCatalog = { at: now, ttl: TTL_MS, failures: 0, lastGood: entry?.lastGood, missRefreshAt: entry?.missRefreshAt ?? -Infinity, value: Promise.resolve(fallback) };
    next.value = readCatalog(bucket).then((release) => {
      if (release) next.lastGood = release;
      else {
        next.failures = Math.min(previousFailures + 1, MAX_FAILURES);
        next.ttl = Math.min(TTL_MS, RETRY_MS * 2 ** (next.failures - 1));
      }
      return next.lastGood ?? fallback;
    });
    cached.set(bucket, next);
    entry = next;
  }
  return entry.value;
}

/** Revalidates an unknown digest without allowing repeated misses to bypass the read budget. */
export function refreshCatalogOnMiss(bucket: R2Bucket, now = Date.now()): Promise<Catalog> {
  const entry = cached.get(bucket);
  const refresh = !!entry && now - entry.at >= RETRY_MS && now - entry.missRefreshAt >= TTL_MS;
  if (refresh) entry.missRefreshAt = now;
  return loadCatalog(bucket, now, refresh);
}

/** Admits only schema-valid releases; the public metadata fallback requires no private checkout. */
async function readCatalog(bucket: R2Bucket): Promise<Catalog | null> {
  try {
    const object = await bucket.get(CATALOG_KEY);
    if (!object) return null;
    if (object.size > MAX_BYTES) { await object.body.cancel(); return null; }
    const value: unknown = await object.json();
    if (!validator.validate(value).valid) return null;
    const release = value as Catalog;
    if (release.version < fallback.version || new Set(release.items.map((item) => item.id)).size !== release.items.length) return null;
    return { ...release, emotes: release.emotes ?? [] };
  } catch {
    return null;
  }
}
