import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishedRelease, RELEASE_CACHE_KEY, RELEASE_CACHE_NAME } from "../src/crash-reports/releases";

const LIST = "https://api.github.com/repos/cinnabar-mc/cinnabar/releases?per_page=100";
const DOWNLOAD = "https://github.com/cinnabar-mc/cinnabar/releases/download/";

beforeEach(async () => { await (await caches.open(RELEASE_CACHE_NAME)).delete(RELEASE_CACHE_KEY); });
afterEach(() => vi.restoreAllMocks());

/** Supplies synthetic public release metadata and manifests in their published envelope format. */
function publisher() {
  const releases = [
    { tag_name: "v1.2.3", published_at: "2026-10-01", assets: [{ name: "update-stable.json" }] },
    { tag_name: "v1.2.4-beta.1", published_at: "2026-10-02", assets: [{ name: "update-beta.json" }] },
    { tag_name: "nightly", published_at: "2026-10-03", assets: [{ name: "update-nightly.json" }] },
    { tag_name: "v9.9.9", published_at: "2026-10-04", draft: true, assets: [] },
    { tag_name: "v8.8.8", published_at: null, assets: [] },
  ];
  const manifests = new Map([
    ["v1.2.3/update-stable.json", { version: "1.2.3", channel: "stable" }],
    ["v1.2.4-beta.1/update-beta.json", { version: "1.2.4-beta.1", channel: "beta" }],
    ["nightly/update-nightly.json", { version: "1.2.5-nightly", channel: "nightly" }],
  ]);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === LIST) return Response.json(releases);
    const manifest = manifests.get(url.replace(DOWNLOAD, ""));
    if (!manifest) return new Response(null, { status: 404 });
    return Response.json({ key_id: "fixture", signature: "synthetic", manifest: btoa(JSON.stringify(manifest)) });
  });
  return { releases, manifests, fetcher };
}

describe("crash release admission", () => {
  it("admits published stable, beta and nightly versions and caches one bounded lookup", async () => {
    const { fetcher } = publisher();
    for (const release of ["1.2.3", "v1.2.3", "1.2.4-beta.1", "1.2.5-nightly"]) {
      expect(await publishedRelease(release)).toBe(true);
    }
    expect(await publishedRelease("9.9.9")).toBe(false);
    expect(await publishedRelease("8.8.8")).toBe(false);
    expect(await publishedRelease("7.7.7")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect((await (await caches.open(RELEASE_CACHE_NAME)).match(RELEASE_CACHE_KEY))?.headers.get("Cache-Control"))
      .toBe("public, max-age=300");
  });

  it("does not fetch metadata for arbitrary version strings", async () => {
    const { fetcher } = publisher();
    for (const release of ["nightly", "custom", "1.2.3+arbitrary", "v1.2.3/random", "1.2.3-beta.random"]) {
      expect(await publishedRelease(release)).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed during publication outages and caches failures briefly", async () => {
    const { fetcher } = publisher();
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await publishedRelease("1.2.3")).toBeNull();
    expect(await publishedRelease("1.2.4")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await (await caches.open(RELEASE_CACHE_NAME)).match(RELEASE_CACHE_KEY))?.headers.get("Cache-Control"))
      .toBe("public, max-age=30");
    await (await caches.open(RELEASE_CACHE_NAME)).delete(RELEASE_CACHE_KEY);
    fetcher.mockRestore();
    publisher();
    expect(await publishedRelease("1.2.3")).toBe(true);
  });

  it("rejects malformed or oversized publication responses without trusting a claimed length", async () => {
    const { fetcher } = publisher();
    let cancelled = false;
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Length": "1" } }));
    expect(await publishedRelease("1.2.3")).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("requires the expected manifest channel and refuses malformed envelopes", async () => {
    const { manifests } = publisher();
    manifests.set("nightly/update-nightly.json", { version: "1.2.5-nightly", channel: "stable" });
    expect(await publishedRelease("1.2.3")).toBeNull();
    await (await caches.open(RELEASE_CACHE_NAME)).delete(RELEASE_CACHE_KEY);
    vi.mocked(fetch).mockResolvedValue(Response.json({ manifest: "not base64" }));
    expect(await publishedRelease("1.2.3")).toBeNull();
  });
});
