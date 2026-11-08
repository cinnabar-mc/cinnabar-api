/** Optional top-level presentation section used by the Cinnabar client. */
export const ICON_SECTION = "cinnabar:extension/icon@1";
/** Client limits apply to the encoded PNG and each decoded side, inclusively. */
export const MAX_ICON_BYTES = 256 * 1024;
export const MAX_ICON_SIDE = 256;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** PNG's CRC-32 over a chunk's type and data, without allocating a second buffer. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Returns a private diagnostic for an unusable icon, or null for a bounded PNG structure.
 * Unlike the client's PNG decoder this does not inflate IDAT or validate pixel/filter data.
 * Chunk framing, CRCs, header fields and required critical chunks are checked in bounded space.
 */
export function iconError(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_ICON_BYTES) return "The icon is over 256 KiB.";
  if (PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) return "The icon is not a PNG.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, color = -1;
  let header = false, palette = false, pixels = false, pixelsEnded = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return "The icon has a truncated PNG chunk.";
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return "The icon has a truncated PNG chunk.";
    const data = offset + 8, end = data + length;
    const typeBytes = bytes.subarray(offset + 4, data);
    if (typeBytes.some(v => !(v >= 65 && v <= 90) && !(v >= 97 && v <= 122)) || (typeBytes[2]! & 32)) {
      return "The icon has an invalid PNG chunk type.";
    }
    const type = String.fromCharCode(...typeBytes);
    if (crc32(bytes, offset + 4, end) !== view.getUint32(end)) return "The icon has an invalid PNG chunk CRC.";
    if (!header && type !== "IHDR") return "The icon must start with PNG IHDR.";
    if (type === "IHDR") {
      if (header || length !== 13) return "The icon has an invalid PNG IHDR.";
      const width = view.getUint32(data), height = view.getUint32(data + 4);
      if (!width || !height || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE) return "The icon sides must be between 1 and 256 pixels.";
      const depth = bytes[data + 8]!;
      color = bytes[data + 9]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[data + 10] !== 0 || bytes[data + 11] !== 0 || bytes[data + 12]! > 1) {
        return "The icon has an invalid PNG IHDR.";
      }
      header = true;
    } else if (type === "PLTE") {
      if (palette || pixels || !length || length > 768 || length % 3 || color === 0 || color === 4) return "The icon has an invalid PNG palette.";
      palette = true;
    } else if (type === "IDAT") {
      if (pixelsEnded || (color === 3 && !palette)) return "The icon has invalid PNG image chunks.";
      pixels = true;
    } else if (type === "IEND") {
      if (length || !pixels || end + 4 !== bytes.length) return "The icon has an invalid PNG IEND.";
      return null;
    } else {
      if (!(typeBytes[0]! & 32)) return "The icon has an unknown critical PNG chunk.";
      if (pixels) pixelsEnded = true;
    }
    offset = end + 4;
  }
  return "The icon is missing PNG IEND.";
}
