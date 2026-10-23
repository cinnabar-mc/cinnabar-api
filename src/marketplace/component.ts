import { requestedCapabilities, type Grants } from "./policy";

/** Maximum accepted component size; every body reader enforces this independently of Content-Length. */
export const MAX_COMPONENT_BYTES = 16 * 1024 * 1024;
export interface ComponentDeclarations {
  name: string; description: string; version: string; authors: string; licenses: string;
  grants: Grants | null; grantsDeclared: boolean;
}
/** Read a u32 LEB without crossing its containing section or overflowing. */
function leb(bytes: Uint8Array, offset: number, end: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset >= end) throw new Error("Truncated length.");
    const byte = bytes[offset++]!;
    if (i === 4 && byte > 15) throw new Error("Malformed length.");
    value += (byte & 127) * Math.pow(2, i * 7);
    if (!(byte & 128)) return [value, offset];
  }
  throw new Error("Malformed length.");
}

/** Reject duplicate top-level permission keys, including escaped spellings. */
function parseGrants(value: string): Grants {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Grants must be an object.");
  const tokens = value.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g) || [];
  const seen = new Set<string>();
  let depth = 0;
  tokens.forEach(function (token, index) {
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
    else if (depth === 1 && token[0] === '"' && tokens[index + 1] === ":") {
      const name = JSON.parse(token);
      if (seen.has(name)) throw new Error("Duplicate capability: " + name);
      seen.add(name);
    }
  });
  requestedCapabilities(parsed);
  return parsed;
}

/**
 * Read strictly framed top-level declarations. Full component/type/code validation
 * additionally runs in the trusted worker; this reader never executes an upload.
 */
export function readComponent(bytes: Uint8Array): ComponentDeclarations {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("The file is over 16 MiB.");
  if (bytes.length < 8 || [0, 97, 115, 109].some(function (v, i) { return bytes[i] !== v; })) {
    throw new Error("This isn't a WebAssembly file.");
  }
  if ([1, 0, 0, 0].every(function (v, i) { return bytes[i + 4] === v; })) {
    throw new Error("This is a core module. Package it as a component first.");
  }
  if (![13, 0, 1, 0].every(function (v, i) { return bytes[i + 4] === v; })) throw new Error("Invalid component header.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const found: ComponentDeclarations = { name: "", description: "", version: "", authors: "", licenses: "", grants: null, grantsDeclared: false };
  const seen = new Set<string>();
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++]!;
    if (id > 11) throw new Error("Unknown component section.");
    const [size, start] = leb(bytes, offset, bytes.length);
    const end = start + size;
    if (end > bytes.length) throw new Error("Truncated section.");
    if (id === 0) {
      const [length, nameStart] = leb(bytes, start, end);
      const nameEnd = nameStart + length;
      if (nameEnd > end) throw new Error("Truncated section name.");
      const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
      const recognized = ["component-name", "description", "version", "authors", "licenses", "cinnabar:grants"].includes(name);
      if (recognized && seen.has(name)) throw new Error("Duplicate metadata section: " + name);
      if (recognized) seen.add(name);
      const data = bytes.subarray(nameEnd, end);
      if (["description", "version", "authors", "licenses"].includes(name)) {
        if (data.length > 65536) throw new Error("Metadata section is too large.");
        found[name as "description" | "version" | "authors" | "licenses"] = decoder.decode(data);
      }
      if (name === "component-name") {
        let cursor = 0;
        let named = false;
        while (cursor < data.length) {
          const sub = data[cursor++]!;
          const [subSize, subStart] = leb(data, cursor, data.length);
          const subEnd = subStart + subSize;
          if (subEnd > data.length) throw new Error("Truncated component name.");
          if (sub === 0) {
            if (named) throw new Error("Duplicate component name.");
            named = true;
            const [count, at] = leb(data, subStart, subEnd);
            if (at + count !== subEnd) throw new Error("Malformed component name.");
            found.name = decoder.decode(data.subarray(at, subEnd));
          }
          cursor = subEnd;
        }
      }
      if (name === "cinnabar:grants") {
        if (data.length > 16384) throw new Error("The grants section is over 16 KiB.");
        found.grants = parseGrants(decoder.decode(data));
        found.grantsDeclared = true;
      }
    }
    offset = end;
  }
  return found;
}
