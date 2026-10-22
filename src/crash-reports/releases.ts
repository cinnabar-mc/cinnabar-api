import { bounded } from "./body";

export const RELEASE_CACHE_KEY = "https://api.cinnabar.gg/v1/crash-release-admission-cache";
export const RELEASE_CACHE_NAME = "cinnabar-crash-releases-v1";
const REPOSITORY = "https://github.com/cinnabar-mc/cinnabar/releases/download/";
const RELEASES = "https://api.github.com/repos/cinnabar-mc/cinnabar/releases?per_page=100";
const VERSION = /^v?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:nightly|beta|alpha|rc)(?:[.-]\d{1,10})?)?)$/;

/** Returns the canonical published version, excluding arbitrary tags and build metadata. */
function version(value: unknown): string | null {
  return typeof value === "string" ? value.match(VERSION)?.[1] ?? null : null;
}

/** Fetches bounded public release metadata, with a deadline and no credentials. */
async function metadata(url: string, limit = 256 * 1024): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "cinnabar-api" },
    signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error("release metadata unavailable");
  const bytes = await bounded(response.body, limit);
  if (!bytes) throw new Error("release metadata exceeds limit");
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Reads recent published tags and the newest available manifest for each release channel. */
async function publishedVersions(): Promise<string[]> {
  const releases = await metadata(RELEASES, 8 * 1024 * 1024);
  if (!Array.isArray(releases) || releases.length > 100) throw new Error("invalid release list");
  const versions = new Set<string>();
  const manifests = new Map<string, string>();
  for (const release of releases) {
    if (!release || typeof release !== "object" || release.draft || !release.published_at) continue;
    const tag = release.tag_name;
    const canonical = version(tag);
    if (canonical) versions.add(canonical);
    if (typeof tag !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(tag) || !Array.isArray(release.assets)) continue;
    for (const channel of ["nightly", "beta", "stable"]) {
      const name = `update-${channel}.json`;
      if (!manifests.has(channel) && release.assets.some((asset: { name?: unknown }) => asset?.name === name)) {
        manifests.set(channel, `${REPOSITORY}${encodeURIComponent(tag)}/${name}`);
      }
    }
  }
  for (const [channel, url] of manifests) {
    const envelope = await metadata(url);
    if (!envelope || typeof envelope !== "object" || !("manifest" in envelope)
      || typeof envelope.manifest !== "string") throw new Error("invalid release envelope");
    // HTTPS publication is enough for admission. Clients still verify the detached signature.
    const manifest: unknown = JSON.parse(atob(envelope.manifest));
    if (!manifest || typeof manifest !== "object" || !("version" in manifest)
      || !("channel" in manifest) || manifest.channel !== channel) throw new Error("invalid release manifest");
    const canonical = version(manifest.version);
    if (!canonical) throw new Error("invalid manifest version");
    versions.add(canonical);
  }
  if (!versions.size) throw new Error("no published versions");
  return [...versions];
}

/** Checks only admission, never authenticity; outages fail closed and are cached briefly. */
export async function publishedRelease(release: string): Promise<boolean | null> {
  const canonical = version(release);
  if (!canonical) return false;
  const cache = await caches.open(RELEASE_CACHE_NAME);
  let entry = await cache.match(RELEASE_CACHE_KEY);
  if (!entry) {
    let versions: string[] | null = null;
    try { versions = await publishedVersions(); } catch { /* Refuse ingestion while publication cannot be checked. */ }
    entry = Response.json({ versions }, { headers: { "Cache-Control": `public, max-age=${versions ? 300 : 30}` } });
    await cache.put(RELEASE_CACHE_KEY, entry.clone());
  }
  const { versions } = await entry.json<{ versions: string[] | null }>();
  return versions ? versions.includes(canonical) : null;
}
