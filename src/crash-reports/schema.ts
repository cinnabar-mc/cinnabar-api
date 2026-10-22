import { Validator, type Schema } from "@cfworker/json-schema";

export const MAX_COMPRESSED_BYTES = 64 * 1024;
export const MAX_JSON_BYTES = 512 * 1024;
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const text = { type: "string", maxLength: 200 } as const;
const nullableText: Schema = { type: ["string", "null"], maxLength: 200 };
const id = { type: "string", pattern: "^[0-9a-f]{32}$" } as const;
const hex = { type: "string", pattern: "^(0x)?[0-9a-fA-F]{1,80}$" } as const;
const kind = { enum: ["panic", "native", "abort", "hang", "core", "startup", "runtime"] };

/** The versioned client payload. Unknown envelope fields cannot hide extra attachments. */
const schema: Schema = {
  type: "object", additionalProperties: false,
  required: ["schema", "report_id", "install_id", "signature", "kind", "release", "commit", "build_profile", "os", "arch", "uptime_ms", "report", "log"],
  properties: {
    schema: { const: 1 }, report_id: id, install_id: id,
    signature: { type: "string", minLength: 1, maxLength: 240 }, kind,
    release: text, commit: text, build_profile: text, os: text, arch: text,
    gpu: nullableText, driver: nullableText, backend: { type: ["string", "null"], maxLength: 16 },
    uptime_ms: { type: "integer", minimum: 0 },
    report: {
      type: "object", additionalProperties: false, required: ["message"],
      properties: {
        schema: { const: 1 }, kind, message: { type: "string", maxLength: 16384 },
        thread: { type: "object", additionalProperties: false,
          properties: { name: nullableText, id: text } },
        backtrace: { type: "string", maxLength: 16384 },
        release: text, commit: text, build_profile: text, os: text, arch: text,
        gpu: nullableText, driver: nullableText, uptime_ms: { type: "integer", minimum: 0 },
        renderer: { type: ["object", "null"] },
        game_state: { type: "object", maxProperties: 128, additionalProperties: { type: "string", maxLength: 16384 } },
        span_trace: { type: ["string", "null"], maxLength: 16384 },
      },
    },
    native: { type: ["object", "null"], additionalProperties: false,
      properties: { reason: text, address: hex, exit_code: hex,
        fault: { type: "object", additionalProperties: false, properties: { address: hex, offset: hex, module: text } } } },
    stack: { type: ["object", "null"], additionalProperties: false,
      required: ["reason", "modules", "frames"], properties: {
        reason: { type: "string", maxLength: 256 },
        modules: { type: "array", maxItems: 512, items: {
          type: "object", additionalProperties: false, required: ["name", "in_app"],
          properties: { name: { type: "string", maxLength: 256, pattern: "^[^/\\\\]*$" }, debug_id: hex, code_id: hex, in_app: { type: "boolean" } },
        } },
        frames: { type: "array", maxItems: 64, items: {
          type: "object", additionalProperties: false, required: ["offset", "trust"],
          properties: { module: { type: "integer", minimum: 0, maximum: 511 }, offset: hex,
            trust: { enum: ["context", "unwound", "scan"] }, function: { type: "string", maxLength: 256 } },
        } },
      } },
    log: { type: "array", maxItems: 200, items: { type: "string", maxLength: 1000 } },
  },
};
const validator = new Validator(schema);

export interface Payload {
  report_id: string;
  install_id: string;
  signature: string;
  kind: string;
  release: string;
  commit: string;
  os: string;
  gpu?: string | null;
  backend?: string | null;
  stack?: { modules: unknown[]; frames: { module?: number }[] } | null;
}

/** Bounds recursion before validation and checks frame indices against the actual module list. */
export function validPayload(value: unknown): value is Payload {
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (depth > 24) return false;
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) pending.push([item, depth + 1]);
    }
  }
  if (!validator.validate(value).valid) return false;
  const payload = value as Payload;
  return !payload.stack || payload.stack.frames.every((frame) =>
    frame.module === undefined || frame.module < payload.stack!.modules.length);
}
