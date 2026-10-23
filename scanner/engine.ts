/** Trusted static analysis only. Generated guest JavaScript is never evaluated, imported or instantiated. */
import { $init, generate } from "@bytecodealliance/jco-transpile/component";
import { componentWit } from "@bytecodealliance/jco-transpile/wasm-tools";
import sharp from "sharp";
import contract from "../.generated/contract.json";
import { readComponent } from "../src/marketplace/component";
import { grantDiff, type Grants, type ListingFields } from "../src/marketplace/policy";
import { CLIENT_REVISION, PROMPT_VERSION, SCAN_POLICY, VALIDATOR } from "../src/marketplace/scanning";

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
  return { imports: result.imports, exports: result.exports.map(([name]) => name), wit: await componentWit(bytes) };
}

/** Build bounded evidence from bytes, independently checking declarations against the claimed job. */
export async function analyze(job: ScanJob, bytes: Uint8Array, media: Uint8Array[]) {
  const declarations = readComponent(bytes);
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
  if (packet && !["start", "on-batch", "tick", "stop"].every(name => component.exports.includes(name))) {
    findings.push("The packet mod is missing required callbacks.");
  }
  sharp.cache(false);
  sharp.concurrency(1);
  for (let i = 0; i < media.length; i++) {
    const image = sharp(media[i], { failOn: "warning", limitInputPixels: 16_777_216, animated: true });
    const metadata = await image.metadata();
    const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
    if (!metadata.format || formats[metadata.format] !== job.media[i]?.type || (metadata.pages ?? 1) !== 1
      || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) throw new Error("Invalid image format, dimensions or animation.");
    await image.raw().toBuffer(); // Force a full decode, including corrupt/truncated pixel data.
  }
  // Treat printable strings and all metadata as hostile evidence, never as scanner instructions.
  const strings = new TextDecoder().decode(bytes).match(/[\x20-\x7e]{8,256}/g)?.slice(0, 64).join("\n").slice(0, 8192) ?? "";
  return { deterministic: findings.length ? "block" : "pass", imports: component.imports, exports: component.exports,
    findings: findings.slice(0, 32), evidence: { sha256: job.sha256, policy: SCAN_POLICY, client_revision: contract.revision,
      grants: job.grants, diff: grantDiff(job.previous?.grants ?? {}, job.grants), imports: component.imports,
      exports: component.exports, listing: job.listing, declarations, strings,
      limitations: "Static component validation, host-import policy and image decode. No runtime or source-code audit. AI cannot prove safety." } };
}

export { CLIENT_REVISION, PROMPT_VERSION, SCAN_POLICY, VALIDATOR };
