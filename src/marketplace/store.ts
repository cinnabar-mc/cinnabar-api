import { equalHash, type ProviderIdentity } from "./auth";
import { compareVersions, type ModLibraryEntry } from "../protocol";
import type { MarketplaceUpdateQuery } from "./updates";
import { canonicalRelease, type ModRelease } from "../mod-releases";
import { OFFICIAL_CREATOR, OFFICIAL_POLICY, OFFICIAL_SLUG } from "./official";
import {
  ROLES, STAFF_MANAGERS_ONLY, approvalRule, approvalsComplete, atLeast, canApprove, canReview, canSetRole, clip, fieldsOf, grantDiff,
  malformedText, managesStaff, reachOf, requestedCapabilities, trimmed, validateListing, type Actor, type Grants, type ListingFields,
  type Reach, type ReviewState, type Role,
} from "./policy";
import { revocationBody, withinRevocationBudget, type RevokedRow } from "./revocations";
import { API_REVISION, CLIENT_REVISION, MAX_SCAN_ATTEMPTS, SCAN_LEASE_MS, SCAN_MAX_AGE_MS, SCAN_POLICY, parseScanReport, scanReady, type ScanReport } from "./scanning";

export const PLAYER_SESSION_MS = 30 * 24 * 3_600_000;
const STAFF_SESSION_MS = 12 * 3_600_000;
/** Role changes need a sign-in this recent. */
const ROLE_CHANGE_SIGN_IN_MS = 10 * 60_000;
const MAX_PENDING_SUBMISSIONS = 5;
const MAX_REPORTS_PER_DAY = 10;
const MAX_LIBRARY = 100;
const REPORT_REASONS = ["broken", "advantage", "malicious", "stolen", "other"];
const MALFORMED_TEXT = "Use valid Unicode text.";
const SIGN_IN_FIRST = "Sign in to Cinnabar first.";
const NO_SUCH_IMAGE = "No such image.";

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
  display_name: string;
  email: string;
  email_verified: boolean;
}
type SessionRow = {
  account_id: string;
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
  api_revision: string | null;
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
/** A submitted component already stored under its SHA-256, with the grants read from its bytes and its images. */
export interface SubmittedFile { sha256: string; bytes: number; grants: Grants | null; media: MediaFile[] }
type PipelineRow = {
  version_id: number; metadata: string; media: string; baseline: number | null;
  job_id: string; state: "queued" | "running" | "complete" | "failed";
  attempts: number; lease: string | null; lease_until: number | null;
  report: string | null; completed_at: number | null; publish_mode: "manual" | "automatic" | "official" | null; promotion_attempt_at: number;
};

const ok = (body: unknown, extra: Partial<MarketResult> = {}): MarketResult => ({ status: 200, body, ...extra });
const fail = (status: number, error: string, fields?: Record<string, string>): MarketResult =>
  ({ status, body: fields ? { error, fields } : { error } });
const reportOf = (p: PipelineRow): ScanReport | null => p.report ? JSON.parse(p.report) as ScanReport : null;
/** Parses stored JSON with every string value made well-formed, so legacy rows can't put lone surrogates in signed bodies. */
const parseWellFormed = (json: string): unknown => JSON.parse(json, (_, value) => typeof value === "string" ? value.toWellFormed() : value);

/** A version's listing snapshot; snapshots migrated from before category, license and notes read them as "". */
const snapshotOf = (p: PipelineRow): ListingFields => ({ category: "", license: "", notes: "", ...JSON.parse(p.metadata) });
/** Public versions have a signature and completed scan or recorded official approval; revoked official bytes stay withdrawn. */
const PUBLISHED = `v.status = 'approved' AND v.signature IS NOT NULL AND v.statement IS NOT NULL AND v.pulled = 0
  AND EXISTS (SELECT 1 FROM mod_pipeline p WHERE p.version_id = v.id AND p.state = 'complete'
    AND (COALESCE(p.publish_mode, '') != 'official' OR (v.slug = '${OFFICIAL_SLUG}' AND EXISTS
      (SELECT 1 FROM mod_official_releases o WHERE o.version_id = v.id))))
  AND NOT EXISTS (SELECT 1 FROM mod_versions revoked WHERE revoked.slug = '${OFFICIAL_SLUG}'
    AND revoked.sha256 = v.sha256 AND revoked.pulled = 1)`;

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
        promotion_attempt_at INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS market_schema (version INTEGER PRIMARY KEY)`,
      `CREATE TABLE IF NOT EXISTS mod_trust (slug TEXT PRIMARY KEY, creator TEXT NOT NULL, granted_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL, reason TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS mod_pipeline_queue ON mod_pipeline (state, lease_until)`,
      `CREATE TABLE IF NOT EXISTS mod_upload_attempts (creator TEXT NOT NULL, at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS mod_upload_creator ON mod_upload_attempts (creator, at)`,
      // Public file checks look a digest up directly instead of scanning every release.
      `CREATE INDEX IF NOT EXISTS mod_versions_sha256 ON mod_versions (sha256)`,
      `CREATE TABLE IF NOT EXISTS mod_media (sha256 TEXT NOT NULL, version_id INTEGER NOT NULL, PRIMARY KEY (sha256, version_id))`,
    ]) sql.exec(statement);
    /** Runs `statements` once, recording `version` in market_schema. */
    const migrate = (version: number, ...statements: string[]) => {
      if (sql.exec("SELECT 1 FROM market_schema WHERE version = ?", version).toArray().length) return;
      for (const statement of statements) sql.exec(statement);
      sql.exec("INSERT INTO market_schema (version) VALUES (?)", version);
    };
    // Upgrade a pre-pipeline draft once, holding formerly approved releases for a fresh scan and review.
    migrate(1,
      `INSERT OR IGNORE INTO mod_pipeline (version_id, metadata, job_id)
        SELECT v.id, json_object('slug', l.slug, 'name', l.name, 'summary', l.summary, 'description', l.description,
          'source', l.source, 'version', v.version), 'migration-' || v.id
        FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug`,
      `DELETE FROM mod_approvals WHERE version_id IN (SELECT v.id FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
        WHERE p.job_id = 'migration-' || v.id AND p.state = 'queued' AND v.status = 'approved')`,
      `UPDATE mod_versions SET status = 'submitted', signature = NULL WHERE status = 'approved'
        AND id IN (SELECT version_id FROM mod_pipeline WHERE job_id = 'migration-' || version_id AND state = 'queued')`);
    // Old signatures cannot authenticate a newly reconstructed statement after a contract change.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(mod_versions)").toArray().some(column => column.name === "statement")) {
      sql.exec("ALTER TABLE mod_versions ADD COLUMN statement TEXT");
    }
    migrate(2,
      `DELETE FROM mod_approvals WHERE version_id IN
        (SELECT id FROM mod_versions WHERE signature IS NOT NULL AND statement IS NULL)`,
      `UPDATE mod_pipeline SET state = 'queued', attempts = 0, lease = NULL, lease_until = NULL,
        report = NULL, completed_at = NULL, publish_mode = NULL WHERE version_id IN
        (SELECT id FROM mod_versions WHERE signature IS NOT NULL AND statement IS NULL)`,
      "UPDATE mod_versions SET status = 'submitted', signature = NULL WHERE signature IS NOT NULL AND statement IS NULL");
    // Preserve send identities across removals and restarts, including libraries created before the clock existed.
    migrate(3, "INSERT OR IGNORE INTO mod_library_clock (xuid, sent_at) SELECT xuid, MAX(sent_at) FROM mod_library GROUP BY xuid");
    // Index the media digests of releases submitted before mod_media existed.
    migrate(4, `INSERT OR IGNORE INTO mod_media (sha256, version_id)
      SELECT json_extract(m.value, '$.sha256'), p.version_id FROM mod_pipeline p, json_each(p.media) m
      WHERE json_type(m.value, '$.sha256') = 'text'`);
    // Pending sign-ins now live in sealed browser cookies; drop the table anonymous sign-in starts used to fill.
    migrate(5, "DROP TABLE IF EXISTS oauth_states");
    // Never infer compatibility for existing versions or rewrite their signed statements.
    migrate(6, "ALTER TABLE mod_versions ADD COLUMN api_revision TEXT",
      "CREATE INDEX mod_versions_updates ON mod_versions (slug, api_revision)");
    // Keep the complete original manifest outside the fixed marketplace signed-statement format.
    migrate(7, `CREATE TABLE mod_official_releases (version_id INTEGER PRIMARY KEY, release TEXT NOT NULL, validation TEXT NOT NULL)`);

    // Move every marketplace reference to an opaque account ID. Keep legacy rows for rollback diagnostics;
    // signed statements are immutable and are deliberately never rewritten. No production web accounts existed.
    migrate(8,
      `CREATE TABLE accounts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'player',
        suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
      `CREATE INDEX accounts_verified_email ON accounts (email, email_verified)`,
      `CREATE TABLE identities (provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
        email TEXT NOT NULL, email_verified INTEGER NOT NULL, PRIMARY KEY (provider, subject))`,
      `CREATE INDEX identities_account ON identities (account_id)`,
      `CREATE TABLE xbox_links (xuid TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, gamertag TEXT NOT NULL, linked_at INTEGER NOT NULL)`,
      `CREATE TABLE account_link_codes (code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)`,
      `CREATE TABLE account_link_attempts (account_id TEXT NOT NULL, at INTEGER NOT NULL)`,
      `CREATE INDEX account_link_attempts_account ON account_link_attempts (account_id, at)`,
      `CREATE TABLE market_account_migration (xuid TEXT PRIMARY KEY, account_id TEXT NOT NULL)`,
      `INSERT INTO market_account_migration SELECT xuid, CASE WHEN xuid = '${OFFICIAL_CREATOR}' THEN xuid ELSE lower(hex(randomblob(16))) END FROM market_accounts`,
      `INSERT INTO accounts SELECT m.account_id, a.gamertag, '', 0, CASE WHEN a.role = 'owner' THEN 'player' ELSE a.role END,
        a.suspended, a.seen_at FROM market_accounts a JOIN market_account_migration m ON m.xuid = a.xuid`,
      `INSERT INTO xbox_links SELECT a.xuid, m.account_id, a.gamertag, a.seen_at FROM market_accounts a JOIN market_account_migration m ON m.xuid = a.xuid
        WHERE a.xuid != '${OFFICIAL_CREATOR}'`,
      ...["web_sessions", "mod_approvals", "mod_library", "mod_library_clock"].flatMap(table => [
        `ALTER TABLE ${table} RENAME COLUMN xuid TO account_id`,
        `UPDATE ${table} SET account_id = COALESCE((SELECT account_id FROM market_account_migration m WHERE m.xuid = ${table}.account_id), account_id)`,
      ]),
      ...[["mod_listings", "creator"], ["mod_reports", "reporter"], ["mod_reports", "resolved_by"],
        ["mod_trust", "creator"], ["mod_trust", "granted_by"], ["mod_upload_attempts", "creator"], ["staff_audit", "actor"], ["staff_audit", "target"]].map(([table, column]) =>
        `UPDATE ${table} SET ${column} = COALESCE((SELECT account_id FROM market_account_migration m WHERE m.xuid = ${table}.${column}), ${column})`),
      `DROP TABLE market_account_migration`);
  }

  /** Increases whenever the set of pulled versions changes, so callers can tell a memoized revocation list is stale. */
  revocationRevision = 0;

  /** Records authenticated CI approval and deterministic byte validation without impersonating a scanner report. */
  officialRelease(input: ModRelease, grants: Grants, license: string, now: number): number | null {
    const release = canonicalRelease(input), m = release.manifest;
    const listing = this.listing(OFFICIAL_SLUG);
    if (listing && listing.creator !== OFFICIAL_CREATOR) return null;
    const existing = this.versions("v.slug = ? AND v.version = ?", OFFICIAL_SLUG, m.version)[0];
    const encoded = JSON.stringify(release);
    if (existing) {
      const stored = this.sql.exec<{ release: string }>("SELECT release FROM mod_official_releases WHERE version_id = ?", existing.id).toArray()[0];
      return stored?.release === encoded ? existing.id : null;
    }
    if (this.officialDigestPulled(m.artifact.sha256)) return null;
    const metadata: ListingFields = { slug: OFFICIAL_SLUG, name: "Cinnabar Official Mod", summary: "The official Cinnabar gameplay and interface mod.",
      description: "The Official Mod, published by Cinnabar's authenticated release pipeline.", source: "", category: "Utilities", license, notes: "", version: m.version };
    this.sql.exec(`INSERT OR IGNORE INTO accounts (id, display_name, email, email_verified, created_at) VALUES (?, 'Cinnabar', '', 0, ?)`, OFFICIAL_CREATOR, now);
    this.sql.exec(`INSERT OR IGNORE INTO mod_listings (slug, creator, name, summary, description, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      OFFICIAL_SLUG, OFFICIAL_CREATOR, metadata.name, metadata.summary, metadata.description, metadata.source, now);
    const id = this.sql.exec<{ id: number }>(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at, decided_at, api_revision)
      VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?) RETURNING id`, OFFICIAL_SLUG, m.version, m.artifact.sha256, m.artifact.size,
      JSON.stringify(grants), reachOf(grants), now, now, m.host.api_revision).one().id;
    this.sql.exec(`INSERT INTO mod_official_releases (version_id, release, validation) VALUES (?, ?, ?)`, id, encoded,
      JSON.stringify({ policy: OFFICIAL_POLICY, at: now, sha256: m.artifact.sha256, bytes: m.artifact.size,
        checks: ["manifest", "publisher", "sha256", "size", "component-framing", "declarations", "grants", "executable-size"], approval: "authenticated-release-hook" }));
    this.sql.exec(`INSERT INTO mod_pipeline (version_id, metadata, job_id, state, completed_at, publish_mode)
      VALUES (?, ?, ?, 'complete', ?, 'official')`, id, JSON.stringify(metadata), crypto.randomUUID(), now);
    this.log(OFFICIAL_CREATOR, "official approval", `${OFFICIAL_SLUG} ${m.version}`, OFFICIAL_POLICY, now);
    return id;
  }

  /** Original manifests of signed, visible official versions; callers still apply compatibility and identity selection. */
  officialReleases(hash?: string): ModRelease[] {
    const listing = this.listing(OFFICIAL_SLUG);
    if (!listing || listing.hidden || this.account(OFFICIAL_CREATOR)?.suspended) return [];
    return this.versions(`v.slug = ? AND ${PUBLISHED}${hash === undefined ? "" : " AND v.sha256 = ?"}`,
      OFFICIAL_SLUG, ...(hash === undefined ? [] : [hash])).flatMap(v => {
      const row = this.sql.exec<{ release: string }>("SELECT release FROM mod_official_releases WHERE version_id = ?", v.id).toArray()[0];
      return row ? [JSON.parse(row.release) as ModRelease] : [];
    });
  }

  /** Committed marketplace releases permanently supersede a legacy version, including while hidden or pulled. */
  officialManaged(version: string): boolean {
    return this.versions("v.slug = ? AND v.version = ? AND v.status = 'approved'", OFFICIAL_SLUG, version).length > 0;
  }

  /** Once official publication starts, catalogue reads must observe its withdrawals without an edge-cache delay. */
  hasOfficialListing(): boolean { return !!this.listing(OFFICIAL_SLUG); }

  /** Identical retries acknowledge a committed signature, including pulled versions, without republishing. */
  officialSigned(id: number): boolean {
    const v = this.versionRow(id);
    return !!v?.signature && !!v.statement && v.status === "approved";
  }

  /** A pulled official digest cannot be resurrected by a legacy row or by another official version using identical bytes. */
  officialDigestPulled(hash: string): boolean {
    return this.versions("v.slug = ? AND v.sha256 = ? AND v.pulled = 1", OFFICIAL_SLUG, hash).length > 0;
  }

  // --- Sign-in -------------------------------------------------------------------------------------------

  /**
   * Resolves (provider, subject) first. New identities may join an existing account only when both emails
   * are verified and match after trim/lowercase normalization. Ambiguous verified matches never auto-link.
   * Existing identities stay attached to their account even when provider email/name claims change.
   */
  signIn(identity: ProviderIdentity, sessionHash: string, csrf: string, now: number): void {
    const email = identity.email.trim().toLowerCase();
    const existing = this.sql.exec<{ account_id: string }>(
      "SELECT account_id FROM identities WHERE provider = ? AND subject = ?", identity.provider, identity.subject).toArray()[0];
    let accountId = existing?.account_id;
    if (!accountId && identity.email_verified && email) {
      const matches = this.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE email = ? AND email_verified = 1 LIMIT 2", email).toArray();
      if (matches.length === 1) accountId = matches[0]!.id;
    }
    if (!accountId) {
      accountId = crypto.randomUUID();
      this.sql.exec("INSERT INTO accounts (id, display_name, email, email_verified, created_at) VALUES (?, ?, ?, ?, ?)",
        accountId, identity.display_name, email, identity.email_verified ? 1 : 0, now);
    } else if (existing) {
      // Refresh the account's primary claims only from its existing identity, never from an unverified email match.
      this.sql.exec("UPDATE accounts SET display_name = ?, email = ?, email_verified = ? WHERE id = ?",
        identity.display_name, email, identity.email_verified ? 1 : 0, accountId);
    }
    this.sql.exec(`INSERT INTO identities (provider, subject, account_id, email, email_verified) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, email_verified = excluded.email_verified`,
      identity.provider, identity.subject, accountId, email, identity.email_verified ? 1 : 0);
    this.sql.exec("DELETE FROM web_sessions WHERE created_at <= ?", now - PLAYER_SESSION_MS);
    this.sql.exec("INSERT INTO web_sessions (id_hash, account_id, csrf, created_at) VALUES (?, ?, ?, ?)", sessionHash, accountId, csrf, now);
  }

  /** End only the authenticated browser's session; suspended accounts can still sign out. */
  signOut(caller: Caller, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session.status === 401 ? ok({}) : session;
    this.sql.exec("DELETE FROM web_sessions WHERE id_hash = ?", caller.session!);
    return ok({});
  }

  private account(id: string): Account | null {
    const row = this.sql.exec<{ id: string; display_name: string; email: string; email_verified: number; role: string; suspended: number }>(
      "SELECT id, display_name, email, email_verified, role, suspended FROM accounts WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const role: Role = row.email_verified && this.owners.has(row.email.trim().toLowerCase()) ? "owner"
      : ROLES.includes(row.role as Role) && row.role !== "owner" ? row.role as Role : "player";
    return { ...row, role, email_verified: !!row.email_verified, suspended: !!row.suspended };
  }

  /** Resolves an opaque account ID, with an unambiguous display-name fallback for existing staff forms. */
  private accountNamed(input: Record<string, unknown>): Account | MarketResult {
    if (typeof input.account_id === "string") return this.account(input.account_id) ?? fail(404, "No such Cinnabar account.");
    const name = trimmed(input.display_name ?? input.gamertag);
    const rows = this.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE display_name = ? COLLATE NOCASE LIMIT 2", name).toArray();
    if (rows.length > 1) return fail(409, "More than one account has that display name. Use an account ID.");
    return (rows[0] && this.account(rows[0].id)) ?? fail(404, "No Cinnabar account with that display name has signed in yet.");
  }

  /** Resolves a live session; staff sessions expire after twelve hours, player sessions after thirty days. */
  private session(caller: Caller, now: number): (SessionRow & { account: Account }) | null {
    if (!caller.session) return null;
    const row = this.sql.exec<SessionRow>("SELECT account_id, csrf, created_at FROM web_sessions WHERE id_hash = ?",
      caller.session).toArray()[0];
    const account = row && this.account(row.account_id);
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
    if (!session) return fail(401, SIGN_IN_FIRST);
    if (!caller.csrf || caller.csrf !== session.csrf) return fail(403, "Refresh the page and try again.");
    return session;
  }

  private staff(caller: Caller, now: number, write: boolean): Account | MarketResult {
    const session = write ? this.writer(caller, now) : this.session(caller, now);
    if (!session) return fail(401, SIGN_IN_FIRST);
    if ("status" in session) return session;
    if (!atLeast(session.account, "moderator") || session.account.suspended) return fail(403, "Staff only.");
    return session.account;
  }

  private name(id: string): string {
    return this.sql.exec<{ display_name: string }>("SELECT display_name FROM accounts WHERE id = ?", id)
      .toArray()[0]?.display_name ?? "Unknown";
  }

  private log(actor: string, action: string, target: string, note: string, now: number): void {
    this.sql.exec("INSERT INTO staff_audit (at, actor, action, target, note) VALUES (?, ?, ?, ?, ?)",
      now, actor, action, target, clip(note, 500));
  }

  // --- Reads ---------------------------------------------------------------------------------------------

  /** The signed-in account, its CSRF token and the mods it has sent to its game. */
  me(caller: Caller, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session) return anonymousResult("me")!;
    const { id, display_name, email, role, suspended } = session.account;
    return ok({ account: { id, display_name, email, role, suspended, xbox: this.xbox(id) },
      library: this.library(id), csrf: session.csrf, game_online: false });
  }

  /** The current Xbox identity linked to an account, or null; libraries themselves belong to account IDs. */
  xbox(accountId: string): { xuid: string; gamertag: string } | null {
    return this.sql.exec<{ xuid: string; gamertag: string }>("SELECT xuid, gamertag FROM xbox_links WHERE account_id = ?", accountId).toArray()[0] ?? null;
  }

  /** Resolves the verified game XUID at the delivery boundary, never treating it as a marketplace account ID. */
  accountForXbox(xuid: string): string | null {
    return this.sql.exec<{ account_id: string }>("SELECT account_id FROM xbox_links WHERE xuid = ?", xuid).toArray()[0]?.account_id ?? null;
  }

  /** A linked game socket's account library; an unlinked XUID receives an empty library. */
  libraryForXbox(xuid: string): ModLibraryEntry[] {
    const id = this.accountForXbox(xuid);
    return id ? this.library(id) : [];
  }

  /** Removes a game selection only from the account currently linked to that connection's verified XUID. */
  removeXboxLibrary(xuid: string, slug: string, sha256: string, sentAt: string): boolean {
    const id = this.accountForXbox(xuid);
    return !!id && this.removeLibrary(id, slug, sha256, sentAt);
  }

  /** The library entries an account holds, including pulled versions with staff's reason. */
  library(accountId: string): ModLibraryEntry[] {
    return this.sql.exec<VersionRow & { sent_at: number }>(`SELECT v.*, l.sent_at FROM mod_library l
      JOIN mod_versions v ON v.id = l.version_id WHERE l.account_id = ? ORDER BY l.sent_at`, accountId).toArray()
      .map((v) => ({ slug: v.slug, version: v.version, sha256: v.sha256, bytes: v.bytes, grants: parseWellFormed(v.grants) as Grants,
        sent_at: new Date(v.sent_at).toISOString(), pulled: !!v.pulled, ...(v.pulled ? { pull_reason: v.pull_reason.toWellFormed() } : {}) }));
  }

  /** Issues at most five codes/account per ten minutes. Replacement invalidates the previous code atomically. */
  issueLinkCode(caller: Caller, codeHash: string, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    if (this.xbox(session.account.id)) return fail(409, "Unlink your Xbox account first.");
    this.sql.exec("DELETE FROM account_link_attempts WHERE at <= ?", now - 600_000);
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM account_link_attempts WHERE account_id = ?", session.account.id).one().n;
    if (count >= 5) return fail(429, "Too many link codes. Try again in ten minutes.");
    this.sql.exec("INSERT INTO account_link_attempts (account_id, at) VALUES (?, ?)", session.account.id, now);
    this.sql.exec("DELETE FROM account_link_codes WHERE account_id = ?", session.account.id);
    this.sql.exec("INSERT INTO account_link_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)", codeHash, session.account.id, now + 600_000);
    return ok({});
  }

  /** Clears the binding and any pending code; existing selections stay on the Cinnabar account. */
  unlinkXbox(caller: Caller, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    const previous = this.xbox(session.account.id);
    this.sql.exec("DELETE FROM xbox_links WHERE account_id = ?", session.account.id);
    this.sql.exec("DELETE FROM account_link_codes WHERE account_id = ?", session.account.id);
    return { status: 204, body: null, notify: previous ? [previous.xuid] : [] };
  }

  /**
   * Consumes a hashed, unexpired code synchronously with binding the verified game identity. The indexed hash
   * lookup is followed by a fixed-length constant-time digest comparison, including the missing-code path.
   * Refused bindings preserve the code; successful bindings delete it, so replay cannot relink an account.
   */
  linkXbox(codeHash: string, xuid: string, gamertag: string, now: number):
    { ok: true; account: { display_name: string } } | { ok: false; error: "invalid" | "expired" | "already_linked" | "rate_limited" } {
    const row = this.sql.exec<{ code_hash: string; account_id: string; expires_at: number }>(
      "SELECT code_hash, account_id, expires_at FROM account_link_codes WHERE code_hash = ?", codeHash).toArray()[0];
    const matches = equalHash(codeHash, row?.code_hash ?? "!".repeat(43));
    if (!matches || !row) return { ok: false, error: "invalid" };
    if (row.expires_at <= now) return { ok: false, error: "expired" };
    const account = this.account(row.account_id);
    if (!account || account.suspended) return { ok: false, error: "invalid" };
    if (this.accountForXbox(xuid) || this.xbox(account.id)) return { ok: false, error: "already_linked" };
    this.sql.exec("INSERT INTO xbox_links (xuid, account_id, gamertag, linked_at) VALUES (?, ?, ?, ?)", xuid, account.id, gamertag, now);
    this.sql.exec("DELETE FROM account_link_codes WHERE account_id = ?", account.id);
    return { ok: true, account: { display_name: account.display_name } };
  }

  private versions(where: string, ...args: SqlStorageValue[]): VersionRow[] {
    return this.sql.exec<VersionRow>(`SELECT v.*, l.creator FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug
      WHERE ${where}`, ...args).toArray();
  }

  private versionRow(id: number): VersionRow | undefined {
    return this.versions("v.id = ?", id)[0];
  }

  private approvals(versionId: number): { id: string; admin: boolean; at: number; display_name: string }[] {
    return this.sql.exec<{ account_id: string; admin: number; at: number }>(
      "SELECT account_id, admin, at FROM mod_approvals WHERE version_id = ? ORDER BY at", versionId).toArray()
      .map((a) => ({ id: a.account_id, admin: !!a.admin, at: a.at, display_name: this.name(a.account_id) }));
  }

  private liveVersion(slug: string): VersionRow | undefined {
    // The hook may replay historical releases; backfilling an older official generation must not replace the catalogue head.
    if (slug === OFFICIAL_SLUG) return this.versions(`v.slug = ? AND ${PUBLISHED}`, slug)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    return this.versions(`v.slug = ? AND ${PUBLISHED} ORDER BY v.decided_at DESC, v.id DESC LIMIT 1`, slug)[0];
  }

  /** The live version of a listing that is visible with an active creator. */
  private publicVersion(listing: ListingRow | undefined): VersionRow | undefined {
    return listing && !listing.hidden && !this.account(listing.creator)?.suspended ? this.liveVersion(listing.slug) : undefined;
  }

  private listing(slug: string): ListingRow | undefined {
    return this.sql.exec<ListingRow>("SELECT * FROM mod_listings WHERE slug = ?", slug).toArray()[0];
  }

  /** A listing as the public catalogue shows it, given its public live version. */
  private publicListing(listing: ListingRow, live: VersionRow) {
    const p = this.pipeline(live.id)!;
    const metadata = snapshotOf(p);
    const report = reportOf(p);
    const grants = JSON.parse(live.grants) as Grants;
    return {
      slug: listing.slug, name: metadata.name, summary: metadata.summary, description: metadata.description,
      source: metadata.source, gallery: this.media(live.id), creator: listing.creator, creator_name: this.name(listing.creator),
      category: metadata.category, license: metadata.license, grants,
      version: live.version, version_id: String(live.id), reach: live.reach,
      status: "approved",
      capabilities: requestedCapabilities(grants), sha256: live.sha256, bytes: live.bytes,
      updated_at: live.decided_at, reviewed_by: this.approvals(live.id).map((a) => a.display_name).join(", "),
      publication: p.publish_mode,
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
    const all = this.sql.exec<ListingRow>("SELECT * FROM mod_listings").toArray().flatMap((listing) => {
      const live = this.publicVersion(listing);
      return live ? [this.publicListing(listing, live)] : [];
    });
    return ok(all.sort((a, b) => a.reach - b.reach || (b.updated_at ?? 0) - (a.updated_at ?? 0)));
  }

  mod(slug: string): MarketResult {
    const listing = this.listing(slug);
    const live = this.publicVersion(listing);
    if (!listing || !live) return fail(404, "No public mod with that name.");
    const history = this.versions("v.slug = ? AND v.status = 'approved' ORDER BY v.decided_at DESC", slug).map((v) => {
      const p = this.pipeline(v.id)!;
      return { version: v.version, at: v.decided_at, pulled: !!v.pulled, reach: v.reach,
        reviewers: this.approvals(v.id).map((a) => a.display_name), publication: p.publish_mode, notes: snapshotOf(p).notes };
    });
    return ok({ ...this.publicListing(listing, live), history, release: { statement: live.statement, signature: live.signature } });
  }

  /** Stored files require an actually signed, visible release before public downloads are allowed. */
  assetAllowed(sha256: string): boolean {
    if (this.officialDigestPulled(sha256)) return false;
    return this.versions(`v.sha256 = ? AND ${PUBLISHED} AND l.hidden = 0`, sha256).some(v => !this.account(v.creator)?.suspended);
  }

  /** The canonical statement signed for an approved version. */
  statement(versionId: number): string {
    const v = this.versionRow(versionId)!;
    if (v.statement !== null) return v.statement;
    const p = this.pipeline(v.id)!;
    const approvers = p.publish_mode === "official" ? [OFFICIAL_CREATOR] : this.approvals(v.id).map((a) => a.id);
    return JSON.stringify({ approved_at: v.decided_at, approvers, bytes: v.bytes, grants: parseWellFormed(v.grants), sha256: v.sha256,
      slug: v.slug, version: v.version, metadata: parseWellFormed(p.metadata), media: parseWellFormed(p.media),
      policy: p.publish_mode === "official" ? OFFICIAL_POLICY : SCAN_POLICY,
      client_revision: p.publish_mode === "official" ? this.officialManifest(versionId)!.manifest.host.revision : CLIENT_REVISION,
      scan_job: p.job_id, publication: p.publish_mode,
      ...(v.api_revision === null ? {} : { api_revision: v.api_revision }) });
  }

  /** Returns exact signed metadata for a still-public digest, including an older library selection. */
  release(slug: string, version: string, sha256: string): MarketResult {
    const listing = this.listing(slug);
    const v = this.versions(`v.slug = ? AND v.version = ? AND v.sha256 = ? AND ${PUBLISHED}`, slug, version, sha256)[0];
    if (!listing || listing.hidden || this.account(listing.creator)?.suspended || !v) return fail(404, "No such release.");
    return ok({ release: { statement: v.statement, signature: v.signature } });
  }

  /** Selects the highest newer public version for this slug and supported API list, without any compatibility fallback. */
  update(slug: string, query: MarketplaceUpdateQuery): MarketResult {
    const listing = this.listing(slug);
    if (!listing || listing.hidden || this.account(listing.creator)?.suspended) return fail(404, "No such mod.");
    const revisions = query.api_revisions.split(",");
    const candidates = this.versions(`v.slug = ? AND v.api_revision IN (${revisions.map(() => "?").join(",")})
      AND v.sha256 != ? AND ${PUBLISHED}`, slug, ...revisions, query.current_sha256);
    let best: VersionRow | undefined;
    for (const v of candidates) {
      if (compareVersions(v.version, query.current_version) <= 0) continue;
      if (!best || compareVersions(v.version, best.version) > 0) best = v;
    }
    return best ? ok({ release: { statement: best.statement, signature: best.signature } }) : { status: 204, body: null };
  }

  /** Atomically exposes a signed release after rechecking every gate following external I/O. */
  publish(versionId: number, statement: string, signature: string, now: number): boolean {
    if (this.publicationReady(versionId, now)?.statement !== statement) return false;
    this.sql.exec("UPDATE mod_versions SET status = 'approved', statement = ?, signature = ? WHERE id = ?", statement, signature, versionId);
    const v = this.versionRow(versionId)!;
    this.log("system", "published", `${v.slug} ${v.version}`, this.pipeline(versionId)!.publish_mode!, now);
    return true;
  }

  /** Pulled versions with the reason staff gave, as the canonical body of the signed revocation list; reasons are always well-formed. */
  revocations(now: number): string {
    return revocationBody(now, this.revoked());
  }

  private revoked(): RevokedRow[] {
    return this.sql.exec<RevokedRow>("SELECT id, slug, version, sha256, pull_reason FROM mod_versions WHERE pulled = 1 ORDER BY id").toArray();
  }

  // --- Player writes -------------------------------------------------------------------------------------

  /** Adds a public mod's current version to the player's library. */
  send(caller: Caller, slug: string, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    if (!this.xbox(session.account.id)) return fail(409, "Link your Xbox account in Cinnabar first.");
    const live = this.publicVersion(this.listing(slug));
    if (!live) return fail(404, "No public mod with that name.");
    const account_id = session.account.id;
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_library WHERE account_id = ? AND slug != ?", account_id, slug).one().n;
    if (count >= MAX_LIBRARY) return fail(409, "Your library is full. Remove a mod from your library first.");
    const sentAt = this.sql.exec<{ sent_at: number }>(`INSERT INTO mod_library_clock (account_id, sent_at) VALUES (?, ?)
      ON CONFLICT (account_id) DO UPDATE SET sent_at = MAX(excluded.sent_at, mod_library_clock.sent_at + 1)
      RETURNING sent_at`, account_id, now).one().sent_at;
    this.sql.exec(`INSERT INTO mod_library (account_id, slug, version_id, sent_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, slug) DO UPDATE SET version_id = excluded.version_id, sent_at = excluded.sent_at`, account_id, slug, live.id, sentAt);
    return ok({ queued: true, version: live.version }, { notify: [this.xbox(account_id)!.xuid] });
  }

  /** Authorizes a browser removal and broadcasts only a successfully removed exact selection. */
  removeSelection(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    const body = fieldsOf(input);
    const at = typeof body.sent_at === "string" && body.sent_at.length <= 32 ? Date.parse(body.sent_at) : NaN;
    if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256) || !Number.isSafeInteger(at)
      || new Date(at).toISOString() !== body.sent_at) return fail(422, "Choose a library selection with its hash and send timestamp.");
    const account_id = session.account.id;
    if (!this.removeLibrary(account_id, slug, body.sha256, String(body.sent_at))) {
      return fail(409, "Your library changed. Review the current selection and try again.");
    }
    const xbox = this.xbox(account_id);
    return ok({ removed: true }, { notify: xbox ? [xbox.xuid] : [] });
  }

  /** Removes only the authenticated account's exact send request; stale removals cannot erase a later send. */
  removeLibrary(account_id: string, slug: string, sha256: string, sentAt: string): boolean {
    const at = Date.parse(sentAt);
    if (!Number.isSafeInteger(at)) return false;
    return this.sql.exec(`DELETE FROM mod_library WHERE account_id = ? AND slug = ? AND sent_at = ?
      AND version_id IN (SELECT id FROM mod_versions WHERE slug = ? AND sha256 = ?)`, account_id, slug, at, slug, sha256).rowsWritten > 0;
  }

  /** Files a report against a visible listing's live version; suspended accounts can't report. */
  report(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    const listing = this.listing(slug);
    const live = listing && !listing.hidden ? this.liveVersion(slug) : undefined;
    if (!live) return fail(404, "No public mod with that name.");
    const body = fieldsOf(input);
    if (typeof body.reason !== "string" || !REPORT_REASONS.includes(body.reason)) return fail(400, "Choose a reason.");
    if (malformedText(body.details)) return fail(422, MALFORMED_TEXT);
    const details = trimmed(body.details);
    if (details.length < 10) return fail(400, "Describe what happened in a sentence or two.");
    const account_id = session.account.id;
    const recent = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_reports WHERE reporter = ? AND at > ?",
      account_id, now - 86_400_000).one().n;
    if (recent >= MAX_REPORTS_PER_DAY) return fail(429, "You've sent a lot of reports today. Try again tomorrow.");
    this.sql.exec("INSERT INTO mod_reports (slug, version, reporter, reason, details, at) VALUES (?, ?, ?, ?, ?, ?)",
      slug, live.version, account_id, body.reason, clip(details, 1000), now);
    return ok({ received: true });
  }

  mine(caller: Caller, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session) return fail(401, SIGN_IN_FIRST);
    return ok(this.versions("l.creator = ? ORDER BY v.submitted_at DESC", session.account.id).map((v) => this.versionView(v)));
  }

  /** Checks a submission before its file is stored, so a refused listing costs no upload. */
  precheck(caller: Caller, listingInput: unknown, now: number): MarketResult {
    const admitted = this.admit(caller, listingInput, now);
    return "status" in admitted ? admitted : ok({});
  }

  /** The submitting account, or the refusal for a suspended, over-budget or conflicting submission. */
  private admit(caller: Caller, listingInput: unknown, now: number): { account: Account } | MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    const pending = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM mod_versions v JOIN mod_listings l ON l.slug = v.slug
      WHERE l.creator = ? AND v.status = 'submitted'`, session.account.id).one().n;
    if (pending >= MAX_PENDING_SUBMISSIONS) return fail(429, "You have five versions waiting for review. Wait for a decision first.");
    const { fields, errors } = validateListing(listingInput, 0);
    if (Object.keys(errors).length) return fail(422, "Check the highlighted fields.", errors);
    const existing = this.listing(fields.slug);
    if (existing && existing.creator !== session.account.id) {
      return fail(409, "That name is taken.", { slug: "Another creator owns this name." });
    }
    if (this.sql.exec("SELECT 1 FROM mod_versions WHERE slug = ? AND version = ?", fields.slug, fields.version).toArray().length) {
      return fail(409, "That version exists.", { version: "Bump the version to submit again." });
    }
    return session;
  }

  /** Records a submitted version whose file is already stored under its SHA-256. */
  submit(caller: Caller, listingInput: unknown, file: SubmittedFile, now: number): MarketResult {
    const session = this.admit(caller, listingInput, now);
    if ("status" in session) return session;
    const grants = file.grants ?? {};
    const reach = reachOf(grants);
    const { fields, errors } = validateListing(listingInput, reach);
    if (Object.keys(errors).length) return fail(422, "Check the highlighted fields.", errors);
    // Durable Object storage commits the synchronous writes of one turn atomically.
    this.sql.exec(`INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING`,
      fields.slug, session.account.id, fields.name, fields.summary, fields.description, fields.source, now);
    const id = this.sql.exec<{ id: number }>(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at, api_revision)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?) RETURNING id`,
      fields.slug, fields.version, file.sha256, file.bytes, JSON.stringify(grants), reach, now, API_REVISION).one().id;
    const baseline = this.liveVersion(fields.slug)?.id ?? null;
    this.sql.exec(`INSERT INTO mod_pipeline (version_id, metadata, media, baseline, job_id) VALUES (?, ?, ?, ?, ?)`,
      id, JSON.stringify(fields), JSON.stringify(file.media), baseline, crypto.randomUUID());
    for (const item of file.media) this.sql.exec("INSERT OR IGNORE INTO mod_media (sha256, version_id) VALUES (?, ?)", item.sha256, id);
    return ok(this.versionView(this.versionRow(id)!));
  }

  /** Authenticate before consuming any upload bytes. */
  uploadAllowed(caller: Caller, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    this.sql.exec("DELETE FROM mod_upload_attempts WHERE at <= ?", now - 3_600_000);
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_upload_attempts WHERE creator = ?", session.account.id).one().n >= 20) {
      return fail(429, "Upload limit reached. Try again in an hour.");
    }
    this.sql.exec("INSERT INTO mod_upload_attempts (creator, at) VALUES (?, ?)", session.account.id, now);
    return ok({});
  }

  /** Load the immutable release snapshot and its current scanner lease/evidence. */
  private pipeline(id: number): PipelineRow | undefined {
    return this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE version_id = ?", id).toArray()[0];
  }

  /** Whether a version's scan completed under the current policy and is still recent enough to act on. */
  private scanPassed(p: PipelineRow, now: number): boolean {
    return p.state === "complete" && scanReady(reportOf(p), p.completed_at, now);
  }

  /** Media descriptors belong to the immutable version, not mutable listing metadata. */
  media(id: number): MediaFile[] { return JSON.parse(this.pipeline(id)?.media ?? "[]") as MediaFile[]; }

  /** Pending screenshots are visible only to their creator or active staff, under an authenticated no-store route. */
  privateMedia(caller: Caller, id: number, sha256: string, now: number): MarketResult {
    const session = this.session(caller, now);
    if (!session || session.account.suspended) return fail(404, NO_SUCH_IMAGE);
    const v = this.versionRow(id);
    const media = this.media(id).find(item => item.sha256 === sha256);
    if (!v || !media || (v.creator !== session.account.id && !atLeast(session.account, "moderator"))) return fail(404, NO_SUCH_IMAGE);
    return ok({ key: `media/${media.sha256}`, type: media.type });
  }

  /**
   * Whether `sha256` is a screenshot of a published release on a visible listing whose creator isn't suspended.
   * The digest index only finds candidates; each release's own immutable media list stays authoritative.
   */
  mediaAllowed(sha256: string): boolean {
    return this.sql.exec(`SELECT 1 FROM mod_media m JOIN mod_versions v ON v.id = m.version_id
      JOIN mod_listings l ON l.slug = v.slug JOIN mod_pipeline pm ON pm.version_id = v.id
      LEFT JOIN accounts a ON a.id = l.creator
      WHERE m.sha256 = ? AND ${PUBLISHED} AND l.hidden = 0 AND COALESCE(a.suspended, 0) = 0
      AND EXISTS (SELECT 1 FROM json_each(pm.media) j WHERE json_extract(j.value, '$.sha256') = m.sha256) LIMIT 1`, sha256)
      .toArray().length > 0;
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
    const v = this.versionRow(p.version_id)!;
    const previous = p.baseline === null ? undefined : this.versionRow(p.baseline);
    return ok({ job: { id: p.job_id, lease, version_id: v.id, sha256: v.sha256, bytes: v.bytes, policy: SCAN_POLICY,
      listing: JSON.parse(p.metadata), grants: JSON.parse(v.grants), media: this.media(v.id),
      previous: previous ? { sha256: previous.sha256, grants: JSON.parse(previous.grants),
        report: JSON.parse(this.pipeline(previous.id)?.report ?? "null") } : null } });
  }

  /** A scanner can read only files attached to its current, unexpired claim. It cannot list the bucket. */
  scanFile(job: string, lease: string, sha256: string, now: number): MarketResult {
    const p = this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE job_id = ? AND lease = ? AND state = 'running' AND lease_until > ?",
      job, lease, now).toArray()[0];
    const v = p && this.versionRow(p.version_id);
    const media = p && this.media(p.version_id).find(m => m.sha256 === sha256);
    if (!v || (v.sha256 !== sha256 && !media)) return fail(404, "No claimed file.");
    return ok({ key: `${media ? "media" : "mods"}/${sha256}`, type: media?.type ?? "application/wasm" });
  }

  /** Deduplicate completion and reject stale leases, wrong hashes, malformed reports and outdated policy. */
  completeScan(job: string, lease: string, input: unknown, now: number): MarketResult {
    const p = this.sql.exec<PipelineRow>("SELECT * FROM mod_pipeline WHERE job_id = ?", job).toArray()[0];
    if (!p || p.lease !== lease) return fail(409, "Stale scan claim.");
    const v = this.versionRow(p.version_id)!;
    const report = parseScanReport(input, v.sha256, this.media(v.id).map(m => m.sha256));
    if (!report) return fail(422, "Invalid scan attestation.");
    if (p.state === "complete" || p.state === "failed") {
      return p.report === JSON.stringify(report) ? ok({ received: true, duplicate: true }) : fail(409, "Scan already completed.");
    }
    if (p.state !== "running" || !p.lease_until || p.lease_until <= now || v.status !== "submitted") return fail(409, "Stale scan claim.");
    const failed = report.deterministic === "error" || report.ai.verdict === "error";
    this.sql.exec("UPDATE mod_pipeline SET state = ?, report = ?, completed_at = ? WHERE version_id = ?",
      failed ? "failed" : "complete", JSON.stringify(report), now, v.id);
    // Pending releases can cross deployments; the accepted report attests to the current pinned scanner client.
    this.sql.exec("UPDATE mod_versions SET api_revision = ? WHERE id = ?", API_REVISION, v.id);
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
    const creator = this.account(v.creator);
    if (v.status !== "submitted" || v.pulled || v.reach >= 3 || this.listing(v.slug)!.hidden || !creator || creator.suspended
      || !this.scanPassed(p, now) || reportOf(p)!.ai.verdict !== "clear") return false;
    const baseline = this.liveVersion(v.slug);
    if (!this.trusted(v.slug, v.creator, now) || !baseline || baseline.id !== p.baseline) return false;
    if (this.sql.exec("SELECT 1 FROM mod_reports WHERE slug = ? AND status = 'open'", v.slug).toArray().length) return false;
    const prior = this.pipeline(baseline.id)!;
    const priorReport = reportOf(prior);
    if (!priorReport || priorReport.policy !== SCAN_POLICY || priorReport.client_revision !== CLIENT_REVISION || priorReport.deterministic !== "pass") return false;
    if (grantDiff(JSON.parse(baseline.grants), JSON.parse(v.grants)).expanded) return false;
    // New host interfaces are authority changes even if the declaration did not change.
    if (reportOf(p)!.imports.some(name => !priorReport.imports.includes(name))) return false;
    // Listing/source/media edits get a human content review at launch. Raw snapshots, so a migrated one differs.
    const before = JSON.parse(prior.metadata) as Record<string, unknown>;
    const after = JSON.parse(p.metadata) as Record<string, unknown>;
    return !["name", "summary", "description", "source", "category", "license"].some(key => before[key] !== after[key])
      && prior.media === p.media;
  }

  /**
   * Whether `creator` holds unexpired trust for `slug` from someone who is still an active admin and isn't the
   * creator, so a later demotion or suspension of the granter withdraws it.
   */
  private trusted(slug: string, creator: string, now: number): boolean {
    const grant = this.sql.exec<{ granted_by: string }>("SELECT granted_by FROM mod_trust WHERE slug = ? AND creator = ? AND expires_at > ?",
      slug, creator, now).toArray()[0];
    const granter = grant && this.account(grant.granted_by);
    return !!granter && !granter.suspended && atLeast(granter, "admin") && granter.id !== creator;
  }

  /** Return publication material only while current scan, account and decision gates still hold. */
  publicationReady(id: number, now: number): { sha256: string; bytes: number; media: MediaFile[]; statement: string } | null {
    const v = this.versionRow(id);
    const p = this.pipeline(id);
    if (!v || !p || v.status !== "submitted" || v.pulled || this.account(v.creator)?.suspended || this.listing(v.slug)?.hidden
      || (p.publish_mode === "official" ? p.state !== "complete" || v.slug !== OFFICIAL_SLUG || v.creator !== OFFICIAL_CREATOR
        || this.officialDigestPulled(v.sha256) || !this.officialValidationReady(v, p)
        : !this.scanPassed(p, now))) return null;
    // Manual approvals count only from staff who are still active and aren't the creator.
    const decided = p.publish_mode === "official" || (p.publish_mode === "automatic" ? this.automaticAllowed(v, now)
      : p.publish_mode === "manual" && approvalsComplete(v.reach as Reach, this.approvals(id).flatMap(a => {
        const actor = this.account(a.id);
        return actor && !actor.suspended && atLeast(actor, "moderator") && actor.id !== v.creator ? [{ admin: atLeast(actor, "admin") }] : [];
      })));
    return decided ? { sha256: v.sha256, bytes: v.bytes, media: this.media(id), statement: this.statement(id) } : null;
  }

  /** Reads the retained official manifest for signing and legacy adapters; no signed statement fields are added. */
  private officialManifest(id: number): ModRelease | null {
    const row = this.sql.exec<{ release: string }>("SELECT release FROM mod_official_releases WHERE version_id = ?", id).toArray()[0];
    return row ? JSON.parse(row.release) as ModRelease : null;
  }

  /** A recoverable official decision must bind the same bytes, API and host identities under the current hook policy. */
  private officialValidationReady(v: VersionRow, p: PipelineRow): boolean {
    const row = this.sql.exec<{ release: string; validation: string }>(
      "SELECT release, validation FROM mod_official_releases WHERE version_id = ?", v.id).toArray()[0];
    if (!row) return false;
    const m = (JSON.parse(row.release) as ModRelease).manifest;
    const validation = JSON.parse(row.validation) as { policy: string; sha256: string; bytes: number; at: number };
    return validation.policy === OFFICIAL_POLICY && validation.sha256 === v.sha256 && validation.bytes === v.bytes && validation.at === p.completed_at
      && m.artifact.sha256 === v.sha256 && m.artifact.size === v.bytes && m.version === v.version && m.host.api_revision === v.api_revision;
  }

  /** Official versions use their retained MOD_ASSETS object for signing and public download checks. */
  isOfficialVersion(id: number): boolean { return this.officialManifest(id) !== null; }

  /** Retry jobs with a new identity, invalidating old scanner leases and all earlier approvals. */
  rescan(caller: Caller, id: number, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const v = this.versionRow(id);
    if (!v || v.status !== "submitted") return fail(409, "Only pending releases can be rescanned.");
    if (this.isOfficialVersion(id)) return fail(409, "Official releases use release-hook validation.");
    if (v.creator === staff.id) return fail(403, "You can't rescan your own mod.");
    this.sql.exec(`UPDATE mod_pipeline SET job_id = ?, state = 'queued', attempts = 0, lease = NULL,
      lease_until = NULL, report = NULL, completed_at = NULL, publish_mode = NULL WHERE version_id = ?`, crypto.randomUUID(), id);
    this.sql.exec("DELETE FROM mod_approvals WHERE version_id = ?", id);
    this.log(staff.id, "rescan", `${v.slug} ${v.version}`, "New scan job", now);
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
    if (listing.creator === session.account.id) return fail(403, "You can't establish your own trust.");
    const body = fieldsOf(input);
    if (malformedText(body.reason)) return fail(422, MALFORMED_TEXT);
    const reason = clip(trimmed(body.reason), 500);
    if (!reason || typeof body.trusted !== "boolean") return fail(422, "Supply trusted and an audit reason.");
    if (body.trusted) {
      const humanApproved = this.sql.exec(`SELECT 1 FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
        WHERE v.slug = ? AND v.status = 'approved' AND p.publish_mode = 'manual' AND v.pulled = 0 LIMIT 1`, slug).toArray().length;
      if (!this.publicVersion(listing) || !humanApproved) {
        return fail(409, "A visible human-approved release and active creator are required.");
      }
      this.sql.exec(`INSERT INTO mod_trust (slug, creator, granted_by, expires_at, reason) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (slug) DO UPDATE SET creator = excluded.creator, granted_by = excluded.granted_by,
        expires_at = excluded.expires_at, reason = excluded.reason`, slug, listing.creator, session.account.id, now + 90 * 86_400_000, reason);
    } else this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", slug);
    this.log(session.account.id, body.trusted ? "established creator" : "revoked trust", slug, reason, now);
    return ok({ trusted: body.trusted });
  }

  // --- Staff ---------------------------------------------------------------------------------------------

  private versionView(v: VersionRow) {
    const listing = this.listing(v.slug)!;
    const p = this.pipeline(v.id)!;
    const metadata = snapshotOf(p);
    const trust = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM mod_trust WHERE slug = ? AND creator = ?", v.slug, v.creator).toArray()[0];
    const previous = p.baseline === null ? undefined : this.versionRow(p.baseline);
    const grants = JSON.parse(v.grants) as Grants;
    return {
      id: String(v.id), slug: v.slug, version: v.version, grants, reach: v.reach, status: v.status, note: v.note,
      creator: v.creator, creator_name: this.name(v.creator), sha256: v.sha256, bytes: v.bytes,
      submitted_at: v.submitted_at, decided_at: v.decided_at, pulled: !!v.pulled, pull_reason: v.pull_reason,
      name: metadata.name, summary: metadata.summary, description: metadata.description, source: metadata.source, hidden: !!listing.hidden,
      category: metadata.category, license: metadata.license, notes: metadata.notes,
      trust: { trusted: !!trust && this.trusted(v.slug, v.creator, Date.now()), expires_at: trust?.expires_at ?? null },
      gallery: this.media(v.id), scan: { state: p.state, attempts: p.attempts, job: p.job_id,
        completed_at: p.completed_at, expires_at: p.completed_at === null ? null : p.completed_at + SCAN_MAX_AGE_MS,
        review_ready: this.scanPassed(p, Date.now()), report: reportOf(p) }, publication: p.publish_mode,
      capabilities: requestedCapabilities(grants), rule: approvalRule(v.reach as Reach), approvals: this.approvals(v.id),
      ...(this.isOfficialVersion(v.id) ? { official_validation: JSON.parse(this.sql.exec<{ validation: string }>(
        "SELECT validation FROM mod_official_releases WHERE version_id = ?", v.id).one().validation),
        file_withdrawn: this.officialDigestPulled(v.sha256) } : {}),
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
    const v = this.versionRow(id);
    return v ? ok(this.versionView(v)) : fail(404, "No such version.");
  }

  /** Records an approval, rejection or change request; approvals publish once the reach's rule is met. */
  decide(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const v = this.versionRow(id);
    if (!v) return fail(404, "No such version.");
    const body = fieldsOf(input);
    if (malformedText(body.note)) return fail(422, MALFORMED_TEXT);
    const note = clip(trimmed(body.note), 1000);
    const state: ReviewState = { creator: v.creator, status: v.status, reach: v.reach as Reach,
      approvals: this.approvals(v.id).map((a) => ({ id: a.id, admin: a.admin })) };
    const target = `${v.slug} ${v.version}`;
    if (body.decision === "approve") {
      const allowed = canApprove(staff, state);
      if (!allowed.ok) return fail(403, allowed.reason);
      const p = this.pipeline(v.id)!;
      if (!this.scanPassed(p, now)) return fail(409, "A current, complete scan must pass before approval. Rescan failed or expired jobs.");
      if (reportOf(p)!.ai.verdict === "flag" && !note) return fail(422, "Explain how the flagged findings were resolved before approving.");
      if (this.account(v.creator)?.suspended || this.listing(v.slug)?.hidden) return fail(409, "Restore the creator and listing before approving.");
      const admin = atLeast(staff, "admin");
      this.sql.exec("INSERT INTO mod_approvals (version_id, account_id, admin, at) VALUES (?, ?, ?, ?)", v.id, staff.id, admin ? 1 : 0, now);
      const approvals = [...state.approvals, { id: staff.id, admin }];
      const done = approvalsComplete(state.reach, approvals);
      if (done) {
        this.sql.exec("UPDATE mod_versions SET decided_at = ?, note = ? WHERE id = ?", now, note, v.id);
        this.sql.exec("UPDATE mod_pipeline SET publish_mode = 'manual' WHERE version_id = ?", v.id);
      }
      this.log(staff.id, done ? "approved" : `approved (${approvals.length} of ${approvalRule(state.reach).count})`, target, note, now);
      return ok(this.versionView(this.versionRow(v.id)!), done ? { approved: v.id } : {});
    }
    if (body.decision !== "reject" && body.decision !== "changes") return fail(400, "Unknown decision.");
    const allowed = canReview(staff, state);
    if (!allowed.ok) return fail(403, allowed.reason);
    if (!note) return fail(400, "Tell the creator why.");
    const status = body.decision === "reject" ? "rejected" : "changes";
    this.sql.exec("UPDATE mod_versions SET status = ?, decided_at = ?, note = ? WHERE id = ?", status, now, note, v.id);
    this.log(staff.id, status === "rejected" ? "rejected" : "requested changes", target, note, now);
    return ok(this.versionView(this.versionRow(v.id)!));
  }

  /** Withdraws a published version; every player holding it is told the reason. */
  pull(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    if (!atLeast(staff, "admin")) return fail(403, "Only admins can pull a published version.");
    const v = this.versionRow(id);
    if (!v || v.status !== "approved" || v.pulled) return fail(404, "Only published versions can be pulled.");
    const rawReason = fieldsOf(input).reason;
    if (malformedText(rawReason)) return fail(422, MALFORMED_TEXT);
    const reason = clip(trimmed(rawReason), 500);
    if (!reason) return fail(400, "Say why it's being pulled.");
    const rows = [...this.revoked(), { id: v.id, slug: v.slug, version: v.version, sha256: v.sha256, pull_reason: reason }]
      .sort((a, b) => a.id - b.id);
    if (!withinRevocationBudget(revocationBody(now, rows))) {
      return fail(409, "The signed revocation list is at its size limit, so clients couldn't download it. Hide the listing and ask an operator to compact revocations.");
    }
    this.sql.exec("UPDATE mod_versions SET pulled = 1, pull_reason = ? WHERE id = ?", reason, v.id);
    this.revocationRevision++;
    this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", v.slug);
    this.log(staff.id, "pulled", `${v.slug} ${v.version}`, reason, now);
    const holders = this.sql.exec<{ account_id: string }>("SELECT account_id FROM mod_library WHERE version_id = ?", v.id).toArray().flatMap((r) => this.xbox(r.account_id)?.xuid ?? []);
    return ok(this.versionView(this.versionRow(v.id)!), { notify: holders });
  }

  /** Hides or restores another creator's listing; restoring needs an admin, as hiding withdrew its trust. */
  hide(caller: Caller, slug: string, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const listing = this.listing(slug);
    if (!listing) return fail(404, "No such mod.");
    if (listing.creator === staff.id) return fail(403, "You can't hide or restore your own mod.");
    const body = fieldsOf(input);
    if (malformedText(body.reason)) return fail(422, MALFORMED_TEXT);
    const reason = trimmed(body.reason);
    if (!reason) return fail(400, "Note why, for the audit log.");
    if (typeof body.hidden !== "boolean") return fail(422, "Supply hidden as true or false.");
    const hidden = body.hidden;
    if (!hidden && !atLeast(staff, "admin")) return fail(403, "Only admins can restore a hidden listing.");
    this.sql.exec("UPDATE mod_listings SET hidden = ? WHERE slug = ?", hidden ? 1 : 0, slug);
    if (hidden) this.sql.exec("DELETE FROM mod_trust WHERE slug = ?", slug);
    this.log(staff.id, hidden ? "hid listing" : "restored listing", slug, reason, now);
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

  /** Resolves a report about another creator's mod; open reports hold automatic publication. */
  resolve(caller: Caller, id: number, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    const report = this.sql.exec<{ slug: string; version: string }>("SELECT slug, version FROM mod_reports WHERE id = ?", id).toArray()[0];
    if (!report) return fail(404, "No such report.");
    if (this.listing(report.slug)?.creator === staff.id) return fail(403, "You can't resolve reports about your own mod.");
    const rawNote = fieldsOf(input).note;
    if (malformedText(rawNote)) return fail(422, MALFORMED_TEXT);
    const note = clip(trimmed(rawNote), 1000);
    if (!note) return fail(400, "Write what you found.");
    this.sql.exec("UPDATE mod_reports SET status = 'resolved', resolution = ?, resolved_by = ? WHERE id = ?", note, staff.id, id);
    this.log(staff.id, "resolved report", `${report.slug} ${report.version}`, note, now);
    return ok({ id: String(id), status: "resolved" });
  }

  people(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    const emails = [...this.owners];
    const rows = this.sql.exec<{ id: string }>(`SELECT id FROM accounts WHERE role != 'player' OR suspended = 1
      ${emails.length ? `OR (email_verified = 1 AND email IN (${emails.map(() => "?").join(",")}))` : ""}`, ...emails).toArray();
    return ok(rows
      .map(r => this.account(r.id)!).filter(a => a.role !== "player" || a.suspended)
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.display_name.localeCompare(b.display_name)));
  }

  /** Changes a signed-in player's role; needs a fresh sign-in and a reason. */
  setRole(caller: Caller, input: unknown, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    // Authority comes before the display_name lookup, so players can't probe which display_names have signed in.
    if (!managesStaff(session.account)) return fail(403, STAFF_MANAGERS_ONLY);
    const body = fieldsOf(input);
    const target = this.accountNamed(body);
    if ("status" in target) return target;
    const role = body.role as Role;
    if (!ROLES.includes(role)) return fail(400, "Choose a role.");
    const allowed = canSetRole(session.account, target, role);
    if (!allowed.ok) return fail(403, allowed.reason);
    if (session.created_at + ROLE_CHANGE_SIGN_IN_MS <= now) return fail(401, "For safety, sign out and sign in again before changing roles.");
    if (malformedText(body.reason)) return fail(422, MALFORMED_TEXT);
    const reason = trimmed(body.reason);
    if (!reason) return fail(400, "Note why, for the audit log.");
    this.sql.exec("UPDATE accounts SET role = ? WHERE id = ?", role, target.id);
    if (role === "player") this.sql.exec("DELETE FROM web_sessions WHERE account_id = ?", target.id);
    this.log(session.account.id, "changed role", target.id, reason, now);
    return ok(this.account(target.id));
  }

  /** Suspends or restores a player: they can't submit, send or review while suspended. */
  suspend(caller: Caller, input: unknown, now: number): MarketResult {
    const staff = this.staff(caller, now, true);
    if ("status" in staff) return staff;
    if (!atLeast(staff, "admin")) return fail(403, "Only admins can suspend accounts.");
    const body = fieldsOf(input);
    const target = this.accountNamed(body);
    if ("status" in target) return target;
    if (target.id === staff.id || atLeast(target, "admin") && !atLeast(staff, "owner")) return fail(403, "You can't suspend this account.");
    if (malformedText(body.reason)) return fail(422, MALFORMED_TEXT);
    const reason = trimmed(body.reason);
    if (!reason) return fail(400, "Note why, for the audit log.");
    if (typeof body.suspended !== "boolean") return fail(422, "Supply suspended as true or false.");
    const suspended = body.suspended;
    this.sql.exec("UPDATE accounts SET suspended = ? WHERE id = ?", suspended ? 1 : 0, target.id);
    if (suspended) this.sql.exec("DELETE FROM mod_trust WHERE creator = ?", target.id);
    this.log(staff.id, suspended ? "suspended" : "restored", target.id, reason, now);
    return ok(this.account(target.id));
  }

  audit(caller: Caller, now: number): MarketResult {
    const staff = this.staff(caller, now, false);
    if ("status" in staff) return staff;
    return ok(this.sql.exec<{ at: number; actor: string; action: string; target: string; note: string }>(
      "SELECT at, actor, action, target, note FROM staff_audit ORDER BY id DESC LIMIT 200").toArray()
      .map((e) => ({ ...e, actor_name: this.name(e.actor) })));
  }

  /** Recover interrupted publications using the same gate used by immediate publication. */
  pendingPublications(): number[] {
    return this.sql.exec<{ id: number }>(`SELECT v.id FROM mod_versions v JOIN mod_pipeline p ON p.version_id = v.id
      WHERE v.status = 'submitted' AND p.publish_mode IS NOT NULL ORDER BY p.promotion_attempt_at, v.id LIMIT 10`).toArray().map(v => v.id);
  }

  /** Failed or no-longer-eligible candidates move behind other recoverable releases. */
  publicationAttempt(id: number, now: number): void {
    this.sql.exec("UPDATE mod_pipeline SET promotion_attempt_at = ? WHERE version_id = ?", now, id);
  }
}

