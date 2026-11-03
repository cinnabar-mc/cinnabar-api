// Mirrors the live catalog's verified assets into the static root before a deploy, so asset GETs never invoke the Worker.
// Usage: node scripts/sync-static-assets.mjs [static-root]. Failures leave those assets on the Worker route.
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATIC_ASSET_MAX_BYTES, STATIC_ASSET_PREFIX, staticAssets, verifiesAsset } from "../src/static-assets.ts";

const root = process.argv[2] ?? "static";
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const origin = `https://${config.routes[0].pattern}`;
const directory = join(root, STATIC_ASSET_PREFIX);

/** Reads at most `max` bytes, or returns null for an error status or a longer body. */
async function bounded(url, max) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || Number(response.headers.get("Content-Length") ?? 0) > max) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
let written = 0;
let skipped = 0;
try {
  const catalog = await bounded(`${origin}/v1/cosmetics/catalog`, 1024 * 1024);
  if (!catalog) throw new Error("catalog unavailable");
  for (const asset of staticAssets(JSON.parse(catalog.toString("utf8")))) {
    try {
      const bytes = await bounded(`${origin}/${STATIC_ASSET_PREFIX}${asset.sha256}`, Math.min(asset.bytes, STATIC_ASSET_MAX_BYTES));
      if (!bytes || !(await verifiesAsset(asset, bytes))) throw new Error("unverified");
      await writeFile(join(directory, asset.sha256), bytes);
      written++;
    } catch {
      skipped++;
    }
  }
} catch (error) {
  console.log(`::warning::Static cosmetic assets unavailable (${error.message}); the Worker serves them.`);
}
if (skipped) console.log(`::warning::${skipped} cosmetic assets failed verification and stay on the Worker route.`);
console.log(`Mirrored ${written} cosmetic assets from ${origin}.`);
