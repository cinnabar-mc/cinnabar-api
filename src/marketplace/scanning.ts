import contract from "../../.generated/contract.json";
export const CLIENT_REVISION = contract.revision;
/** Increment when the validator, evidence or publication policy changes; older reports cannot publish. */
export const SCAN_POLICY = "cinnabar-marketplace-2026-10-23-v1";
export const VALIDATOR = "jco-0.20.0";
export const PROMPT_VERSION = "mod-evidence-v1";
export const SCAN_LEASE_MS = 5 * 60_000;
export const MAX_SCAN_ATTEMPTS = 3;
export const SCAN_MAX_AGE_MS = 24 * 3_600_000;

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
  ai: { verdict: "clear" | "flag" | "error"; model: string; prompt: string; findings: string[] };
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
    || !strings(v.media, 4, 64) || JSON.stringify(v.media) !== JSON.stringify(media)) return null;
  const ai = v.ai as Record<string, unknown> | null;
  if (!ai || typeof ai !== "object" || !["clear", "flag", "error"].includes(String(ai.verdict))
    || typeof ai.model !== "string" || !ai.model || ai.model.length > 128 || ai.prompt !== PROMPT_VERSION
    || !strings(ai.findings, 16, 1000)) return null;
  if ((v.deterministic === "pass" && v.findings.length) || (ai.verdict === "clear" && ai.findings.length)) return null;
  return { sha256, policy: SCAN_POLICY, validator: VALIDATOR, client_revision: CLIENT_REVISION, deterministic: v.deterministic as ScanReport["deterministic"],
    imports: v.imports, exports: v.exports, findings: v.findings, media: v.media,
    ai: { verdict: ai.verdict as ScanReport["ai"]["verdict"], model: ai.model, prompt: PROMPT_VERSION, findings: ai.findings } };
}

/** A complete deterministic scan is mandatory even when a human reviews an AI flag. */
export function scanReady(report: ScanReport | null, completed: number | null, now: number): boolean {
  return !!report && report.policy === SCAN_POLICY && report.validator === VALIDATOR && report.client_revision === CLIENT_REVISION && report.deterministic === "pass"
    && report.ai.prompt === PROMPT_VERSION && report.ai.verdict !== "error"
    && completed !== null && completed + SCAN_MAX_AGE_MS > now;
}
