/** Trusted static analysis only. Generated guest JavaScript is never evaluated, imported or instantiated. */
import { $init, generate } from "@bytecodealliance/jco-transpile/component";
import { componentWit } from "@bytecodealliance/jco-transpile/wasm-tools";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import contract from "../.generated/contract.json";
import { readComponent } from "../src/marketplace/component";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "../src/marketplace/media-policy";
import { grantDiff, type Grants, type ListingFields } from "../src/marketplace/policy";
import { CLIENT_REVISION, PROMPT_VERSION, SCAN_POLICY, VALIDATOR } from "../src/marketplace/scanning";

const IMAGE_FORMATS: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * Code-point budgets for creator-controlled evidence text, so the AI packet stays within the model's context however
 * long the listing or component metadata is. Fields longer than their budget keep their start plus a truncation marker.
 */
export const EVIDENCE_BUDGET = {
  /** The listing description, which accepts up to 40,000 characters. */
  description: 6000,
  /** Release notes and the component's own description, authors and licenses. */
  long: 2000,
  /** Every other listing or declaration string, such as names, versions and the source URL. */
  short: 256,
  /** Each import or export list, counting every name in it. */
  names: 2048,
} as const;

/** `text` clipped to `budget` code points, with a marker saying how much was kept when anything was dropped. */
export function boundedText(text: string, budget: number): string {
  const points = [...text];
  return points.length <= budget ? text : `${points.slice(0, budget).join("")}… [truncated: ${budget} of ${points.length} code points]`;
}

/** Leading interface names that fit `budget` code points together, each clipped, with a marker counting the rest. */
export function boundedNames(names: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const name of names) {
    const item = boundedText(name, EVIDENCE_BUDGET.short);
    const size = [...item].length;
    if (used + size > budget) break;
    kept.push(item);
    used += size;
  }
  return kept.length === names.length ? kept : [...kept, `… [truncated: ${names.length - kept.length} more names]`];
}

/** Clips every string in `fields` to `budgets[key]`, or the short budget for keys it doesn't name; other values pass through. */
function boundedFields<T extends object>(fields: T, budgets: Record<string, number>): T {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, typeof value === "string" ? boundedText(value, budgets[key] ?? EVIDENCE_BUDGET.short) : value])) as T;
}

export interface ScanJob {
  id: string; lease: string; sha256: string; bytes: number; policy: string; grants: Grants;
  listing: ListingFields; media: { sha256: string; type: string; bytes: number; caption: string }[];
  previous: { grants: Grants } | null;
}

/** Validate the full component and each nested core module without calling its start function. */
export async function validateComponent(bytes: Uint8Array) {
  readComponent(bytes);
  await $init;
  const result = generate(bytes, { name: "upload", noTypescript: true, noNodejsCompat: true,
    instantiation: { tag: "async" }, base64Cutoff: 0 });
  for (const [name, module] of result.files) {
    if (name.endsWith(".wasm") && !WebAssembly.validate(new Uint8Array(module))) throw new Error("Invalid nested core bytecode.");
  }
  const wit = await componentWit(bytes);
  // Transpiler imports are JS specifiers with versions removed, not canonical capability identities.
  // The trusted WIT printer emits each world import on its own line. Inline/function imports stay
  // visibly noncanonical and fail the exact host-interface allowlist below.
  const imports = [...wit.matchAll(/^\s*import\s+([^\r\n]*)/gm)].map(match => match[1]!.trim().replace(/;$/, ""));
  if (result.imports.length && !imports.length) throw new Error("Missing canonical component import evidence.");
  return { imports, exports: result.exports.map(([name]) => name), wit };
}

/**
 * Check component subtyping against the pinned client world without executing guest code.
 * wasm-tools validates a synthetic instantiation: host imports may be unused/subsets, but every
 * imported function/type/resource must link and every required callback must have its WIT type.
 * A type mismatch returns false; unavailable tooling, timeout or process failure throws.
 */
