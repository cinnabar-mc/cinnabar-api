import {
  ROLES, approvalRule, approvalsComplete, atLeast, canApprove, canReview, canSetRole, grantDiff, reachOf,
  requestedCapabilities, validateListing, type Actor, type Grants, type Reach, type ReviewState, type Role,
} from "./policy";
import { CLIENT_REVISION, MAX_SCAN_ATTEMPTS, SCAN_LEASE_MS, SCAN_MAX_AGE_MS, SCAN_POLICY, parseScanReport, scanReady, type ScanReport } from "./scanning";

export const PLAYER_SESSION_MS = 30 * 24 * 3_600_000;
export const STAFF_SESSION_MS = 12 * 3_600_000;
/** Role changes need a sign-in this recent. */
export const ROLE_CHANGE_SIGN_IN_MS = 10 * 60_000;
export const OAUTH_STATE_MS = 10 * 60_000;
export const MAX_PENDING_SUBMISSIONS = 5;
export const MAX_REPORTS_PER_DAY = 10;
export const MAX_LIBRARY = 100;
const REPORT_REASONS = ["broken", "advantage", "malicious", "stolen", "other"];

/** An HTTP-shaped answer, plus accounts whose live clients should receive their library again. */
export interface MarketResult {
  status: number;
  body: unknown;
  notify?: string[];
  /** A version whose approval completed, for the hub to sign. */
  approved?: number;
}

/** Who is asking: the hash of their session cookie and the CSRF header they sent, if any. */
export interface Caller {
  session?: string;
  csrf?: string;
}

interface Account extends Actor {
  gamertag: string;
}
type SessionRow = {
  xuid: string;
  csrf: string;
  created_at: number;
};
type VersionRow = {
  id: number;
  slug: string;
  version: string;
  sha256: string;
  bytes: number;
  grants: string;
  reach: number;
  status: ReviewState["status"];
  note: string;
  submitted_at: number;
  decided_at: number | null;
  pulled: number;
  pull_reason: string;
  signature: string | null;
  statement: string | null;
  creator: string;
};
type ListingRow = {
  slug: string;
  creator: string;
  name: string;
  summary: string;
  description: string;
  source: string;
  hidden: number;
};

export interface MediaFile { sha256: string; bytes: number; type: "image/png" | "image/jpeg" | "image/webp"; caption: string; alt?: string }
type PipelineRow = {
  version_id: number; metadata: string; media: string; baseline: number | null;
  job_id: string; state: "queued" | "running" | "complete" | "failed";
  attempts: number; lease: string | null; lease_until: number | null;
  report: string | null; completed_at: number | null; publish_mode: "manual" | "automatic" | null; promotion_attempt_at: number;
  legacy: number;
};

const ok = (body: unknown, extra: Partial<MarketResult> = {}): MarketResult => ({ status: 200, body, ...extra });
const fail = (status: number, error: string, fields?: Record<string, string>): MarketResult =>
  ({ status, body: fields ? { error, fields } : { error } });

/**
 * The marketplace's durable state in the Hub's SQLite: accounts and roles, web sessions, listings, versions,
 * approvals, reports, players' libraries and the staff audit log. Every rule the website shows is enforced here.
 */
