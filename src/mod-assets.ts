/** Maximum artifact size accepted by the publisher upload route. */
export const MAX_MOD_ASSET_BYTES = 32 * 1024 * 1024;
const PREFIX = "mod-releases/";

/** The isolated storage key shared by uploads, publication checks and public downloads. */
export function modAssetKey(hash: string): string { return PREFIX + hash; }

/** Reads a bounded binary body without trusting Content-Length. */
async function readAsset(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MOD_ASSET_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Stores only a complete WASM component whose bytes match its content-addressed key. */
export async function uploadModAsset(request: Request, hash: string, bucket: R2Bucket): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(hash) || !(Number(request.headers.get("Content-Length") ?? 0) <= MAX_MOD_ASSET_BYTES)) {
    return new Response(null, { status: 400 });
  }
  const bytes = await readAsset(request.body);
  if (!bytes || bytes.length < 8 || ![0, 97, 115, 109, 13, 0, 1, 0].every((b, i) => bytes[i] === b)) {
    return new Response(null, { status: 400 });
  }
  const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual !== hash) return new Response(null, { status: 400 });
  await bucket.put(modAssetKey(hash), bytes, {
    httpMetadata: { contentType: "application/wasm" }, customMetadata: { sha256: hash },
  });
  return new Response(null, { status: 204 });
}

/** Streams only a published, size-matching artifact, with immutable public caching. */
export async function downloadModAsset(hash: string, size: number | null, bucket: R2Bucket): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(hash) || size === null) return new Response(null, { status: 404 });
  const object = await bucket.get(modAssetKey(hash));
  if (!object) return new Response(null, { status: 404 });
  if (object.size !== size || object.customMetadata?.sha256 !== hash) {
    await object.body.cancel(); return new Response(null, { status: 404 });
  }
  return new Response(object.body, { headers: {
    "Content-Type": "application/wasm", "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${hash}"`,
  } });
}
