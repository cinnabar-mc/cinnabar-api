/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import configText from "../wrangler.jsonc?raw";
import { STATIC_ASSET_MAX_BYTES, STATIC_ASSET_PREFIX, staticAssets, staticFile, staticRules, verifiesAsset, type StaticAsset } from "../src/static-assets";

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
    expect(staticFile({ ...mirrored(1), kind: "texture" })).toMatch(/\.png$/);
    for (const kind of ["geometry", "animation", "clip"]) expect(staticFile({ ...mirrored(1), kind })).toMatch(/\.json$/);
  });

  it("gives every mirrored asset its own license and leaves assets over the rule limits on the Worker", () => {
    const common = Array.from({ length: 2_100 }, (_, index) => mirrored(index));
    const others = Array.from({ length: 150 }, (_, index) => mirrored(10_000 + index, `https://other.test/${index}`));
    const { served, headers, redirects } = staticRules([...others.slice(0, 3), ...common, ...others.slice(3)]);
    const rules = headers.split(/\n(?=\/)/);
    expect(rules[0]).toBe(`/${STATIC_ASSET_PREFIX}*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  Link: <${LICENSE}>; rel="license"`);
    expect(rules.length).toBeLessThanOrEqual(100);
    const lines = new Set(redirects.trim().split("\n"));
    expect(lines.size).toBe(served.length);
    expect(served.length).toBeLessThanOrEqual(2_000);
    const own = new Map(rules.slice(1).map((rule) => [rule.slice(0, rule.indexOf("\n")), rule]));
    for (const asset of served) {
      expect(lines.has(`/${STATIC_ASSET_PREFIX}${asset.sha256} /${staticFile(asset)} 200`)).toBe(true);
      const rule = own.get(`/${STATIC_ASSET_PREFIX}${asset.sha256}`);
      expect(rule ?? rules[0]).toContain(`Link: <${asset.license}>; rel="license"`);
      if (rule) expect(rule).toContain("! Link");
    }
    expect(served.filter((asset) => asset.license !== LICENSE)).toHaveLength(3);
    const capped = staticRules([...others, ...common.slice(0, 10)]);
    expect(capped.headers.split(/\n(?=\/)/)).toHaveLength(100);
    expect(capped.served).toHaveLength(10 + 99);
    expect(staticRules([])).toEqual({ served: [], headers: `/${STATIC_ASSET_PREFIX}*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n`, redirects: "" });
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
