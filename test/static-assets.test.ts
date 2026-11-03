/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import headers from "../static/_headers?raw";
import configText from "../wrangler.jsonc?raw";
import { STATIC_ASSET_MAX_BYTES, STATIC_ASSET_PREFIX, staticAssets, verifiesAsset } from "../src/static-assets";

const sha = (fill: string) => fill.repeat(64);
const asset = (fill: string, bytes = 4) => ({ url: `/${STATIC_ASSET_PREFIX}${sha(fill)}`, sha256: sha(fill), bytes });

describe("static cosmetic assets", () => {
  it("mirrors each same-origin item and emote asset once", () => {
    const catalog = {
      items: [
        { assets: { geometry: asset("a"), texture: asset("b"), animation: asset("a") } },
        { assets: { geometry: { ...asset("c"), url: `https://cdn.example/${sha("c")}` }, texture: asset("d", STATIC_ASSET_MAX_BYTES + 1) } },
      ],
      emotes: [{ clip: asset("e") }, { clip: { ...asset("f"), url: `/${STATIC_ASSET_PREFIX}${sha("0")}` } }],
    };
    expect(staticAssets(catalog)).toEqual([{ sha256: sha("a"), bytes: 4 }, { sha256: sha("b"), bytes: 4 }, { sha256: sha("e"), bytes: 4 }]);
  });

  // Mirrored file names come from the catalog, so a traversal digest must never become a path.
  it("ignores malformed catalogs and digests", () => {
    for (const catalog of [null, 7, { items: "x" }, { items: [null, { assets: null }], emotes: [{}] }]) {
      expect(staticAssets(catalog)).toEqual([]);
    }
    expect(staticAssets({ items: [{ assets: { geometry: { url: `/${STATIC_ASSET_PREFIX}../catalog.json`, sha256: "../catalog.json", bytes: 1 } } }] })).toEqual([]);
  });

  it("verifies both size and digest", async () => {
    const bytes = new TextEncoder().encode("skin");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifiesAsset({ sha256: digest, bytes: 4 }, bytes)).toBe(true);
    expect(await verifiesAsset({ sha256: digest, bytes: 5 }, bytes)).toBe(false);
    expect(await verifiesAsset({ sha256: sha("a"), bytes: 4 }, bytes)).toBe(false);
  });

  it("serves the mirror with immutable caching and leaves misses to the Worker", () => {
    const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.assets).toEqual({ directory: "./static", html_handling: "none", not_found_handling: "none" });
    const rule = headers.split(/\n(?=\S)/).find((block) => block.startsWith(`/${STATIC_ASSET_PREFIX}*\n`));
    expect(rule).toContain("Cache-Control: public, max-age=31536000, immutable");
    expect(rule).toContain("X-Content-Type-Options: nosniff");
  });
});