function targetsClientWorld(bytes: Uint8Array, world: "extension" | "packet-mod"): boolean {
  const result = spawnSync(fileURLToPath(new URL("../.generated/wasm-tools/wasm-tools", import.meta.url)),
    ["component", "targets", fileURLToPath(new URL("../.generated/wit/", import.meta.url)), "--world", world, "-"],
    { input: bytes, env: {}, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("World compatibility validator failed.");
}

/** Build bounded evidence from bytes, independently checking declarations against the claimed job. */
export async function analyze(job: ScanJob, bytes: Uint8Array, media: Uint8Array[]) {
  // Binary presentation data is media, never text evidence for the AI reviewer.
  const { icon: _icon, iconError: _iconError, ...declarations } = readComponent(bytes);
  if (JSON.stringify(declarations.grants ?? {}) !== JSON.stringify(job.grants)) throw new Error("Grant attestation mismatch.");
  const component = await validateComponent(bytes);
  if (component.imports.length > 256 || component.exports.length > 256) throw new Error("Too many component interfaces.");
  const findings: string[] = [];
  for (const name of component.imports) {
    if (!contract.interfaces.includes(name)) findings.push(`Unsupported host import: ${name}`);
  }
  const packet = job.grants.packets === true;
  if (!packet && !["init", "frame"].every(name => new RegExp(`export ${name}: func\\(\\);`).test(component.wit))) {
    findings.push("The component must export init and frame with the client callback signatures.");
  }
  // Jco renames exports to JavaScript identifiers (on-batch becomes onBatch), so read the canonical WIT names.
  const exported = new Set([...component.wit.matchAll(/^\s*export\s+([a-z][a-z0-9-]*):\s*func\(/gm)].map(match => match[1]!));
  if (packet && !["start", "on-batch", "tick", "stop"].every(name => exported.has(name))) {
    findings.push("The packet mod is missing required callbacks.");
  }
  const world = packet ? "packet-mod" : "extension";
  if (!findings.length && !targetsClientWorld(bytes, world)) {
    findings.push(`The component does not target the pinned client ${world} world: incompatible host import types or callback signatures.`);
  }
  sharp.cache(false);
  sharp.concurrency(1);
  for (let i = 0; i < media.length; i++) {
    const image = sharp(media[i], { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, animated: true });
    const metadata = await image.metadata();
    if (!metadata.format || IMAGE_FORMATS[metadata.format] !== job.media[i]?.type || (metadata.pages ?? 1) !== 1
      || !metadata.width || !metadata.height || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) throw new Error("Invalid image format, dimensions or animation.");
    await image.raw().toBuffer(); // Force a full decode, including corrupt/truncated pixel data.
  }
  // Treat printable strings and all metadata as hostile evidence, never as scanner instructions.
  const strings = new TextDecoder().decode(bytes).match(/[\x20-\x7e]{8,256}/g)?.slice(0, 64).join("\n").slice(0, 8192) ?? "";
  return { deterministic: findings.length ? "block" : "pass", imports: component.imports, exports: component.exports,
    findings: findings.slice(0, 32), evidence: { sha256: job.sha256, policy: SCAN_POLICY, client_revision: CLIENT_REVISION,
      grants: job.grants, diff: grantDiff(job.previous?.grants ?? {}, job.grants),
      imports: boundedNames(component.imports, EVIDENCE_BUDGET.names), exports: boundedNames(component.exports, EVIDENCE_BUDGET.names),
      listing: boundedFields(job.listing, { description: EVIDENCE_BUDGET.description, notes: EVIDENCE_BUDGET.long }),
      declarations: boundedFields(declarations, { description: EVIDENCE_BUDGET.long, authors: EVIDENCE_BUDGET.long, licenses: EVIDENCE_BUDGET.long }),
      strings,
      limitations: "Static component and client world type validation, host-import policy and image decode. No runtime or source-code audit. AI cannot prove safety." } };
}

export { CLIENT_REVISION, PROMPT_VERSION, SCAN_POLICY, VALIDATOR };
