import { deflateSync } from "node:zlib";

/** Unsigned LEB128 for synthetic WebAssembly section lengths. */
function leb(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(value ? byte | 128 : byte); } while (value);
  return bytes;
}

/** Builds a component with only top-level custom sections, including arbitrary binary fixtures. */
export function component(sections: [string, string | Uint8Array][], layer = [13, 0, 1, 0]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [new Uint8Array([0, 97, 115, 109, ...layer])];
  for (const [name, data] of sections) {
    const label = encoder.encode(name), payload = typeof data === "string" ? encoder.encode(data) : data;
    parts.push(new Uint8Array([0, ...leb(leb(label.length).length + label.length + payload.length), ...leb(label.length)]), label, payload);
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** A PNG chunk with its independent, bit-at-a-time reference CRC implementation. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

/** A fully decodable synthetic grayscale PNG, optionally padded to an exact encoded byte budget. */
export function pngIcon(width = 1, height = 1, shade = 0, totalBytes?: number): Uint8Array {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8;
  const pixels = new Uint8Array((width + 1) * height).fill(shade);
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels))];
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + 12;
  if (totalBytes !== undefined) chunks.push(pngChunk("paDd", new Uint8Array(totalBytes - length - 12)));
  chunks.push(pngChunk("IEND", new Uint8Array()));
  return new Uint8Array(chunks.flatMap(chunk => [...chunk]));
}