export class MarketplaceStore {
  constructor(private readonly sql: SqlStorage, private readonly owners: ReadonlySet<string>) {
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS market_accounts (xuid TEXT PRIMARY KEY, gamertag TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'player', suspended INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS web_sessions (id_hash TEXT PRIMARY KEY, xuid TEXT NOT NULL, csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS mod_listings (slug TEXT PRIMARY KEY, creator TEXT NOT NULL, name TEXT NOT NULL,
        summary TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS mod_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
        version TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, grants TEXT NOT NULL, reach INTEGER NOT NULL,
        status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', submitted_at INTEGER NOT NULL, decided_at INTEGER,
        pulled INTEGER NOT NULL DEFAULT 0, pull_reason TEXT NOT NULL DEFAULT '', signature TEXT, statement TEXT, UNIQUE (slug, version))`,
      `CREATE TABLE IF NOT EXISTS mod_approvals (version_id INTEGER NOT NULL, xuid TEXT NOT NULL, admin INTEGER NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (version_id, xuid))`,
      `CREATE TABLE IF NOT EXISTS mod_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
        version TEXT NOT NULL, reporter TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '', resolved_by TEXT)`,
      `CREATE TABLE IF NOT EXISTS mod_library (xuid TEXT NOT NULL, slug TEXT NOT NULL, version_id INTEGER NOT NULL,
        sent_at INTEGER NOT NULL, PRIMARY KEY (xuid, slug))`,
      `CREATE TABLE IF NOT EXISTS mod_library_clock (xuid TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS staff_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS mod_pipeline (version_id INTEGER PRIMARY KEY, metadata TEXT NOT NULL,
        media TEXT NOT NULL DEFAULT '[]', baseline INTEGER, job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER, report TEXT, completed_at INTEGER, publish_mode TEXT,
        promotion_attempt_at INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS market_schema (version INTEGER PRIMARY KEY)`,
      `CREATE TABLE IF NOT EXISTS mod_trust (slug TEXT PRIMARY KEY, creator TEXT NOT NULL, granted_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL, reason TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS mod_pipeline_queue ON mod_pipeline (state, lease_until)`,
      `CREATE TABLE IF NOT EXISTS mod_upload_attempts (creator TEXT NOT NULL, at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS mod_upload_creator ON mod_upload_attempts (creator, at)`,
    ]) sql.exec(statement);
    // Upgrade a pre-pipeline draft once, holding formerly approved releases for a fresh scan and review.
    if (!sql.exec("SELECT 1 FROM market_schema WHERE version = 1").toArray().length) {
      sql.exec(`INSERT OR IGNORE INTO mod_pipeline (version_id, metadata, job_id, legacy)
        SELECT v.id, json_object('slug', l.slug, 'name', l.name, 'summary', l.summary, 'description', l.description,
          'source', l.source, 'version', v.version), 'migration-' || v.id, 1
        FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug`);
      sql.exec(`DELETE FROM mod_approvals WHERE version_id IN (SELECT v.id FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
        WHERE p.job_id = 'migration-' || v.id AND p.state = 'queued' AND v.status = 'approved')`);
      sql.exec(`UPDATE mod_versions SET status = 'submitted', signature = NULL WHERE status = 'approved'
        AND id IN (SELECT version_id FROM mod_pipeline WHERE job_id = 'migration-' || version_id AND state = 'queued')`);
      sql.exec("INSERT INTO market_schema (version) VALUES (1)");
    }
    // Old signatures cannot authenticate a newly reconstructed statement after a contract change.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(mod_versions)").toArray().some(column => column.name === "statement")) {
      sql.exec("ALTER TABLE mod_versions ADD COLUMN statement TEXT");
    }
    if (!sql.exec("SELECT 1 FROM market_schema WHERE version = 2").toArray().length) {
      sql.exec(`DELETE FROM mod_approvals WHERE version_id IN
        (SELECT id FROM mod_versions WHERE signature IS NOT NULL AND statement IS NULL)`);
      sql.exec(`UPDATE mod_pipeline SET state = 'queued', attempts = 0, lease = NULL, lease_until = NULL,
        report = NULL, completed_at = NULL, publish_mode = NULL WHERE version_id IN
        (SELECT id FROM mod_versions WHERE signature IS NOT NULL AND statement IS NULL)`);
      sql.exec("UPDATE mod_versions SET status = 'submitted', signature = NULL WHERE signature IS NOT NULL AND statement IS NULL");
      sql.exec("INSERT INTO market_schema (version) VALUES (2)");
    }
    // Preserve send identities across removals and restarts, including libraries created before the clock existed.
    if (!sql.exec("SELECT 1 FROM market_schema WHERE version = 3").toArray().length) {
      sql.exec("INSERT OR IGNORE INTO mod_library_clock (xuid, sent_at) SELECT xuid, MAX(sent_at) FROM mod_library GROUP BY xuid");
      sql.exec("INSERT INTO market_schema (version) VALUES (3)");
    }
  }

  // --- Sign-in -------------------------------------------------------------------------------------------

  /** Remembers a pending Microsoft sign-in for ten minutes. */
  beginSignIn(state: string, verifier: string, returnTo: string, now: number): void {
    this.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
    this.sql.exec("INSERT INTO oauth_states (state, verifier, return_to, expires_at) VALUES (?, ?, ?, ?)",
      state, verifier, returnTo, now + OAUTH_STATE_MS);
  }

  /** Consumes a pending sign-in exactly once. */
  consumeSignIn(state: string, now: number): { verifier: string; returnTo: string } | null {
    const row = this.sql.exec<{ verifier: string; return_to: string; expires_at: number }>(
      "SELECT verifier, return_to, expires_at FROM oauth_states WHERE state = ?", state).toArray()[0];
    this.sql.exec("DELETE FROM oauth_states WHERE state = ?", state);
    return row && row.expires_at > now ? { verifier: row.verifier, returnTo: row.return_to } : null;
  }

  /** Records the verified Xbox identity and opens a session under the hash of its cookie. */
  signIn(xuid: string, gamertag: string, sessionHash: string, csrf: string, now: number): void {
    this.sql.exec(`INSERT INTO market_accounts (xuid, gamertag, seen_at) VALUES (?, ?, ?)
      ON CONFLICT (xuid) DO UPDATE SET gamertag = excluded.gamertag, seen_at = excluded.seen_at`, xuid, gamertag, now);
    this.sql.exec("DELETE FROM web_sessions WHERE created_at <= ?", now - PLAYER_SESSION_MS);
    this.sql.exec("INSERT INTO web_sessions (id_hash, xuid, csrf, created_at) VALUES (?, ?, ?, ?)", sessionHash, xuid, csrf, now);
  }

  /** End only the authenticated browser's session; suspended accounts can still sign out. */
  signOut(caller: Caller, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session.status === 401 ? ok({}) : session;
    this.sql.exec("DELETE FROM web_sessions WHERE id_hash = ?", caller.session!);
    return ok({});
  }

  private account(xuid: string): Account | null {
    const row = this.sql.exec<{ xuid: string; gamertag: string; role: string; suspended: number }>(
      "SELECT xuid, gamertag, role, suspended FROM market_accounts WHERE xuid = ?", xuid).toArray()[0];
    if (!row) return null;
    const role: Role = this.owners.has(row.xuid) ? "owner" : ROLES.includes(row.role as Role) ? row.role as Role : "player";
    return { xuid: row.xuid, gamertag: row.gamertag, role, suspended: !!row.suspended };
  }

  /** Resolves a live session; staff sessions expire after twelve hours, player sessions after thirty days. */
  private session(caller: Caller, now: number): (SessionRow & { account: Account }) | null {
    if (!caller.session) return null;
    const row = this.sql.exec<SessionRow>("SELECT xuid, csrf, created_at FROM web_sessions WHERE id_hash = ?",
      caller.session).toArray()[0];
    const account = row && this.account(row.xuid);
    if (!row || !account) return null;
    const lifetime = atLeast(account, "moderator") ? STAFF_SESSION_MS : PLAYER_SESSION_MS;
    if (row.created_at + lifetime <= now) {
      this.sql.exec("DELETE FROM web_sessions WHERE id_hash = ?", caller.session);
      return null;
    }
    return { ...row, account };
  }

  /** Resolves the caller for a write, checking the CSRF token bound to their session. */
  private writer(caller: Caller, now: number): { account: Account; created_at: number } | MarketResult {
    const session = this.session(caller, now);
    if (!session) return fail(401, "Sign in with Microsoft first.");
    if (!caller.csrf || caller.csrf !== session.csrf) return fail(403, "Refresh the page and try again.");
    return session;
  }

  private staff(caller: Caller, now: number, write: boolean): Account | MarketResult {
    const session = write ? this.writer(caller, now) : this.session(caller, now);
    if (!session) return fail(401, "Sign in with Microsoft first.");
    if ("status" in session) return session;
    if (!atLeast(session.account, "moderator") || session.account.suspended) return fail(403, "Staff only.");
    return session.account;
  }

  private name(xuid: string): string {
    return this.sql.exec<{ gamertag: string }>("SELECT gamertag FROM market_accounts WHERE xuid = ?", xuid)
      .toArray()[0]?.gamertag ?? "Unknown";
  }

  private log(actor: string, action: string, target: string, note: string, now: number): void {
    this.sql.exec("INSERT INTO staff_audit (at, actor, action, target, note) VALUES (?, ?, ?, ?, ?)",
      now, actor, action, target, note.slice(0, 500));
  }

  // --- Reads ---------------------------------------------------------------------------------------------

  /** The signed-in account, its CSRF token and the mods it has sent to its game. */
  me(caller: Caller, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session) return ok({ account: null, library: [], csrf: null });
    const { xuid, gamertag, role, suspended } = session.account;
    return ok({ account: { xuid, gamertag, role, suspended }, library: this.library(xuid), csrf: session.csrf });
  }

  /** The library entries a player's client should hold, including pulled versions with staff's reason. */
  library(xuid: string): { slug: string; version: string; sha256: string; bytes: number; grants: Grants; sent_at: string;
    pulled: boolean; pull_reason?: string }[] {
    return this.sql.exec<VersionRow & { sent_at: number }>(`SELECT v.*, l.sent_at FROM mod_library l
      JOIN mod_versions v ON v.id = l.version_id WHERE l.xuid = ? ORDER BY l.sent_at`, xuid).toArray()
      .map((v) => ({ slug: v.slug, version: v.version, sha256: v.sha256, bytes: v.bytes, grants: JSON.parse(v.grants) as Grants,
        sent_at: new Date(v.sent_at).toISOString(), pulled: !!v.pulled, ...(v.pulled ? { pull_reason: v.pull_reason } : {}) }));
  }

  private versions(where: string, ...args: SqlStorageValue[]): VersionRow[] {
    return this.sql.exec<VersionRow>(`SELECT v.*, l.creator FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug
      WHERE ${where}`, ...args).toArray();
  }

  private approvals(versionId: number): { xuid: string; admin: boolean; at: number; gamertag: string }[] {
    return this.sql.exec<{ xuid: string; admin: number; at: number }>(
      "SELECT xuid, admin, at FROM mod_approvals WHERE version_id = ? ORDER BY at", versionId).toArray()
      .map((a) => ({ xuid: a.xuid, admin: !!a.admin, at: a.at, gamertag: this.name(a.xuid) }));
  }

  private liveVersion(slug: string): VersionRow | undefined {
    return this.versions(`v.slug = ? AND v.status = 'approved' AND v.signature IS NOT NULL AND v.statement IS NOT NULL AND v.pulled = 0
      AND EXISTS (SELECT 1 FROM mod_pipeline p WHERE p.version_id = v.id AND p.state = 'complete')
      ORDER BY v.decided_at DESC, v.id DESC LIMIT 1`, slug)[0];
  }

  private listing(slug: string): ListingRow | undefined {
    return this.sql.exec<ListingRow>("SELECT * FROM mod_listings WHERE slug = ?", slug).toArray()[0];
  }

  /** A listing as the public catalogue shows it, or null when nothing about it is public. */
  private publicListing(listing: ListingRow) {
    const live = this.liveVersion(listing.slug);
    if (!live || listing.hidden || this.account(listing.creator)?.suspended) return null;
    const metadata = JSON.parse(this.pipeline(live.id)!.metadata) as ListingRow & { category?: string; license?: string };
    const p = this.pipeline(live.id)!;
    const report = p.report ? JSON.parse(p.report) as ScanReport : null;
    return {
      slug: listing.slug, name: metadata.name, summary: metadata.summary, description: metadata.description,
      source: metadata.source, gallery: this.media(live.id), creator: listing.creator, creator_name: this.name(listing.creator),
      category: metadata.category ?? "", license: metadata.license ?? "", grants: JSON.parse(live.grants) as Grants,
      version: live.version, version_id: String(live.id), reach: live.reach,
      status: "approved",
      capabilities: requestedCapabilities(JSON.parse(live.grants)), sha256: live.sha256, bytes: live.bytes,
      updated_at: live.decided_at, reviewed_by: this.approvals(live.id).map((a) => a.gamertag).join(", "),
      publication: this.pipeline(live.id)?.publish_mode,
      // Public summaries omit private scanner findings and source evidence.
      scan: { state: p.state, completed_at: p.completed_at, report: report ? {
        deterministic: report.deterministic, policy: report.policy, validator: report.validator,
        ai: { verdict: report.ai.verdict, model: report.ai.model, prompt: report.ai.prompt },
      } : null },
      update_pending: this.sql.exec("SELECT 1 FROM mod_versions WHERE slug = ? AND status = 'submitted'", listing.slug)
        .toArray().length > 0,
    };
  }

  /** Every public listing, lowest reach first, most recently approved first within a reach. */
  mods(): MarketResult {
    const all = this.sql.exec<ListingRow>("SELECT * FROM mod_listings").toArray()
      .map((listing) => this.publicListing(listing)).filter((m) => m !== null);
    return ok(all.sort((a, b) => a.reach - b.reach || (b.updated_at ?? 0) - (a.updated_at ?? 0)));
  }

  mod(slug: string): MarketResult {
    const listing = this.listing(slug);
    const view = listing && this.publicListing(listing);
    if (!view) return fail(404, "No public mod with that name.");
    const history = this.versions("v.slug = ? AND v.status = 'approved' ORDER BY v.decided_at DESC", slug).map((v) => ({
      version: v.version, at: v.decided_at, pulled: !!v.pulled, reach: v.reach,
      reviewers: this.approvals(v.id).map((a) => a.gamertag),
      publication: this.pipeline(v.id)?.publish_mode,
      notes: (JSON.parse(this.pipeline(v.id)!.metadata) as { notes?: string }).notes ?? "",
    }));
    const live = this.liveVersion(slug)!;
    return ok({ ...view, history, release: live.signature ? { statement: this.statement(live.id), signature: live.signature } : null });
  }

  /** Public files require an actually signed, visible release. Quarantine has a separate staff-only route. */
  assetAllowed(sha256: string, caller: Caller, now: number): boolean {
    return this.versions(`v.sha256 = ? AND v.status = 'approved' AND v.signature IS NOT NULL AND v.statement IS NOT NULL AND v.pulled = 0
      AND l.hidden = 0 AND EXISTS (SELECT 1 FROM mod_pipeline p WHERE p.version_id = v.id AND p.state = 'complete')`, sha256)
      .some(v => !this.account(v.creator)?.suspended);
  }

  /** The canonical statement signed for an approved version. */
  statement(versionId: number): string {
    const v = this.versions("v.id = ?", versionId)[0]!;
    if (v.statement !== null) return v.statement;
    const approvers = this.approvals(v.id).map((a) => a.xuid);
    const p = this.pipeline(v.id)!;
    return JSON.stringify({ approved_at: v.decided_at, approvers, bytes: v.bytes, grants: JSON.parse(v.grants), sha256: v.sha256,
      slug: v.slug, version: v.version, metadata: JSON.parse(p.metadata), media: JSON.parse(p.media),
      policy: SCAN_POLICY, client_revision: CLIENT_REVISION, scan_job: p.job_id, publication: p.publish_mode });
  }

  /** Returns exact signed metadata for a still-public digest, including an older library selection. */
  release(slug: string, version: string, sha256: string): MarketResult {
    const listing = this.listing(slug);
    const v = this.versions("v.slug = ? AND v.version = ? AND v.sha256 = ? AND v.status = 'approved' AND v.signature IS NOT NULL AND v.statement IS NOT NULL AND v.pulled = 0", slug, version, sha256)[0];
    if (!listing || listing.hidden || this.account(listing.creator)?.suspended || !v || this.pipeline(v.id)?.state !== "complete") return fail(404, "No such release.");
    return ok({ release: { statement: this.statement(v.id), signature: v.signature } });
  }

  /** Atomically exposes a signed release after rechecking every gate following external I/O. */
  publish(versionId: number, statement: string, signature: string, now: number): boolean {
    if (!this.publicationReady(versionId, now) || this.statement(versionId) !== statement) return false;
    this.sql.exec("UPDATE mod_versions SET status = 'approved', statement = ?, signature = ? WHERE id = ?", statement, signature, versionId);
    const v = this.versions("v.id = ?", versionId)[0]!;
    this.log("system", "published", `${v.slug} ${v.version}`, this.pipeline(versionId)!.publish_mode!, now);
    return true;
  }

  /** Pulled versions with the reason staff gave, as the canonical body of the signed revocation list. */
  revocations(now: number): string {
    const revoked = this.sql.exec<{ slug: string; version: string; sha256: string; pull_reason: string }>(
      "SELECT slug, version, sha256, pull_reason FROM mod_versions WHERE pulled = 1 ORDER BY id").toArray()
      .map((v) => ({ slug: v.slug, version: v.version, sha256: v.sha256, reason: v.pull_reason }));
    return JSON.stringify({ issued_at: now, expires_at: now + 15 * 60_000, revoked });
  }

  // --- Player writes -------------------------------------------------------------------------------------

  /** Adds a public mod's current version to the player's library. */
  send(caller: Caller, slug: string, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    const listing = this.listing(slug);
    const live = listing && !listing.hidden && !this.account(listing.creator)?.suspended ? this.liveVersion(slug) : undefined;
    if (!live) return fail(404, "No public mod with that name.");
    const xuid = session.account.xuid;
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_library WHERE xuid = ? AND slug != ?", xuid, slug).one().n;
    if (count >= MAX_LIBRARY) return fail(409, "Your library is full. Remove a mod from your library first.");
    const sentAt = this.sql.exec<{ sent_at: number }>(`INSERT INTO mod_library_clock (xuid, sent_at) VALUES (?, ?)
      ON CONFLICT (xuid) DO UPDATE SET sent_at = MAX(excluded.sent_at, mod_library_clock.sent_at + 1)
      RETURNING sent_at`, xuid, now).one().sent_at;
    this.sql.exec(`INSERT INTO mod_library (xuid, slug, version_id, sent_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (xuid, slug) DO UPDATE SET version_id = excluded.version_id, sent_at = excluded.sent_at`, xuid, slug, live.id, sentAt);
    return ok({ queued: true, version: live.version }, { notify: [xuid] });
  }

  /** Authorizes a browser removal and broadcasts only a successfully removed exact selection. */
  removeSelection(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const at = typeof body.sent_at === "string" && body.sent_at.length <= 32 ? Date.parse(body.sent_at) : NaN;
    if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256) || !Number.isSafeInteger(at)
      || new Date(at).toISOString() !== body.sent_at) return fail(422, "Choose a library selection with its hash and send timestamp.");
    const xuid = session.account.xuid;
    if (!this.removeLibrary(xuid, slug, body.sha256, String(body.sent_at))) {
      return fail(409, "Your library changed. Review the current selection and try again.");
    }
    return ok({ removed: true }, { notify: [xuid] });
  }

  /** Removes only the authenticated account's exact send request; stale removals cannot erase a later send. */
  removeLibrary(xuid: string, slug: string, sha256: string, sentAt: string): boolean {
    const at = Date.parse(sentAt);
    if (!Number.isSafeInteger(at)) return false;
    return this.sql.exec(`DELETE FROM mod_library WHERE xuid = ? AND slug = ? AND sent_at = ?
      AND version_id IN (SELECT id FROM mod_versions WHERE slug = ? AND sha256 = ?)`, xuid, slug, at, slug, sha256).rowsWritten > 0;
  }

  report(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    const listing = this.listing(slug);
    const live = listing && this.liveVersion(slug);
    if (!live) return fail(404, "No public mod with that name.");
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (typeof body.reason !== "string" || !REPORT_REASONS.includes(body.reason)) return fail(400, "Choose a reason.");
    const details = typeof body.details === "string" ? body.details.trim() : "";
    if (details.length < 10) return fail(400, "Describe what happened in a sentence or two.");
    const xuid = session.account.xuid;
    const recent = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_reports WHERE reporter = ? AND at > ?",
      xuid, now - 86_400_000).one().n;
    if (recent >= MAX_REPORTS_PER_DAY) return fail(429, "You've sent a lot of reports today. Try again tomorrow.");
    this.sql.exec("INSERT INTO mod_reports (slug, version, reporter, reason, details, at) VALUES (?, ?, ?, ?, ?, ?)",
      slug, live.version, xuid, body.reason, details.slice(0, 1000), now);
    return ok({ received: true });
  }

  mine(caller: Caller, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session) return fail(401, "Sign in with Microsoft first.");
    return ok(this.versions("l.creator = ? ORDER BY v.submitted_at DESC", session.account.xuid).map((v) => this.versionView(v)));
  }

  /** Checks a submission before its file is stored, so a refused listing costs no upload. */
  precheck(caller: Caller, listingInput: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    const pending = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug
      WHERE l.creator = ? AND v.status = 'submitted'`, session.account.xuid).one().n;
    if (pending >= MAX_PENDING_SUBMISSIONS) return fail(429, "You have five versions waiting for review. Wait for a decision first.");
    const { fields, errors } = validateListing(listingInput, 0);
    if (Object.keys(errors).length) return fail(422, "Check the highlighted fields.", errors);
    const existing = this.listing(fields.slug);
    if (existing && existing.creator !== session.account.xuid) {
      return fail(409, "That name is taken.", { slug: "Another creator owns this name." });
    }
    if (this.sql.exec("SELECT 1 FROM mod_versions WHERE slug = ? AND version = ?", fields.slug, fields.version).toArray().length) {
      return fail(409, "That version exists.", { version: "Bump the version to submit again." });
    }
    return ok({});
  }

  /** Records a submitted version whose file is already stored under its SHA-256. */
  submit(caller: Caller, listingInput: unknown, file: { sha256: string; bytes: number; grants: Grants | null; media?: MediaFile[] }, now: number): MarketResult {
    const checked = this.precheck(caller, listingInput, now);
    if (checked.status !== 200) return checked;
    const session = this.writer(caller, now) as { account: Account };
    const grants = file.grants ?? {};
    const reach = reachOf(grants);
    const { fields, errors } = validateListing(listingInput, reach);
    if (Object.keys(errors).length) return fail(422, "Check the highlighted fields.", errors);
    // Durable Object storage commits the synchronous writes of one turn atomically.
    this.sql.exec(`INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`,
      fields.slug, session.account.xuid, fields.name, fields.summary, fields.description, fields.source, now);
    const id = this.sql.exec<{ id: number }>(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?) RETURNING id`,
      fields.slug, fields.version, file.sha256, file.bytes, JSON.stringify(grants), reach, now).one().id;
    const baseline = this.liveVersion(fields.slug)?.id ?? null;
    this.sql.exec(`INSERT INTO mod_pipeline (version_id, metadata, media, baseline, job_id) VALUES (?, ?, ?, ?, ?)`,
      id, JSON.stringify(fields), JSON.stringify(file.media ?? []), baseline, crypto.randomUUID());
    return ok(this.versionView(this.versions("v.id = ?", id)[0]!));
  }

  /** Authenticate before consuming any upload bytes. */
  uploadAllowed(caller: Caller, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    this.sql.exec("DELETE FROM mod_upload_attempts WHERE at <= ?", now - 3_600_000);
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_upload_attempts WHERE creator = ?", session.account.xuid).one().n >= 20) {
      return fail(429, "Upload limit reached. Try again in an hour.");
    }
    this.sql.exec("INSERT INTO mod_upload_attempts (creator, at) VALUES (?, ?)", session.account.xuid, now);
    return ok({});
  }

  /** Load the immutable release snapshot and its current scanner lease/evidence. */
  private pipeline(id: number): PipelineRow | undefined {
    return this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE version_id = ?", id).toArray()[0];
  }

  /** Media descriptors belong to the immutable version, not mutable listing metadata. */
  media(id: number): MediaFile[] { return JSON.parse(this.pipeline(id)?.media ?? "[]") as MediaFile[]; }

  /** Pending screenshots are visible only to their creator or active staff, under an authenticated no-store route. */
  privateMedia(caller: Caller, id: number, sha256: string, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session || session.account.suspended) return fail(404, "No such image.");
    const v = this.versions("v.id = ?", id)[0];
    const media = this.media(id).find(item => item.sha256 === sha256);
    if (!v || !media || (v.creator !== session.account.xuid && !atLeast(session.account, "moderator"))) return fail(404, "No such image.");
    return ok({ key: `media/${media.sha256}`, type: media.type });
  }

  /** Check public media authorization without revealing another version's private files. */
  mediaAllowed(sha256: string): boolean {
    return this.versions("v.status = 'approved' AND v.signature IS NOT NULL AND v.statement IS NOT NULL AND v.pulled = 0 AND l.hidden = 0")
      .some(v => !this.account(v.creator)?.suspended && this.pipeline(v.id)?.state === "complete"
        && this.media(v.id).some(m => m.sha256 === sha256));
  }

  /** SQL jobs are a transactional outbox: creation commits with the version, independent of scanner availability. */
  claimScan(now: number): MarketResult {
    this.sql.exec(`UPDATE mod_pipeline SET state = 'failed', lease = NULL, lease_until = NULL
      WHERE state IN ('queued', 'running') AND attempts >= ? AND (lease_until IS NULL OR lease_until <= ?)`, MAX_SCAN_ATTEMPTS, now);
    const p = this.sql.exec<PipelineRow>(`SELECT p.* FROM mod_pipeline p JOIN mod_versions v ON v.id = p.version_id
      WHERE v.status = 'submitted' AND (p.state = 'queued' OR (p.state = 'running' AND p.lease_until <= ?))
      AND p.attempts < ? ORDER BY p.version_id LIMIT 1`, now, MAX_SCAN_ATTEMPTS).toArray()[0];
    if (!p) return ok({ job: null });
    const lease = crypto.randomUUID();
    this.sql.exec("UPDATE mod_pipeline SET state = 'running', lease = ?, lease_until = ?, attempts = attempts + 1 WHERE version_id = ?",
      lease, now + SCAN_LEASE_MS, p.version_id);
    const v = this.versions("v.id = ?", p.version_id)[0]!;
    const previous = p.baseline === null ? null : this.versions("v.id = ?", p.baseline)[0];
    return ok({ job: { id: p.job_id, lease, version_id: v.id, sha256: v.sha256, bytes: v.bytes, policy: SCAN_POLICY,
      listing: JSON.parse(p.metadata), grants: JSON.parse(v.grants), media: this.media(v.id),
      previous: previous ? { sha256: previous.sha256, grants: JSON.parse(previous.grants),
        report: JSON.parse(this.pipeline(previous.id)?.report ?? "null") } : null } });
  }

  /** A scanner can read only files attached to its current, unexpired claim. It cannot list the bucket. */
  scanFile(job: string, lease: string, sha256: string, now: number): MarketResult {
    const p = this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE job_id = ? AND lease = ? AND state = 'running' AND lease_until > ?",
      job, lease, now).toArray()[0];
    const v = p && this.versions("v.id = ?", p.version_id)[0];
    const media = p && this.media(p.version_id).find(m => m.sha256 === sha256);
    if (!v || (v.sha256 !== sha256 && !media)) return fail(404, "No claimed file.");
    return ok({ key: `${media ? "media" : "mods"}/${sha256}`, type: media?.type ?? "application/wasm", legacy: !!p!.legacy });
  }

  /** Deduplicate completion and reject stale leases, wrong hashes, malformed reports and outdated policy. */
  completeScan(job: string, lease: string, input: unknown, now: number): MarketResult {
    const p = this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE job_id = ?", job).toArray()[0];
    if (!p || p.lease !== lease) return fail(409, "Stale scan claim.");
    const v = this.versions("v.id = ?", p.version_id)[0]!;
    const report = parseScanReport(input, v.sha256, this.media(v.id).map(m => m.sha256));
    if (!report) return fail(422, "Invalid scan attestation.");
    if (p.state === "complete" || p.state === "failed") {
      return p.report === JSON.stringify(report) ? ok({ received: true, duplicate: true }) : fail(409, "Scan already completed.");
    }
    if (p.state !== "running" || !p.lease_until || p.lease_until <= now || v.status !== "submitted") return fail(409, "Stale scan claim.");
    const failed = report.deterministic === "error" || report.ai.verdict === "error";
    this.sql.exec("UPDATE mod_pipeline SET state = ?, report = ?, completed_at = ? WHERE version_id = ?",
      failed ? "failed" : "complete", JSON.stringify(report), now, v.id);
    if (this.automaticAllowed(v, now)) {
      this.sql.exec("UPDATE mod_pipeline SET publish_mode = 'automatic' WHERE version_id = ?", v.id);
      this.sql.exec("UPDATE mod_versions SET decided_at = ?, note = 'Established creator; checks passed' WHERE id = ?", now, v.id);
      return ok({ received: true, automatic: true }, { approved: v.id });
    }
    return ok({ received: true, automatic: false });
  }

  /** Evaluate live trust and the exact prior release again, including after signing or storage I/O. */
  private automaticAllowed(v: VersionRow, now: number): boolean {
    const p = this.pipeline(v.id)!;
    const listing = this.listing(v.slug)!;
    const creator = this.account(v.creator);
    const report = p.report ? JSON.parse(p.report) as ScanReport : null;
    if (v.status !== "submitted" || v.pulled || v.reach >= 3 || listing.hidden || !creator || creator.suspended
      || p.state !== "complete" || !scanReady(report, p.completed_at, now) || report!.ai.verdict !== "clear") return false;
    const trusted = this.sql.exec("SELECT 1 FROM mod_trust WHERE slug = ? AND creator = ? AND expires_at > ?",
      v.slug, v.creator, now).toArray().length > 0;
    const baseline = this.liveVersion(v.slug);
    if (!trusted || !baseline || baseline.id !== p.baseline || baseline.pulled) return false;
    if (this.sql.exec("SELECT 1 FROM mod_reports WHERE slug = ? AND status = 'open'", v.slug).toArray().length) return false;
    const prior = this.pipeline(baseline.id);
    const priorReport = prior?.report ? JSON.parse(prior.report) as ScanReport : null;
    if (!priorReport || priorReport.policy !== SCAN_POLICY || priorReport.client_revision !== CLIENT_REVISION || priorReport.deterministic !== "pass") return false;
    if (grantDiff(JSON.parse(baseline.grants), JSON.parse(v.grants)).expanded) return false;
    // New host interfaces are authority changes even if the declaration did not change.
    if (report!.imports.some(name => !priorReport.imports.includes(name))) return false;
    // Listing/source/media edits get a human content review at launch.
    const before = JSON.parse(prior!.metadata) as Record<string, unknown>;
    const after = JSON.parse(p.metadata) as Record<string, unknown>;
    if (["name", "summary", "description", "source", "category", "license"].some(key => before[key] !== after[key]) || prior!.media !== p.media) return false;
    return true;
  }

  /** Return publication material only while current scan, account and decision gates still hold. */
  publicationReady(id: number, now: number): { sha256: string; media: MediaFile[]; statement: string; legacy: boolean } | null {
    const v = this.versions("v.id = ?", id)[0];
    const p = this.pipeline(id);
    if (!v || !p || v.status !== "submitted" || v.pulled || this.account(v.creator)?.suspended || this.listing(v.slug)?.hidden
      || p.state !== "complete" || !scanReady(p.report ? JSON.parse(p.report) as ScanReport : null, p.completed_at, now)) return null;
    if (p.publish_mode === "automatic") {
      if (!this.automaticAllowed(v, now)) return null;
    } else if (p.publish_mode === "manual") {
      const approvals = this.approvals(id).filter(a => {
        const actor = this.account(a.xuid);
        return actor && !actor.suspended && atLeast(actor, "moderator") && actor.xuid !== v.creator;
      }).map(a => ({ admin: atLeast(this.account(a.xuid), "admin") }));
      if (!approvalsComplete(v.reach as Reach, approvals)) return null;
    } else return null;
    return { sha256: v.sha256, media: this.media(id), statement: this.statement(id), legacy: !!p.legacy };
  }

  /** Retry jobs with a new identity, invalidating old scanner leases and all earlier approvals. */
  rescan(caller: Caller, id: number, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const v = this.versions("v.id = ?", id)[0];
    if (!v || v.status !== "submitted") return fail(409, "Only pending releases can be rescanned.");
    this.sql.exec(`UPDATE mod_pipeline SET job_id = ?, state = 'queued', attempts = 0, lease = NULL,
      lease_until = NULL, report = NULL, completed_at = NULL, publish_mode = NULL WHERE version_id = ?`, crypto.randomUUID(), id);
    this.sql.exec("DELETE FROM mod_approvals WHERE version_id = ?", id);
    this.log(staff.xuid, "rescan", `${v.slug} ${v.version}`, "New scan job", now);
    return ok(this.versionView(v));
  }

  /** Admins explicitly grant revocable, project-scoped trust after at least one human-approved release. */
  setTrust(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended || !atLeast(session.account, "admin")) return fail(403, "Only admins manage creator trust.");
    if (session.created_at + ROLE_CHANGE_SIGN_IN_MS <= now) return fail(401, "Sign in again before changing trust.");
    const listing = this.listing(slug);
    if (!listing) return fail(404, "No such mod.");
    if (listing.creator === session.account.xuid) return fail(403, "You can't establish your own trust.");
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (!reason || typeof body.trusted !== "boolean") return fail(422, "Supply trusted and an audit reason.");
    if (body.trusted) {
      const baseline = this.liveVersion(slug);
      const humanApproved = this.sql.exec(`SELECT 1 FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
        WHERE v.slug = ? AND v.status = 'approved' AND p.publish_mode = 'manual' AND v.pulled = 0 LIMIT 1`, slug).toArray().length;
      if (!baseline || !humanApproved || listing.hidden || this.account(listing.creator)?.suspended) {
        return fail(409, "A visible human-approved release and active creator are required.");
      }
      this.sql.exec(`INSERT INTO mod_trust (slug, creator, granted_by, expires_at, reason) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (slug) DO UPDATE SET creator = excluded.creator, granted_by = excluded.granted_by,
        expires_at = excluded.expires_at, reason = excluded.reason`, slug, listing.creator, session.account.xuid, now + 90 * 86_400_000, reason);
    } else this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", slug);
    this.log(session.account.xuid, body.trusted ? "established creator" : "revoked trust", slug, reason, now);
    return ok({ trusted: body.trusted });
  }

  // --- Staff ---------------------------------------------------------------------------------------------

  private versionView(v: VersionRow) {
    const listing = this.listing(v.slug)!;
    const p = this.pipeline(v.id)!;
    const metadata = JSON.parse(p.metadata) as ListingRow & { category?: string; license?: string; notes?: string };
    const report = p.report ? JSON.parse(p.report) as ScanReport : null;
    const trust = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM mod_trust WHERE slug = ? AND creator = ?", v.slug, v.creator).toArray()[0];
    const previous = p.baseline === null ? undefined : this.versions("v.id = ?", p.baseline)[0];
    const grants = JSON.parse(v.grants) as Grants;
    return {
      id: String(v.id), slug: v.slug, version: v.version, grants, reach: v.reach, status: v.status, note: v.note,
      creator: v.creator, creator_name: this.name(v.creator), sha256: v.sha256, bytes: v.bytes,
      submitted_at: v.submitted_at, decided_at: v.decided_at, pulled: !!v.pulled, pull_reason: v.pull_reason,
      name: metadata.name, summary: metadata.summary, description: metadata.description, source: metadata.source, hidden: !!listing.hidden,
      category: metadata.category ?? "", license: metadata.license ?? "", notes: metadata.notes ?? "",
      trust: { trusted: !!trust && trust.expires_at > Date.now(), expires_at: trust?.expires_at ?? null },
      gallery: this.media(v.id), scan: { state: p.state, attempts: p.attempts, job: p.job_id,
        completed_at: p.completed_at, expires_at: p.completed_at === null ? null : p.completed_at + SCAN_MAX_AGE_MS,
        review_ready: p.state === "complete" && scanReady(report, p.completed_at, Date.now()), report }, publication: p.publish_mode,
      capabilities: requestedCapabilities(grants), rule: approvalRule(v.reach as Reach), approvals: this.approvals(v.id),
      previous: previous ? { version: previous.version, sha256: previous.sha256, grants: JSON.parse(previous.grants) as Grants,
        diff: grantDiff(JSON.parse(previous.grants), grants) } : null,
    };
  }

  queue(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    return ok(this.versions("v.status = 'submitted' ORDER BY v.reach DESC, v.submitted_at ASC").map((v) => this.versionView(v)));
  }

  version(caller: Caller, id: number, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    const v = this.versions("v.id = ?", id)[0];
    return v ? ok(this.versionView(v)) : fail(404, "No such version.");
  }

  /** Records an approval, rejection or change request; approvals publish once the reach's rule is met. */
  decide(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const v = this.versions("v.id = ?", id)[0];
    if (!v) return fail(404, "No such version.");
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
    const state: ReviewState = { creator: v.creator, status: v.status, reach: v.reach as Reach,
      approvals: this.approvals(v.id).map((a) => ({ xuid: a.xuid, admin: a.admin })) };
    const target = `${v.slug} ${v.version}`;
    if (body.decision === "approve") {
      const allowed = canApprove(staff, state);
      if (!allowed.ok) return fail(403, allowed.reason);
      const p = this.pipeline(v.id)!;
      const report = p.report ? JSON.parse(p.report) as ScanReport : null;
      if (p.state !== "complete" || !scanReady(report, p.completed_at, now)) return fail(409, "A current, complete scan must pass before approval. Rescan failed or expired jobs.");
      if (report!.ai.verdict === "flag" && !note) return fail(422, "Explain how the flagged findings were resolved before approving.");
      if (this.account(v.creator)?.suspended || this.listing(v.slug)?.hidden) return fail(409, "Restore the creator and listing before approving.");
      this.sql.exec("INSERT INTO mod_approvals (version_id, xuid, admin, at) VALUES (?, ?, ?, ?)", v.id, staff.xuid,
        atLeast(staff, "admin") ? 1 : 0, now);
      const approvals = [...state.approvals, { xuid: staff.xuid, admin: atLeast(staff, "admin") }];
      const done = approvalsComplete(state.reach, approvals);
      if (done) {
        this.sql.exec("UPDATE mod_versions SET decided_at = ?, note = ? WHERE id = ?", now, note, v.id);
        this.sql.exec("UPDATE mod_pipeline SET publish_mode = 'manual' WHERE version_id = ?", v.id);
      }
      this.log(staff.xuid, done ? "approved" : `approved (${approvals.length} of ${approvalRule(state.reach).count})`, target, note, now);
      return ok(this.versionView(this.versions("v.id = ?", v.id)[0]!), done ? { approved: v.id } : {});
    }
    if (body.decision !== "reject" && body.decision !== "changes") return fail(400, "Unknown decision.");
    const allowed = canReview(staff, state);
    if (!allowed.ok) return fail(403, allowed.reason);
    if (!note) return fail(400, "Tell the creator why.");
    const status = body.decision === "reject" ? "rejected" : "changes";
    this.sql.exec("UPDATE mod_versions SET status = ?, decided_at = ?, note = ? WHERE id = ?", status, now, note, v.id);
    this.log(staff.xuid, status === "rejected" ? "rejected" : "requested changes", target, note, now);
    return ok(this.versionView(this.versions("v.id = ?", v.id)[0]!));
  }

  /** Withdraws a published version; every player holding it is told the reason. */
  pull(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    if (!atLeast(staff, "admin")) return fail(403, "Only admins can pull a published version.");
    const v = this.versions("v.id = ?", id)[0];
    if (!v || v.status !== "approved" || v.pulled) return fail(404, "Only published versions can be pulled.");
    const reason = typeof (input as { reason?: unknown })?.reason === "string" ? ((input as { reason: string }).reason).trim() : "";
    if (!reason) return fail(400, "Say why it's being pulled.");
    this.sql.exec("UPDATE mod_versions SET pulled = 1, pull_reason = ? WHERE id = ?", reason.slice(0, 500), v.id);
    this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", v.slug);
    this.log(staff.xuid, "pulled", `${v.slug} ${v.version}`, reason, now);
    const holders = this.sql.exec<{ xuid: string }>("SELECT xuid FROM mod_library WHERE version_id = ?", v.id).toArray().map((r) => r.xuid);
    return ok(this.versionView(this.versions("v.id = ?", v.id)[0]!), { notify: holders });
  }

  hide(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    if (!this.listing(slug)) return fail(404, "No such mod.");
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return fail(400, "Note why, for the audit log.");
    const hidden = body.hidden === true;
    this.sql.exec("UPDATE mod_listings SET hidden = ? WHERE slug = ?", hidden ? 1 : 0, slug);
    if (hidden) this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", slug);
    this.log(staff.xuid, hidden ? "hid listing" : "restored listing", slug, reason, now);
    return ok({ hidden });
  }

  reports(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    const rows = this.sql.exec<{ id: number; slug: string; version: string; reporter: string; reason: string; details: string;
      at: number; status: string; resolution: string; resolved_by: string | null }>(
      "SELECT * FROM mod_reports ORDER BY status = 'open' DESC, at DESC LIMIT 200").toArray();
    return ok(rows.map((r) => {
      const v = this.versions("v.slug = ? AND v.version = ?", r.slug, r.version)[0];
      return { ...r, id: String(r.id), reporter_name: this.name(r.reporter), name: this.listing(r.slug)?.name ?? r.slug,
        resolved_by_name: r.resolved_by ? this.name(r.resolved_by) : "", version_id: v ? String(v.id) : null, pulled: !!v?.pulled };
    }));
  }

  resolve(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const report = this.sql.exec<{ slug: string; version: string }>("SELECT slug, version FROM mod_reports WHERE id = ?", id).toArray()[0];
    if (!report) return fail(404, "No such report.");
    const note = typeof (input as { note?: unknown })?.note === "string" ? ((input as { note: string }).note).trim() : "";
    if (!note) return fail(400, "Write what you found.");
    this.sql.exec("UPDATE mod_reports SET status = 'resolved', resolution = ?, resolved_by = ? WHERE id = ?", note.slice(0, 1000), staff.xuid, id);
    this.log(staff.xuid, "resolved report", `${report.slug} ${report.version}`, note, now);
    return ok({ id: String(id), status: "resolved" });
  }

  people(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    const rows = this.sql.exec<{ xuid: string }>("SELECT xuid FROM market_accounts WHERE role != 'player' OR suspended = 1").toArray()
      .map((r) => r.xuid);
    for (const owner of this.owners) if (!rows.includes(owner)) rows.push(owner);
    return ok(rows.map((xuid) => this.account(xuid)).filter((a): a is Account => a !== null)
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.gamertag.localeCompare(b.gamertag)));
  }

  /** Changes a signed-in player's role; needs a fresh sign-in and a reason. */
  setRole(caller: Caller, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const gamertag = typeof body.gamertag === "string" ? body.gamertag.trim() : "";
    const xuid = this.sql.exec<{ xuid: string }>("SELECT xuid FROM market_accounts WHERE gamertag = ? COLLATE NOCASE", gamertag).toArray()[0]?.xuid;
    const target = xuid ? this.account(xuid) : null;
    if (!target) return fail(404, "No Cinnabar account with that gamertag has signed in yet.");
    const role = body.role as Role;
    if (!ROLES.includes(role)) return fail(400, "Choose a role.");
    const allowed = canSetRole(session.account, target, role);
    if (!allowed.ok) return fail(403, allowed.reason);
    if (session.created_at + ROLE_CHANGE_SIGN_IN_MS <= now) return fail(401, "For safety, sign out and sign in again before changing roles.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return fail(400, "Note why, for the audit log.");
    this.sql.exec("UPDATE market_accounts SET role = ? WHERE xuid = ?", role, target.xuid);
    if (role === "player") this.sql.exec("DELETE FROM web_sessions WHERE xuid = ?", target.xuid);
    this.log(session.account.xuid, "changed role", `${target.gamertag}: ${target.role} → ${role}`, reason, now);
    return ok(this.account(target.xuid));
  }

  /** Suspends or restores a player: they can't submit, send or review while suspended. */
  suspend(caller: Caller, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    if (!atLeast(staff, "admin")) return fail(403, "Only admins can suspend accounts.");
    const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const xuid = this.sql.exec<{ xuid: string }>("SELECT xuid FROM market_accounts WHERE gamertag = ? COLLATE NOCASE",
      typeof body.gamertag === "string" ? body.gamertag.trim() : "").toArray()[0]?.xuid;
    const target = xuid ? this.account(xuid) : null;
    if (!target) return fail(404, "No Cinnabar account with that gamertag has signed in yet.");
    if (target.xuid === staff.xuid || atLeast(target, "admin") && !atLeast(staff, "owner")) return fail(403, "You can't suspend this account.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return fail(400, "Note why, for the audit log.");
    const suspended = body.suspended === true;
    this.sql.exec("UPDATE market_accounts SET suspended = ? WHERE xuid = ?", suspended ? 1 : 0, target.xuid);
    if (suspended) this.sql.exec("DELETE FROM mod_trust WHERE creator = ?", target.xuid);
    this.log(staff.xuid, suspended ? "suspended" : "restored", target.gamertag, reason, now);
    return ok(this.account(target.xuid));
  }

  audit(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    return ok(this.sql.exec<{ at: number; actor: string; action: string; target: string; note: string }>(
      "SELECT at, actor, action, target, note FROM staff_audit ORDER BY id DESC LIMIT 200").toArray()
      .map((e) => ({ ...e, actor_name: this.name(e.actor) })));
  }

  /** Recover interrupted promotions using the same gate used by immediate publication. */
  pendingPublications(): number[] {
    return this.sql.exec<{ id: number }>(`SELECT v.id FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
      WHERE v.status = 'submitted' AND p.publish_mode IS NOT NULL ORDER BY p.promotion_attempt_at, v.id LIMIT 10`).toArray().map(v => v.id);
  }

  /** Failed or no-longer-eligible candidates move behind other recoverable releases. */
  promotionAttempt(id: number, now: number): void {
    this.sql.exec("UPDATE mod_pipeline SET promotion_attempt_at = ? WHERE version_id = ?", now, id);
  }
}

/** One marketplace request from the Worker, carrying the caller's session hash and CSRF header. */
export type MarketCall = Caller & (
  | { op: "release"; slug: string; version: string; sha256: string }
  | { op: "me" } | { op: "mods" } | { op: "mod"; slug: string } | { op: "mine" } | { op: "queue" } | { op: "reports" }
  | { op: "people" } | { op: "audit" } | { op: "signout" }
  | { op: "send"; slug: string } | { op: "remove"; slug: string; body: unknown } | { op: "report"; slug: string; body: unknown }
  | { op: "upload-auth" } | { op: "precheck"; body: unknown } | { op: "submit"; body: unknown; file: { sha256: string; bytes: number; grants: Grants | null; media?: MediaFile[] } }
  | { op: "version"; id: number } | { op: "decide"; id: number; body: unknown } | { op: "pull"; id: number; body: unknown }
  | { op: "hide"; slug: string; body: unknown } | { op: "resolve"; id: number; body: unknown }
  | { op: "role"; body: unknown } | { op: "suspend"; body: unknown } | { op: "asset"; sha256: string }
  | { op: "media"; sha256: string } | { op: "trust"; slug: string; body: unknown } | { op: "rescan"; id: number }
  | { op: "private-media"; id: number; sha256: string }
  | { op: "scan-claim" } | { op: "scan-file"; job: string; lease: string; sha256: string }
  | { op: "scan-complete"; job: string; lease: string; body: unknown }
  | { op: "begin"; state: string; verifier: string; returnTo: string } | { op: "consume"; state: string }
  | { op: "signin"; xuid: string; gamertag: string; newSession: string; newCsrf: string }
);

/** Routes one call to the store. */
export function handle(store: MarketplaceStore, call: MarketCall, now: number): MarketResult {
  switch (call.op) {
    case "me": return store.me(call, now);
    case "mods": return store.mods();
    case "mod": return store.mod(call.slug);
    case "release": return store.release(call.slug, call.version, call.sha256);
    case "mine": return store.mine(call, now);
    case "queue": return store.queue(call, now);
    case "reports": return store.reports(call, now);
    case "people": return store.people(call, now);
    case "audit": return store.audit(call, now);
    case "send": return store.send(call, call.slug, now);
    case "remove": return store.removeSelection(call, call.slug, call.body, now);
    case "report": return store.report(call, call.slug, call.body, now);
    case "precheck": return store.precheck(call, call.body, now);
    case "upload-auth": return store.uploadAllowed(call, now);
    case "submit": return store.submit(call, call.body, call.file, now);
    case "version": return store.version(call, call.id, now);
    case "decide": return store.decide(call, call.id, call.body, now);
    case "pull": return store.pull(call, call.id, call.body, now);
    case "hide": return store.hide(call, call.slug, call.body, now);
    case "resolve": return store.resolve(call, call.id, call.body, now);
    case "role": return store.setRole(call, call.body, now);
    case "suspend": return store.suspend(call, call.body, now);
    case "asset": return ok({ allowed: store.assetAllowed(call.sha256, call, now) });
    case "media": return ok({ allowed: store.mediaAllowed(call.sha256) });
    case "private-media": return store.privateMedia(call, call.id, call.sha256, now);
    case "trust": return store.setTrust(call, call.slug, call.body, now);
    case "rescan": return store.rescan(call, call.id, now);
    case "scan-claim": return store.claimScan(now);
    case "scan-file": return store.scanFile(call.job, call.lease, call.sha256, now);
    case "scan-complete": return store.completeScan(call.job, call.lease, call.body, now);
    case "begin":
      store.beginSignIn(call.state, call.verifier, call.returnTo, now);
      return ok({});
    case "consume": {
      const pending = store.consumeSignIn(call.state, now);
      return pending ? ok(pending) : fail(400, "This sign-in link expired. Try again.");
    }
    case "signin":
      store.signIn(call.xuid, call.gamertag, call.newSession, call.newCsrf, now);
      return ok({});
    case "signout":
      return store.signOut(call, now);
  }
}
