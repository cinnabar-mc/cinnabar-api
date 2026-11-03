/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import configText from "../wrangler.jsonc?raw";
import { STATIC_ASSET_MAX_BYTES, STATIC_ASSET_PREFIX, STATIC_FILE_PREFIX, staticAssets, staticRules, verifiesAsset, type StaticAsset } from "../src/static-assets";

const LICENSE = "https://example.test/license";
const sha = (fill: string) => fill.repeat(64);
const asset = (fill: string, bytes = 4) => ({ url: `/${STATIC_ASSET_PREFIX}${sha(fill)}`, sha256: sha(fill), bytes });
const mirrored = (index: number, license = LICENSE): StaticAsset => ({ sha256: index.toString(16).padStart(64, "0"), bytes: 1, kind: "geometry", license });

describe("static cosmetic assets", () => {
  it("mirrors each same-origin asset once with the first descriptor's kind and license", () => {
    const catalog = {
      items: [
        { license: LICENSE, assets: { geometry: asset("a"), texture: asset("b") } },
        { license: "https://other.test/", assets: { texture: asset("a"), animation: { ...asset("c"), url: `https://cdn.example/${sha("c")}` }, geometry: asset("d", STATIC_ASSET_MAX_BYTES + 1) } },
      ],
      emotes: [{ license: LICENSE, clip: asset("e") }, { license: LICENSE, clip: { ...asset("f"), url: `/${STATIC_ASSET_PREFIX}${sha("0")}` } }],
    };
    expect(staticAssets(catalog)).toEqual([
      { sha256: sha("a"), bytes: 4, kind: "geometry", license: LICENSE },
      { sha256: sha("b"), bytes: 4, kind: "texture", license: LICENSE },
      { sha256: sha("e"), bytes: 4, kind: "clip", license: LICENSE },
    ]);
  });

  // Digests become file names and licenses become header lines, so neither may carry path or header syntax.
  it("leaves malformed digests and licenses to the Worker", () => {
    for (const catalog of [null, 7, { items: "x" }, { items: [null, { assets: null }], emotes: [{}] }]) {
      expect(staticAssets(catalog)).toEqual([]);
    }
    const traversal = { url: `/${STATIC_ASSET_PREFIX}../catalog.json`, sha256: "../catalog.json", bytes: 1 };
    expect(staticAssets({ items: [{ license: LICENSE, assets: { geometry: traversal } }] })).toEqual([]);
    for (const license of [`${LICENSE}>; rel="x"`, `${LICENSE}\r\nSet-Cookie: a=b`, "http://example.test/", 7]) {
      expect(staticAssets({ items: [{ license, assets: { geometry: asset("a") } }] })).toEqual([]);
    }
  });

  it("serves textures as PNG and other assets as JSON", () => {
    const [texture, ...others] = staticRules(["texture", "geometry", "animation", "clip"].map((kind, index) => ({ ...mirrored(index), kind }))).files;
    expect(texture!.path).toMatch(/\.png$/);
    for (const file of others) expect(file.path).toMatch(/\.json$/);
  });

  /** Returns the header lines Cloudflare applies to `path`: matching rules in order, with `! Link` detaching earlier links. */
  function applied(headers: string, path: string): string[] {
    const lines: string[] = [];
    for (const rule of headers.trim().split(/\n(?=\/)/)) {
      const [pattern, ...body] = rule.split("\n");
      const matches = pattern!.endsWith("*") ? path.startsWith(pattern!.slice(0, -1)) : path === pattern;
      if (!matches) continue;
      for (const line of body.map((value) => value.trim())) {
        if (line === "! Link") lines.splice(0, lines.length, ...lines.filter((value) => !value.startsWith("Link:")));
        else lines.push(line);
      }
    }
    return lines;
  }

  it("serves every public URL of a mirrored asset with its own license and leaves assets over the rule limits on the Worker", () => {
    const common = Array.from({ length: 2_100 }, (_, index) => mirrored(index));
    const others = Array.from({ length: 150 }, (_, index) => mirrored(10_000 + index, `https://other.test/${index}`));
    const { files, headers, redirects } = staticRules([...others.slice(0, 3), ...common, ...others.slice(3)]);
    expect(headers.trim().split(/\n(?=\/)/).length).toBeLessThanOrEqual(100);
    const lines = new Set(redirects.trim().split("\n"));
    expect(lines.size).toBe(files.length);
    expect(files.length).toBeLessThanOrEqual(2_000);
    for (const { asset, path } of files) {
      expect(path.startsWith(STATIC_FILE_PREFIX)).toBe(true);
      expect(lines.has(`/${STATIC_ASSET_PREFIX}${asset.sha256} /${path} 200`)).toBe(true);
      for (const url of [`/${STATIC_ASSET_PREFIX}${asset.sha256}`, `/${path}`]) {
        const values = applied(headers, url);
        expect(values.filter((value) => value.startsWith("Link:"))).toEqual([`Link: <${asset.license}>; rel="license"`]);
        expect(values).toContain("Cache-Control: public, max-age=31536000, immutable");
        expect(values).toContain("X-Content-Type-Options: nosniff");
      }
    }
    expect(files.filter(({ asset }) => asset.license !== LICENSE)).toHaveLength(3);
    // Each further license costs a backing-directory rule and a canonical rule.
    const capped = staticRules([...others, ...common.slice(0, 10)]);
    expect(capped.headers.trim().split(/\n(?=\/)/)).toHaveLength(100);
    expect(capped.files).toHaveLength(10 + 49);
    expect(staticRules([])).toEqual({ files: [], headers: `/${STATIC_ASSET_PREFIX}*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n`, redirects: "" });
  });

  it("verifies both size and digest", async () => {
    const bytes = new TextEncoder().encode("skin");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifiesAsset({ sha256: digest, bytes: 4 }, bytes)).toBe(true);
    expect(await verifiesAsset({ sha256: digest, bytes: 5 }, bytes)).toBe(false);
    expect(await verifiesAsset({ sha256: sha("a"), bytes: 4 }, bytes)).toBe(false);
  });

  it("checks mirrored files before the Worker and passes every miss to it", () => {
    const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.assets).toEqual({ directory: "./static", html_handling: "none", not_found_handling: "none" });
  });
});
