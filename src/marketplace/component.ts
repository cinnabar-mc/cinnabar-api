import { requestedCapabilities, type Grants } from "./policy";

/** The client's per-component source limit. */
export const MAX_COMPONENT_BYTES = 16 * 1024 * 1024;
const MAX_GRANTS_BYTES = 16 * 1024;

export interface ComponentDeclarations {
  name: string;
  description: string;
  version: string;
  authors: string;
  licenses: string;
  /** The `cinnabar:grants` request; null when the component declares none. */
  grants: Grants | null;
}

/** Reads unsigned LEB128 at `offset`, returning the value and the following offset. */
function leb(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (offset >= bytes.length) throw new Error("Truncated file");
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, offset];
  }
  throw new Error("Malformed length");
}

/**
 * Reads a component's top-level custom sections without compiling it: the standard metadata fields and the
 * JSON `cinnabar:grants` request, mirroring the client's declarations parser. Throws a player-facing message
 * for anything that isn't a well-framed component or that requests unknown capabilities.
 */
export function readComponent(bytes: Uint8Array): ComponentDeclarations {
  if (bytes.length > MAX_COMPONENT_BYTES) throw new Error("The file is over 16 MiB.");
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("This isn't a WebAssembly file.");
  }
  if (!(bytes[4] === 0x0d && bytes[6] === 0x01)) throw new Error("This is a core module. Package it as a component first.");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const found: ComponentDeclarations = { name: "", description: "", version: "", authors: "", licenses: "", grants: null };
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset]!;
    const [size, start] = leb(bytes, offset + 1);
    const end = start + size;
    if (end > bytes.length) throw new Error("Truncated file");
    if (id === 0) {
      const [nameLength, nameStart] = leb(bytes, start);
      const nameEnd = nameStart + nameLength;
      if (nameEnd > end) throw new Error("Truncated file");
      const name = text.decode(bytes.subarray(nameStart, nameEnd));
      const data = bytes.subarray(nameEnd, end);
      if (name === "description" || name === "version" || name === "authors" || name === "licenses") {
        found[name] = text.decode(data).slice(0, 512);
      } else if (name === "component-name" && data[0] === 0) {
        const [, lengthAt] = leb(data, 1);
        const [length, at] = leb(data, lengthAt);
        found.name = text.decode(data.subarray(at, at + length)).slice(0, 64);
      } else if (name === "cinnabar:grants") {
        if (data.length > MAX_GRANTS_BYTES) throw new Error("The grants section is over 16 KiB.");
        let grants: unknown;
        try { grants = JSON.parse(text.decode(data)); } catch { throw new Error("The grants section isn't valid JSON."); }
        requestedCapabilities(grants);
        found.grants = grants as Grants;
      }
    }
    offset = end;
  }
  return found;
}
