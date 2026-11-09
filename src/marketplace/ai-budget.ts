import { AI_MAX_INPUT_BYTES, AI_MAX_OUTPUT_TOKENS, AI_PROMPT_OVERHEAD_TOKENS, SCAN_LEASE_MS, type AiUsage } from "./scanning";

/**
 * Neurons the scanner may spend per UTC day when `SCAN_AI_DAILY_NEURONS` is unset. Workers AI's free allocation is
 * 10,000 Neurons a day, and Workers Paid bills anything above it, so the default keeps a margin below that.
 */
export const AI_DAILY_NEURONS = 9_000;
const DAY_MS = 86_400_000;

/**
 * Neurons Workers AI bills per million tokens of the scanner's default model, from Cloudflare's pricing table
 * ($0.293 input and $2.253 output per million tokens at $0.011 per 1,000 Neurons).
 */
const NEURONS_PER_MILLION_TOKENS = { input: 26_668, output: 204_805 } as const;

/** Neurons Workers AI bills for `usage` with the default model, rounded up. */
export function neuronsFor(usage: AiUsage): number {
  return Math.ceil((usage.prompt_tokens * NEURONS_PER_MILLION_TOKENS.input + usage.completion_tokens * NEURONS_PER_MILLION_TOKENS.output) / 1_000_000);
}

/** The most one scan can cost: the largest request the scanner sends, answered with every allowed output token. */
export const AI_SCAN_WORST_CASE_NEURONS = neuronsFor({
  prompt_tokens: AI_MAX_INPUT_BYTES + AI_PROMPT_OVERHEAD_TOKENS, completion_tokens: AI_MAX_OUTPUT_TOKENS,
});

/** The configured daily Neuron budget: a positive integer `value`, or the default when it is unset or invalid. */
export function dailyNeurons(value: string | undefined): number {
  const parsed = value && /^[0-9]{1,9}$/.test(value.trim()) ? Number(value.trim()) : 0;
  return parsed > 0 ? parsed : AI_DAILY_NEURONS;
}

/** The UTC day index containing `at`. */
const dayOf = (at: number): number => Math.floor(at / DAY_MS);
/** The UTC days a scan lease starting at `at` overlaps, during which its scanner may call the AI. */
const leaseDays = (at: number): number[] => {
  const first = dayOf(at), last = dayOf(at + SCAN_LEASE_MS);
  return first === last ? [first] : [first, last];
};

/**
 * A per-UTC-day Neuron ledger kept in the Hub's SQLite (`scan_ai_days`). Each claim charges the worst case to every
 * day its lease overlaps; completion replaces that charge with the reported usage, and a release removes it. A lease
 * that expires without either keeps its worst-case charge, because its scanner may have called the AI before failing.
 */
export class ScanBudget {
  constructor(private readonly sql: SqlStorage, readonly daily: number) {}

  /** Null when a claim at `now` fits the budget, otherwise when the next UTC day starts and scanning resumes. */
  refusal(now: number): number | null {
    for (const day of leaseDays(now)) {
      const row = this.sql.exec<{ neurons: number; paused: number }>("SELECT neurons, paused FROM scan_ai_days WHERE day = ?", day).toArray()[0];
      if (row?.paused || (row?.neurons ?? 0) + AI_SCAN_WORST_CASE_NEURONS > this.daily) return (day + 1) * DAY_MS;
    }
    return null;
  }

  /** Charges the worst case for a claim at `now` and returns the charge to record on the job. */
  reserve(now: number): number {
    this.sql.exec("DELETE FROM scan_ai_days WHERE day < ?", dayOf(now) - 7);
    for (const day of leaseDays(now)) this.charge(day, AI_SCAN_WORST_CASE_NEURONS);
    return AI_SCAN_WORST_CASE_NEURONS;
  }

  /** Replaces the `reserved` charge of a claim made at `claimedAt` with `spent` Neurons. */
  settle(claimedAt: number, reserved: number, spent: number): void {
    for (const day of leaseDays(claimedAt)) this.charge(day, spent - reserved);
  }

  /** Stops claims until the UTC day after `now`, after Workers AI refused a request for its daily allocation. */
  pause(now: number): void {
    this.sql.exec("INSERT OR IGNORE INTO scan_ai_days (day) VALUES (?)", dayOf(now));
    this.sql.exec("UPDATE scan_ai_days SET paused = 1 WHERE day = ?", dayOf(now));
  }

  /** Adds `neurons` (possibly negative) to `day`'s charge, never going below zero. */
  private charge(day: number, neurons: number): void {
    this.sql.exec("INSERT OR IGNORE INTO scan_ai_days (day) VALUES (?)", day);
    this.sql.exec("UPDATE scan_ai_days SET neurons = MAX(neurons + ?, 0) WHERE day = ?", neurons, day);
  }
}