/** One marketplace request from the Worker, carrying the caller's session hash and CSRF header. */
export type MarketCall = Caller & (
  | { op: "release"; slug: string; version: string; sha256: string }
  | { op: "update"; slug: string; query: MarketplaceUpdateQuery }
  | { op: "me" } | { op: "mods" } | { op: "mod"; slug: string } | { op: "mine" } | { op: "queue" } | { op: "reports" }
  | { op: "people" } | { op: "audit" } | { op: "signout" }
  | { op: "send"; slug: string } | { op: "remove"; slug: string; body: unknown } | { op: "report"; slug: string; body: unknown }
  | { op: "upload-auth" } | { op: "precheck"; body: unknown } | { op: "submit"; body: unknown; file: SubmittedFile }
  | { op: "version"; id: number } | { op: "decide"; id: number; body: unknown } | { op: "pull"; id: number; body: unknown }
  | { op: "hide"; slug: string; body: unknown } | { op: "resolve"; id: number; body: unknown }
  | { op: "role"; body: unknown } | { op: "suspend"; body: unknown } | { op: "asset"; sha256: string }
  | { op: "media"; sha256: string } | { op: "trust"; slug: string; body: unknown } | { op: "rescan"; id: number }
  | { op: "private-media"; id: number; sha256: string }
  | { op: "scan-claim" } | { op: "scan-file"; job: string; lease: string; sha256: string }
  | { op: "scan-complete"; job: string; lease: string; body: unknown }
  | { op: "signin"; identity: ProviderIdentity; newSession: string; newCsrf: string }
  | { op: "link-code"; codeHash: string } | { op: "unlink" }
);

