const RELEASES_URL = "https://api.github.com/repos/cinnabar-mc/cinnabar/releases";
export const DOWNLOAD_COUNT_KEY = "downloads/count-v1.json";
const REFRESH_MS = 15 * 60_000;
const pending = new WeakMap<R2Bucket, Promise<number>>();

/** Coalesces concurrent reads and shares a fifteen-minute GitHub aggregate through R2. */
export function downloadCount(bucket: R2Bucket): Promise<number> {
  const existing = pending.get(bucket);
  if (existing) return existing;
  const operation = readOrRefresh(bucket).finally(() => pending.delete(bucket));
  pending.set(bucket, operation);
  return operation;
}

/** Reuses a recent snapshot, publishing a replacement only after every GitHub page succeeds. */
async function readOrRefresh(bucket: R2Bucket): Promise<number> {
  const object = await bucket.get(DOWNLOAD_COUNT_KEY);
  if (object) {
    if (object.size > 1024) await object.body.cancel();
    else {
      let snapshot: { downloads?: number; at?: number } | null = null;
      try { snapshot = await object.json(); } catch { /* Rebuild invalid snapshots. */ }
      if (snapshot && Number.isSafeInteger(snapshot.downloads) && snapshot.downloads! >= 0
        && Number.isSafeInteger(snapshot.at) && snapshot.at! <= Date.now()
        && Date.now() - snapshot.at! < REFRESH_MS) return snapshot.downloads!;
    }
  }
  const downloads = await githubDownloads();
  await bucket.put(DOWNLOAD_COUNT_KEY, JSON.stringify({ downloads, at: Date.now() }), {
    httpMetadata: { contentType: "application/json" },
  });
  return downloads;
}

/** Sums installable packages on published versioned and rolling-nightly releases, excluding metadata. */
async function githubDownloads(): Promise<number> {
  const signal = AbortSignal.timeout(4500);
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${RELEASES_URL}?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Cinnabar-API", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal,
    });
    if (!response.ok) throw new Error("GitHub downloads unavailable");
    const releases: unknown = await response.json();
    if (!Array.isArray(releases) || releases.length > 100) throw new Error("Invalid releases");
    for (const release of releases) {
      if (!release || typeof release.tag_name !== "string" || typeof release.draft !== "boolean") throw new Error("Invalid release");
      if (release.draft || !(release.tag_name === "nightly" || /^v\d/.test(release.tag_name))) continue;
      if (!Array.isArray(release.assets)) throw new Error("Invalid assets");
      for (const asset of release.assets) {
        if (!asset || typeof asset.name !== "string") throw new Error("Invalid asset");
        if (!/\.(apk|dmg|exe|msi|AppImage)$/i.test(asset.name)) continue;
        if (!Number.isSafeInteger(asset.download_count) || asset.download_count < 0) throw new Error("Invalid downloads");
        total += asset.download_count;
        if (!Number.isSafeInteger(total)) throw new Error("Download count overflow");
      }
    }
    if (releases.length < 100) return total;
  }
  throw new Error("Too many release pages");
}
