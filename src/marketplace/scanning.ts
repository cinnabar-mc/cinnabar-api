import contract from "../../.generated/contract.json";
export const CLIENT_REVISION = contract.revision;
/** Newest stable mod API of the pinned client whose interfaces the scanner validates. */
export const API_REVISION = contract.api_revision;
/** Increment when the validator, evidence or publication policy changes; older reports cannot publish. */
export const SCAN_POLICY = "cinnabar-marketplace-2026-11-08-v4";
export const VALIDATOR = "jco-0.20.0+wasm-tools-1.245.1";
export const PROMPT_VERSION = "mod-evidence-v1";
export const SCAN_LEASE_MS = 5 * 60_000;
export const MAX_SCAN_ATTEMPTS = 3;
export const SCAN_MAX_AGE_MS = 24 * 3_600_000;

/** The Workers AI model the scanner calls unless `AI_MODEL` overrides it; the daily budget prices this model. */
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** `max_tokens` of every AI review request. */
export const AI_MAX_OUTPUT_TOKENS = 1200;
/**
 * The most UTF-8 bytes of message text (system instruction plus JSON evidence) the scanner sends in one AI request.
 * Byte-level BPE emits at least one byte per token, so a request never has more prompt tokens than this plus
 * `AI_PROMPT_OVERHEAD_TOKENS`. A larger packet is not sent and ends as an AI error hold.
 */
export const AI_MAX_INPUT_BYTES = 96 * 1024;
/** Generous allowance for the chat template and JSON-mode schema the provider adds around the messages. */
export const AI_PROMPT_OVERHEAD_TOKENS = 2048;
/** Largest token count a report may claim for either side of one request. */
export const AI_USAGE_MAX_TOKENS = 1_000_000;

/** Provider-reported tokens of one AI review; zero when no request was sent. */
export interface AiUsage { prompt_tokens: number; completion_tokens: number }

export interface ScanReport {
  sha256: string;
  policy: string;
  validator: string;
  client_revision: string;
  deterministic: "pass" | "block" | "error";
  imports: string[];
  exports: string[];
  media: string[];
  findings: string[];
  /** `usage` is absent only in reports from scanners that predate usage reporting. */
  ai: { verdict: "clear" | "flag" | "error"; model: string; prompt: string; findings: string[]; usage?: AiUsage };
}

/** `value` as an `AiUsage` holding exactly two bounded non-negative integer counts, or null. */
export function parseAiUsage(value: unknown): AiUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= AI_USAGE_MAX_TOKENS;
  if (Object.keys(v).length !== 2 || !count(v.prompt_tokens) || !count(v.completion_tokens)) return null;
  return { prompt_tokens: v.prompt_tokens, completion_tokens: v.completion_tokens };
}

/** Accept a bounded scanner attestation; model text can never supply policy or validator fields. */
export function parseScanReport(input: unknown, sha256: string, media: string[] = []): ScanReport | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const strings = (x: unknown, max: number, size: number): x is string[] => Array.isArray(x) && x.length <= max
    && x.every(s => typeof s === "string" && s.length <= size);
  if (v.sha256 !== sha256 || v.policy !== SCAN_POLICY || v.validator !== VALIDATOR || v.client_revision !== CLIENT_REVISION
    || !["pass", "block", "error"].includes(String(v.deterministic))
    || !strings(v.imports, 256, 256) || !strings(v.exports, 256, 256) || !strings(v.findings, 32, 1000)
    || !strings(v.media, 5, 64) || JSON.stringify(v.media) !== JSON.stringify(media)) return null;
  const ai = v.ai as Record<string, unknown> | null;
  if (!ai || typeof ai !== "object" || !["clear", "flag", "error"].includes(String(ai.verdict))
    || typeof ai.model !== "string" || !ai.model || ai.model.length > 128 || ai.prompt !== PROMPT_VERSION
    || !strings(ai.findings, 16, 1000)) return null;
  const usage = ai.usage === undefined ? undefined : parseAiUsage(ai.usage);
  if (usage === null) return null;
  if ((v.deterministic === "pass" && v.findings.length) || (ai.verdict === "clear" && ai.findings.length)) return null;
  return { sha256, policy: SCAN_POLICY, validator: VALIDATOR, client_revision: CLIENT_REVISION, deterministic: v.deterministic as ScanReport["deterministic"],
    imports: v.imports, exports: v.exports, findings: v.findings, media: v.media,
    ai: { verdict: ai.verdict as ScanReport["ai"]["verdict"], model: ai.model, prompt: PROMPT_VERSION, findings: ai.findings,
      ...(usage ? { usage } : {}) } };
}

/** A complete deterministic scan is mandatory even when a human reviews an AI flag. */
export function scanReady(report: ScanReport | null, completed: number | null, now: number): boolean {
  return !!report && report.policy === SCAN_POLICY && report.validator === VALIDATOR && report.client_revision === CLIENT_REVISION && report.deterministic === "pass"
    && report.ai.prompt === PROMPT_VERSION && report.ai.verdict !== "error"
    && completed !== null && completed + SCAN_MAX_AGE_MS > now;
}
