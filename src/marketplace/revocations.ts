/** How long one signed revocation list stays valid for clients. */
const REVOCATION_LIFETIME_MS = 15 * 60_000;
/** How long the Hub reuses one signed list, well inside its lifetime, so polling clients don't each cost a signature. */
export const REVOCATION_MEMO_MS = 30_000;
/**
 * Largest signed revocation body a pull may produce. Clients refuse bodies over 1 MiB and would then hold every
 * managed mod, so this leaves headroom for timestamps and encoding.
 */
export const REVOCATION_BUDGET_BYTES = 768 * 1024;

/** A pulled version as stored, with the reason staff gave. */
export type RevokedRow = { id: number; slug: string; version: string; sha256: string; pull_reason: string };

/** The exact revocation body clients receive for `rows`, which must be in id order; reasons are made well-formed. */
export function revocationBody(now: number, rows: readonly RevokedRow[]): string {
  const revoked = rows.map((v) => ({ slug: v.slug, version: v.version, sha256: v.sha256, reason: v.pull_reason.toWellFormed() }));
  return JSON.stringify({ issued_at: now, expires_at: now + REVOCATION_LIFETIME_MS, revoked });
}

/** Whether `body` fits the byte budget measured as the UTF-8 bytes clients download. */
export function withinRevocationBudget(body: string): boolean {
  return new TextEncoder().encode(body).byteLength <= REVOCATION_BUDGET_BYTES;
}

/** A signed revocation list, with the time it was signed and the store revision it reflects. */
export interface SignedRevocations { body: string; signature: string | null; at: number; revision: number }

/**
 * Reuses `memo` while it reflects the current pulled set (`revision`) and is younger than REVOCATION_MEMO_MS;
 * otherwise null, and the caller signs a fresh list.
 */
export function reusableRevocations(memo: SignedRevocations | null, revision: number, now: number): SignedRevocations | null {
  return memo && memo.revision === revision && now >= memo.at && now - memo.at < REVOCATION_MEMO_MS ? memo : null;
}
