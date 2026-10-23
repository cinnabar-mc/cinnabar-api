import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishedRelease, RELEASE_CACHE_KEY, RELEASE_CACHE_NAME } from "../src/crash-reports/releases";

const LIST = "https://api.github.com/repos/cinnabar-mc/cinnabar/releases?per_page=100";
const RELEASES = "https://github.com/cinnabar-mc/cinnabar/releases/";
const CHANNELS = "https://raw.githubusercontent.com/cinnabar-mc/cinnabar/dev/packaging/release-assets.json";

beforeEach(async () => {
  const cache = await caches.open(RELEASE_CACHE_NAME);
  await cache.delete(RELEASE_CACHE_KEY);
  await cache.delete(`${RELEASE_CACHE_KEY}/refresh`);
});
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
  const assets = {
    repository: "cinnabar-mc/cinnabar",
    update_channels: {
      beta: { track: "tagged", manifest: "update-beta.json" },
      nightly: { track: "rolling", tag: "nightly", manifest: "update-nightly.json" },
    },
  };
  const manifests = new Map([
    ["latest/download/update-beta.json", { version: "1.2.4-beta.1", channel: "beta" }],
    ["download/nightly/update-nightly.json", { version: "1.2.5-nightly", channel: "nightly" }],
  ]);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === LIST) return Response.json(releases.slice(0, 100));
    if (url === CHANNELS) return Response.json(assets);
    const manifest = manifests.get(url.replace(RELEASES, ""));
    if (!manifest) return new Response(null, { status: 404 });
    return Response.json({ key_id: "fixture", signature: "synthetic", manifest: btoa(JSON.stringify(manifest)) });
  });
  return { releases, assets, manifests, fetcher };
}

describe("crash release admission", () => {
  it("admits published stable, beta and nightly versions and caches one bounded lookup", async () => {
    const { fetcher } = publisher();
    for (const release of ["1.2.3", "v1.2.3", "1.2.4-beta.1", "1.2.5-nightly"]) {
      expect(await publishedRelease(release)).toBe(true);
    }
    expect(await publishedRelease("9.9.9")).toBe(false);
    expect(await publishedRelease("8.8.8")).toBeNull();
    expect(await publishedRelease("7.7.7")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(8);
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

  it.each(["empty", "warm"])("shares concurrent %s cache refreshes so a later failure cannot replace successful admission", async (state) => {
    const { fetcher } = publisher();
    const fetchPublication = fetcher.getMockImplementation()!;
    const cache = await caches.open(RELEASE_CACHE_NAME);
    if (state === "warm") await cache.put(RELEASE_CACHE_KEY, Response.json({ versions: ["1.0.0"] }));
    vi.spyOn(caches, "open").mockResolvedValue(cache);
    const match = cache.match.bind(cache);
    const bothMissed = Promise.withResolvers<void>();
    const succeed = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    let reads = 0;
    let lookups = 0;
    vi.spyOn(cache, "match").mockImplementation(async (...args) => {
      const entry = await match(...args);
      if (String(args[0]) === RELEASE_CACHE_KEY && ++reads === 2) bothMissed.resolve();
      return entry;
    });
    fetcher.mockImplementation(async (input, init) => {
      if (String(input) === LIST) {
        if (++lookups === 1) await succeed.promise;
        else {
          await fail.promise;
          return new Response(null, { status: 503 });
        }
      }
      return fetchPublication(input, init);
    });

    const first = publishedRelease("1.2.3");
    const second = publishedRelease("1.2.5-nightly");
    await bothMissed.promise;
    succeed.resolve();
    const firstResult = await first;
    fail.resolve();
    const secondResult = await second;
    expect([firstResult, secondResult, await publishedRelease("1.2.3")]).toEqual([true, true, true]);
    expect(lookups).toBe(1);
  });

  it("admits the current nightly when its rolling release is beyond the first 100 releases", async () => {
    const { releases, fetcher } = publisher();
    releases.unshift(...Array.from({ length: 100 }, (_, index) => ({
      tag_name: `v2.0.${index}`, published_at: "2026-10-05", assets: [],
    })));
    expect(releases.findIndex((release) => release.tag_name === "nightly")).toBeGreaterThanOrEqual(100);
    expect(await publishedRelease("1.2.5-nightly")).toBe(true);
    expect(await publishedRelease("1.2.4-beta.1")).toBe(true);
    expect(await publishedRelease("2.0.99")).toBe(true);
    expect(await publishedRelease("1.2.3")).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(`${RELEASES}download/nightly/update-nightly.json`, expect.anything());
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it("derives rolling tags and manifest asset names from the channel metadata", async () => {
    const { assets, manifests } = publisher();
    assets.update_channels.nightly = { track: "rolling", tag: "nightly-current", manifest: "current.json" };
    manifests.delete("download/nightly/update-nightly.json");
    manifests.set("download/nightly-current/current.json", { version: "1.2.6-nightly", channel: "nightly" });
    expect(await publishedRelease("1.2.6-nightly")).toBe(true);
    expect(await publishedRelease("1.2.5-nightly")).toBe(false);
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

  it.each([CHANNELS, `${RELEASES}download/nightly/update-nightly.json`])(
    "fails closed and caches an outage fetching %s", async (url) => {
      const { fetcher } = publisher();
      const fetchPublication = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (input, init) => String(input) === url
        ? new Response(null, { status: 503 }) : fetchPublication(input, init));
      expect(await publishedRelease("1.2.5-nightly")).toBeNull();
      const calls = fetcher.mock.calls.length;
      expect(await publishedRelease("1.2.3")).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(calls);
      expect((await (await caches.open(RELEASE_CACHE_NAME)).match(RELEASE_CACHE_KEY))?.headers.get("Cache-Control"))
        .toBe("public, max-age=30");
    },
  );

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
    const { releases, assets, manifests, fetcher } = publisher();
    manifests.set("download/nightly/update-nightly.json", { version: "1.2.5-nightly", channel: "stable" });
    expect(await publishedRelease("1.2.3")).toBeNull();
    await (await caches.open(RELEASE_CACHE_NAME)).delete(RELEASE_CACHE_KEY);
    fetcher.mockResolvedValueOnce(Response.json(releases)).mockResolvedValueOnce(Response.json(assets))
      .mockResolvedValueOnce(Response.json({ manifest: "not base64" }));
    expect(await publishedRelease("1.2.3")).toBeNull();
  });
});
