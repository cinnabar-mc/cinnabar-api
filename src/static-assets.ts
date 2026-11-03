/** Canonical asset route; mirrored digests are served there without invoking the Worker. */
export const STATIC_ASSET_PREFIX = "v1/cosmetics/assets/";
/** Mirrored files carry extensions here, so Cloudflare derives each asset's Content-Type. */
export const STATIC_FILE_PREFIX = "cosmetic-files/";
/** Workers static assets refuse larger files, so those stay on the Worker route. */
export const STATIC_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MAX_HEADER_RULES = 100;
const MAX_STATIC_REDIRECTS = 2_000;
const IMMUTABLE = "public, max-age=31536000, immutable";

export interface StaticAsset { sha256: string; bytes: number; kind: string; license: string }

/** Returns each same-origin asset in an untrusted catalog with the kind and license the Worker route would use. */
export function staticAssets(catalog: unknown): StaticAsset[] {
  const value = catalog as { items?: unknown; emotes?: unknown } | null;
  const items = Array.isArray(value?.items) ? value.items : [];
  const emotes = Array.isArray(value?.emotes) ? value.emotes : [];
  const candidates: { kind: string; license: unknown; asset: unknown }[] = [
    ...items.flatMap((item) => {
      const { assets, license } = (item ?? {}) as { assets?: unknown; license?: unknown };
      return Object.entries(assets && typeof assets === "object" ? assets : {}).map(([kind, asset]) => ({ kind, license, asset }));
    }),
    ...emotes.map((emote) => {
      const { clip, license } = (emote ?? {}) as { clip?: unknown; license?: unknown };
      return { kind: "clip", license, asset: clip };
    }),
  ];
  // The Worker route keeps the first descriptor of a shared digest, so the mirror must too.
  const seen = new Set<string>();
  const result: StaticAsset[] = [];
  for (const { kind, license, asset } of candidates) {
    const { url, sha256, bytes } = (asset ?? {}) as { url?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || seen.has(sha256)) continue;
    seen.add(sha256);
    if (url !== `/${STATIC_ASSET_PREFIX}${sha256}`) continue;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > STATIC_ASSET_MAX_BYTES) continue;
    // Licenses become header lines, so only plain https URLs qualify.
    if (typeof license !== "string" || license.length > 1_000 || !/^https:\/\/[!#-;=?-~]+$/.test(license)) continue;
    result.push({ sha256, bytes, kind, license });
  }
  return result;
}

/** Returns the mirrored file path below the static root. */
export function staticFile(asset: StaticAsset): string {
  return `${STATIC_FILE_PREFIX}${asset.sha256}.${asset.kind === "texture" ? "png" : "json"}`;
}

/**
 * Builds `_headers` and `_redirects` for downloaded assets, returning only those that fit Cloudflare's rule limits.
 * One wildcard rule carries the most common license; each other asset needs its own rule.
 */
export function staticRules(assets: readonly StaticAsset[]): { served: StaticAsset[]; headers: string; redirects: string } {
  const candidates = assets.slice(0, MAX_STATIC_REDIRECTS);
  const counts = new Map<string, number>();
  for (const asset of candidates) counts.set(asset.license, (counts.get(asset.license) ?? 0) + 1);
  let common: string | undefined;
  for (const [license, count] of counts) if (common === undefined || count > counts.get(common)!) common = license;
  const exceptions = candidates.filter((asset) => asset.license !== common).slice(0, MAX_HEADER_RULES - 1);
  const served = candidates.filter((asset) => asset.license === common || exceptions.includes(asset));
  const link = (license: string) => `  Link: <${license}>; rel="license"\n`;
  let headers = `/${STATIC_ASSET_PREFIX}*\n  Cache-Control: ${IMMUTABLE}\n  X-Content-Type-Options: nosniff\n`;
  if (common !== undefined) headers += link(common);
  for (const asset of exceptions) headers += `/${STATIC_ASSET_PREFIX}${asset.sha256}\n  ! Link\n${link(asset.license)}`;
  const redirects = served.map((asset) => `/${STATIC_ASSET_PREFIX}${asset.sha256} /${staticFile(asset)} 200\n`).join("");
  return { served, headers, redirects };
}

/** True when the bytes are exactly the declared asset. */
export async function verifiesAsset(asset: Pick<StaticAsset, "sha256" | "bytes">, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength !== asset.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") === asset.sha256;
}
