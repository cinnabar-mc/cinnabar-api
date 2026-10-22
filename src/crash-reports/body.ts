import { MAX_COMPRESSED_BYTES, MAX_JSON_BYTES } from "./schema";

/** Reads a bounded stream and cancels promptly at the limit, including an inflated gzip body. */
async function bounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Decodes only gzip JSON, capping both wire bytes and inflated bytes without trusting headers. */
export async function readPayload(request: Request): Promise<{ value: unknown; json: Uint8Array<ArrayBuffer> } | number> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json"
      || request.headers.get("Content-Encoding") !== "gzip") return 415;
  if (!request.body) return 400;
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_COMPRESSED_BYTES) return 413;
  try {
    const compressed = await bounded(request.body, MAX_COMPRESSED_BYTES);
    if (!compressed) return 413;
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const json = await bounded(stream, MAX_JSON_BYTES);
    if (!json) return 413;
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)), json };
  } catch { return 400; }
}
