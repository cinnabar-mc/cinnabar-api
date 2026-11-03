/** Asset route below the static root; files there are served without invoking the Worker. */
export const STATIC_ASSET_PREFIX = "v1/cosmetics/assets/";
/** Workers static assets refuse larger files, so those stay on the Worker route. */
export const STATIC_ASSET_MAX_BYTES = 25 * 1024 * 1024;

export interface StaticAsset { sha256: string; bytes: number }

/** Returns each distinct same-origin item and emote asset in an untrusted catalog; anything else stays on the Worker. */
export function staticAssets(catalog: unknown): StaticAsset[] {
  const value = catalog as { items?: unknown; emotes?: unknown } | null;
  const items = Array.isArray(value?.items) ? value.items : [];
  const emotes = Array.isArray(value?.emotes) ? value.emotes : [];
  const candidates = [
    ...items.flatMap((item) => Object.values((item as { assets?: unknown })?.assets ?? {})),
    ...emotes.map((emote) => (emote as { clip?: unknown })?.clip),
  ];
  const seen = new Set<string>();
  const result: StaticAsset[] = [];
  for (const candidate of candidates) {
    const { url, sha256, bytes } = (candidate ?? {}) as { url?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || url !== `/${STATIC_ASSET_PREFIX}${sha256}`) continue;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > STATIC_ASSET_MAX_BYTES) continue;
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    result.push({ sha256, bytes });
  }
  return result;
}

/** True when the bytes are exactly the declared asset. */
export async function verifiesAsset(asset: StaticAsset, bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength !== asset.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") === asset.sha256;
}