/**
 * Operations that read the caller's session before anything else, so a caller without a session cookie always gets
 * the same answer from them. A test checks every one against the Hub's actual anonymous answer.
 */
export const SESSION_OPS = ["me", "mine", "signout", "link-code", "unlink", "send", "remove", "report", "upload-auth", "precheck", "submit", "version",
  "decide", "pull", "hide", "resolve", "role", "suspend", "queue", "reports", "people", "audit", "trust", "rescan", "private-media",
] as const satisfies readonly MarketCall["op"][];

/**
 * The fixed answer a session-only operation gives a caller without a session, including the Hub's `game_online` for
 * `me`, or null for any other operation. The Worker uses it to answer anonymous requests without calling the Hub.
 */
export function anonymousResult(op: MarketCall["op"]): MarketResult | null {
  if (!(SESSION_OPS as readonly string[]).includes(op)) return null;
  if (op === "me") return ok({ account: null, library: [], csrf: null, game_online: false });
  if (op === "signout") return ok({});
  if (op === "private-media") return fail(404, NO_SUCH_IMAGE);
  return fail(401, SIGN_IN_FIRST);
}

/** Routes one call to the store. */
export function handle(store: MarketplaceStore, call: MarketCall, now: number): MarketResult {
  switch (call.op) {
    case "me": return store.me(call, now);
    case "link-code": return store.issueLinkCode(call, call.codeHash, now);
    case "unlink": return store.unlinkXbox(call, now);
    case "mods": return store.mods();
    case "mod": return store.mod(call.slug);
    case "release": return store.release(call.slug, call.version, call.sha256);
    case "update": return store.update(call.slug, call.query);
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
    case "asset": return ok({ allowed: store.assetAllowed(call.sha256) });
    case "media": return ok({ allowed: store.mediaAllowed(call.sha256) });
    case "private-media": return store.privateMedia(call, call.id, call.sha256, now);
    case "trust": return store.setTrust(call, call.slug, call.body, now);
    case "rescan": return store.rescan(call, call.id, now);
    case "scan-claim": return store.claimScan(now);
    case "scan-file": return store.scanFile(call.job, call.lease, call.sha256, now);
    case "scan-complete": return store.completeScan(call.job, call.lease, call.body, now);
    case "signin":
      store.signIn(call.identity, call.newSession, call.newCsrf, now);
      return ok({});
    case "signout":
      return store.signOut(call, now);
  }
}
