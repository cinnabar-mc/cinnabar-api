// Mirrors the live catalog's verified assets into the static root before a deploy, so asset GETs never invoke the Worker.
// Usage: node scripts/sync-static-assets.mjs [static-root]. Anything not mirrored stays on the Worker route.
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATIC_ASSET_PREFIX, STATIC_FILE_PREFIX, staticAssets, staticRules, verifiesAsset } from "../src/static-assets.ts";

// Well inside the deploy job's timeout, so a stalled origin delays the deploy instead of cancelling it.
const BUDGET_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const root = process.argv[2] ?? "static";
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const origin = `https://${config.routes[0].pattern}`;
const deadline = Date.now() + BUDGET_MS;

/** Reads at most `max` bytes before the shared deadline, or returns null for an error status or a longer body. */
async function bounded(url, max) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)) });
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

for (const name of [STATIC_FILE_PREFIX, "_headers", "_redirects"]) await rm(join(root, name), { recursive: true, force: true });
const downloaded = [];
let skipped = 0;
try {
  const catalog = await bounded(`${origin}/v1/cosmetics/catalog`, 1024 * 1024);
  if (!catalog) throw new Error("catalog unavailable");
  for (const asset of staticAssets(JSON.parse(catalog.toString("utf8")))) {
    try {
      const bytes = await bounded(`${origin}/${STATIC_ASSET_PREFIX}${asset.sha256}`, asset.bytes);
      if (!bytes || !(await verifiesAsset(asset, bytes))) throw new Error("unverified");
      downloaded.push({ asset, bytes });
    } catch {
      skipped++;
    }
  }
} catch (error) {
  console.log(`::warning::Static cosmetic assets unavailable (${error.message}); the Worker serves them.`);
}
const rules = staticRules(downloaded.map(({ asset }) => asset));
const bytesOf = new Map(downloaded.map(({ asset, bytes }) => [asset, bytes]));
for (const { asset, path } of rules.files) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytesOf.get(asset));
}
await writeFile(join(root, "_headers"), rules.headers);
await writeFile(join(root, "_redirects"), rules.redirects);
const unserved = skipped + downloaded.length - rules.files.length;
if (unserved) console.log(`::warning::${unserved} cosmetic assets stay on the Worker route (unverified, late or over rule limits).`);
console.log(`Mirrored ${rules.files.length} cosmetic assets from ${origin}.`);
