import type { MediaFile } from "./store";

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 + MAX_IMAGES * MAX_IMAGE_BYTES + 256 * 1024;

export class BodyLimitError extends Error {}

/** Bound actual streamed bytes, regardless of absent, invalid or deliberately false Content-Length. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyLimitError("Request body is too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyLimitError("Request body is too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Hash server-read bytes; user-supplied digests never address uploaded objects. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Accept passive raster formats only. The scanner fully decodes them before publication. */
export function imageType(bytes: Uint8Array): MediaFile["type"] {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 12) throw new Error("Each image must be at most 1 MiB.");
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  throw new Error("Upload PNG, JPEG or WebP images. SVG and active content are not accepted.");
}
