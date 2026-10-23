import { bounded } from "./body";

export const RELEASE_CACHE_KEY = "https://api.cinnabar.gg/v1/crash-release-admission-cache";
export const RELEASE_CACHE_NAME = "cinnabar-crash-releases-v1";
const REPOSITORY = "cinnabar-mc/cinnabar";
const CHANNELS = `https://raw.githubusercontent.com/${REPOSITORY}/dev/packaging/release-assets.json`;
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

/** Resolves current manifest URLs from the release pipeline's published channel metadata. */
async function currentManifests(): Promise<Map<string, string>> {
  const assets = await metadata(CHANNELS);
  if (!assets || typeof assets !== "object" || !("repository" in assets) || assets.repository !== REPOSITORY
    || !("update_channels" in assets) || !assets.update_channels || typeof assets.update_channels !== "object"
    || Array.isArray(assets.update_channels)) throw new Error("invalid release channels");
  const manifests = new Map<string, string>();
  for (const [channel, release] of Object.entries(assets.update_channels)) {
    if (!release || typeof release !== "object" || !/^[a-z]{1,32}$/.test(channel)
      || typeof release.manifest !== "string" || !/^[a-zA-Z0-9._-]{1,100}\.json$/.test(release.manifest)) {
      throw new Error("invalid release channel");
    }
    let path: string;
    if (release.track === "tagged") path = "latest/download";
    else if (release.track === "rolling" && typeof release.tag === "string"
      && /^[a-zA-Z0-9._-]{1,100}$/.test(release.tag)) path = `download/${encodeURIComponent(release.tag)}`;
    else throw new Error("invalid release track");
    manifests.set(channel, `https://github.com/${REPOSITORY}/releases/${path}/${release.manifest}`);
  }
  if (!manifests.size) throw new Error("no release channels");
  return manifests;
}

/** Reads bounded historical tags and current channel manifests independently of release ordering. */
async function publishedVersions(): Promise<string[]> {
  const releases = await metadata(RELEASES, 8 * 1024 * 1024);
  if (!Array.isArray(releases) || releases.length > 100) throw new Error("invalid release list");
  const versions = new Set<string>();
  for (const release of releases) {
    if (!release || typeof release !== "object" || release.draft || !release.published_at) continue;
    const tag = release.tag_name;
    const canonical = version(tag);
    if (canonical) versions.add(canonical);
  }
  for (const [channel, url] of await currentManifests()) {
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

/** Checks admission, refreshing cached misses; null means publication must be retried later. */
export async function publishedRelease(release: string): Promise<boolean | null> {
  const canonical = version(release);
  if (!canonical) return false;
  const cache = await caches.open(RELEASE_CACHE_NAME);
  const entry = await cache.match(RELEASE_CACHE_KEY);
  if (entry) {
    const { versions } = await entry.json<{ versions: string[] | null }>();
    if (!versions) return null;
    if (versions.includes(canonical)) return true;
    // A cached absence cannot permanently reject a release published since the lookup.
    const refreshKey = `${RELEASE_CACHE_KEY}/refresh`;
    if (await cache.match(refreshKey)) return null;
    await cache.put(refreshKey, new Response(null, { headers: { "Cache-Control": "public, max-age=60" } }));
  }
  let versions: string[] | null = null;
  try { versions = await publishedVersions(); } catch { /* Refuse ingestion while publication cannot be checked. */ }
  // A failed refresh must not remove admission for versions already in the cache.
  if (versions || !entry) {
    await cache.put(RELEASE_CACHE_KEY, Response.json({ versions },
      { headers: { "Cache-Control": `public, max-age=${versions ? 300 : 30}` } }));
  }
  return versions ? versions.includes(canonical) : null;
}
