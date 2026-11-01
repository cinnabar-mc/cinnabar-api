import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DOWNLOAD_COUNT_KEY, downloadCount } from "../src/download-count";

let origin: string;
beforeEach(async () => {
  origin = `https://${crypto.randomUUID()}.api.test`;
  await env.API_CACHE.delete(DOWNLOAD_COUNT_KEY);
});
afterEach(() => vi.restoreAllMocks());

/** Builds public GitHub fixtures without client binaries or external requests. */
function release(tag_name: string, assets: [string, number][], draft = false) {
  return {tag_name, draft, assets: assets.map(([name, download_count]) => ({name, download_count}))};
}

/** Executes the public route and finishes its edge-cache writes. */
async function request(query = "") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}/v1/downloads/count${query}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

it("counts installers and updates but excludes metadata, support files, drafts and unrelated releases", async () => {
  const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([
    release("v0.1.0", [["client.apk", 10], ["client.dmg", 2], ["client.exe", 3], ["client.msi", 4],
      ["client.AppImage", 5], ["update-payload-abc-client.msi", 6], ["update-beta.json", 100],
      ["SHA256SUMS.txt", 100], ["install.sh", 100], ["debug.zip", 100]]),
    release("nightly", [["client.apk", 7]]),
    release("v0.2.0", [["client.apk", 500]], true),
    release("runtime-dependencies", [["client.apk", 500]]),
  ]));
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({downloads: 37});
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0]![0]).toBe("https://api.github.com/repos/cinnabar-mc/cinnabar/releases?per_page=100&page=1");
  expect(upstream.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
});

it("reads every release page before publishing a snapshot", async () => {
  const upstream = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(Array.from({length: 100}, () => release("v1.0.0", [["client.apk", 1]]))))
    .mockResolvedValueOnce(Response.json([release("v0.1.0", [["client.apk", 2]])]));
  expect(await downloadCount(env.API_CACHE)).toBe(102);
  expect(upstream.mock.calls[1]![0]).toContain("page=2");
  expect(await (await env.API_CACHE.get(DOWNLOAD_COUNT_KEY))!.json()).toMatchObject({downloads: 102});
});

it("shares a recent snapshot across edge locations and coalesces simultaneous refreshes", async () => {
  const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([release("v1.0.0", [["client.apk", 9]])]));
  expect(await Promise.all([downloadCount(env.API_CACHE), downloadCount(env.API_CACHE)])).toEqual([9, 9]);
  const first = await request();
  expect(await first.json()).toEqual({downloads: 9});
  expect(await (await request("?ignored=1")).json()).toEqual({downloads: 9});
  expect(upstream).toHaveBeenCalledTimes(1);
  await env.API_CACHE.put(DOWNLOAD_COUNT_KEY, JSON.stringify({downloads: 4, at: Date.now() - 15 * 60000}));
  expect(await downloadCount(env.API_CACHE)).toBe(9);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("returns a real zero for an empty release list", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
  expect(await downloadCount(env.API_CACHE)).toBe(0);
});

it("does not publish a partial total when later pages fail, and retries successfully", async () => {
  const previous = JSON.stringify({downloads: 42, at: 0});
  await env.API_CACHE.put(DOWNLOAD_COUNT_KEY, previous);
  const upstream = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(Array.from({length: 100}, () => release("v1.0.0", [["client.apk", 1]]))))
    .mockResolvedValueOnce(new Response(null, {status: 403}));
  const failed = await request();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({error: "download count unavailable", code: "source_rate_limited", source_status: 403});
  expect(failed.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(failed.headers.get("Retry-After")).toBe("60");
  expect(failed.headers.get("Cache-Control")).toBeNull();
  expect(await (await env.API_CACHE.get(DOWNLOAD_COUNT_KEY))!.text()).toBe(previous);
  upstream.mockResolvedValue(Response.json([release("v1.0.0", [["client.apk", 50]])]));
  expect(await (await request()).json()).toEqual({downloads: 50});
});

it.each([null, {}, [{tag_name: "v1.0.0"}], [release("v1.0.0", [["client.apk", -1]])],
  [release("v1.0.0", [["client.apk", 1.5]])], [release("v1.0.0", [["client.apk", Number.MAX_SAFE_INTEGER + 1]])],
  [release("v1.0.0", [["client.apk", Number.MAX_SAFE_INTEGER], ["client.msi", 1]])]])(
  "rejects invalid upstream totals without caching them (%j)", async value => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(value));
    expect((await request()).status).toBe(503);
    expect(await env.API_CACHE.get(DOWNLOAD_COUNT_KEY)).toBeNull();
  });

it("clears in-flight work after a timeout and recovers", async () => {
  const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  const failed = await request();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({error: "download count unavailable", code: "count_unavailable"});
  upstream.mockResolvedValue(Response.json([]));
  expect((await request()).status).toBe(200);
});
