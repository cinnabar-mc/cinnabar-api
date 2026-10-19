import { Validator, type Schema } from "@cfworker/json-schema";
import fallback from "./catalog.json";
import schema from "../schema/v1.json";

export type Catalog = typeof fallback;
export const CATALOG_KEY = "cosmetics/catalog.json";
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 60_000;
const validator = new Validator({ $ref: `${schema.$id}#/$defs/CosmeticsCatalog` }, "2020-12");
validator.addSchema(schema as unknown as Schema);
const cached = new WeakMap<R2Bucket, { at: number; value: Promise<Catalog> }>();

/** Shares a bounded R2 read, retaining the original free catalog when the private release is unavailable. */
export function loadCatalog(bucket: R2Bucket, now = Date.now(), force = false): Promise<Catalog> {
  let entry = cached.get(bucket);
  if (force || !entry || now < entry.at || now - entry.at >= TTL_MS) {
    entry = { at: now, value: readCatalog(bucket) };
    cached.set(bucket, entry);
  }
  return entry.value;
}

/** Admits only schema-valid releases; the public metadata fallback requires no private checkout. */
async function readCatalog(bucket: R2Bucket): Promise<Catalog> {
  try {
    const object = await bucket.get(CATALOG_KEY);
    if (!object || object.size > MAX_BYTES) return fallback;
    const value: unknown = await object.json();
    if (!validator.validate(value).valid) return fallback;
    const release = value as Catalog;
    if (release.version < fallback.version || new Set(release.items.map((item) => item.id)).size !== release.items.length) return fallback;
    return { ...release, emotes: release.emotes ?? [] };
  } catch {
    return fallback;
  }
}
