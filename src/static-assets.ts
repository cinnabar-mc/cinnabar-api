/** Canonical asset route; mirrored digests are served there without invoking the Worker. */
export const STATIC_ASSET_PREFIX = "v1/cosmetics/assets/";
/** Backing files carry extensions here, so Cloudflare derives each asset's Content-Type. */
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

export interface StaticFile { asset: StaticAsset; path: string }

/**
 * Places downloaded assets and builds their `_headers` and `_redirects`, keeping only what fits Cloudflare's rule limits.
 * Backing files sit in one directory per license, so each directory needs one rule; canonical URLs share a wildcard rule
 * for the most common license and need one rule per other asset.
 */
export function staticRules(assets: readonly StaticAsset[]): { files: StaticFile[]; headers: string; redirects: string } {
  const candidates = assets.slice(0, MAX_STATIC_REDIRECTS);
  const counts = new Map<string, number>();
  for (const asset of candidates) counts.set(asset.license, (counts.get(asset.license) ?? 0) + 1);
  let common: string | undefined;
  for (const [license, count] of counts) if (common === undefined || count > counts.get(common)!) common = license;
  const licenses = common === undefined ? [] : [common];
  let rules = 1 + licenses.length;
  const files: StaticFile[] = [];
  for (const asset of candidates) {
    let index = licenses.indexOf(asset.license);
    if (asset.license !== common) {
      const cost = index < 0 ? 2 : 1;
      if (rules + cost > MAX_HEADER_RULES) continue;
      rules += cost;
      if (index < 0) index = licenses.push(asset.license) - 1;
    }
    files.push({ asset, path: `${STATIC_FILE_PREFIX}${index}/${asset.sha256}.${asset.kind === "texture" ? "png" : "json"}` });
  }
  const rule = (path: string, license?: string, detach = false) =>
    `${path}\n${detach ? "  ! Link\n" : `  Cache-Control: ${IMMUTABLE}\n  X-Content-Type-Options: nosniff\n`}` +
    (license === undefined ? "" : `  Link: <${license}>; rel="license"\n`);
  let headers = rule(`/${STATIC_ASSET_PREFIX}*`, common);
  headers += licenses.map((license, index) => rule(`/${STATIC_FILE_PREFIX}${index}/*`, license)).join("");
  headers += files.filter(({ asset }) => asset.license !== common)
    .map(({ asset }) => rule(`/${STATIC_ASSET_PREFIX}${asset.sha256}`, asset.license, true)).join("");
  const redirects = files.map(({ asset, path }) => `/${STATIC_ASSET_PREFIX}${asset.sha256} /${path} 200\n`).join("");
  return { files, headers, redirects };
}

/** True when the bytes are exactly the declared asset. */
export async function verifiesAsset(asset: Pick<StaticAsset, "sha256" | "bytes">, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength !== asset.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") === asset.sha256;
}
