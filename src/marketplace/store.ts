import {
  ROLES, approvalRule, approvalsComplete, atLeast, canApprove, canReview, canSetRole, grantDiff, reachOf,
  requestedCapabilities, validateListing, type Actor, type Grants, type Reach, type ReviewState, type Role,
} from "./policy";

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
        pulled INTEGER NOT NULL DEFAULT 0, pull_reason TEXT NOT NULL DEFAULT '', signature TEXT, UNIQUE (slug, version))`,
      `CREATE TABLE IF NOT EXISTS mod_approvals (version_id INTEGER NOT NULL, xuid TEXT NOT NULL, admin INTEGER NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (version_id, xuid))`,
      `CREATE TABLE IF NOT EXISTS mod_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
        version TEXT NOT NULL, reporter TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '', resolved_by TEXT)`,
      `CREATE TABLE IF NOT EXISTS mod_library (xuid TEXT NOT NULL, slug TEXT NOT NULL, version_id INTEGER NOT NULL,
        sent_at INTEGER NOT NULL, PRIMARY KEY (xuid, slug))`,
      `CREATE TABLE IF NOT EXISTS staff_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL)`,
    ]) sql.exec(statement);
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

  signOut(sessionHash: string): void {
    this.sql.exec("DELETE FROM web_sessions WHERE id_hash = ?", sessionHash);
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
    return this.versions("v.slug = ? AND v.status = 'approved' AND v.pulled = 0 ORDER BY v.decided_at DESC LIMIT 1", slug)[0];
  }

  private listing(slug: string): ListingRow | undefined {
    return this.sql.exec<ListingRow>("SELECT * FROM mod_listings WHERE slug = ?", slug).toArray()[0];
  }

  /** A listing as the public catalogue shows it, or null when nothing about it is public. */
  private publicListing(listing: ListingRow) {
    const live = this.liveVersion(listing.slug);
    if (!live || listing.hidden) return null;
    return {
      slug: listing.slug, name: listing.name, summary: listing.summary, description: listing.description,
      source: listing.source, creator: listing.creator, creator_name: this.name(listing.creator),
      version: live.version, version_id: String(live.id), reach: live.reach,
      capabilities: requestedCapabilities(JSON.parse(live.grants)), sha256: live.sha256, bytes: live.bytes,
      updated_at: live.decided_at, reviewed_by: this.approvals(live.id).map((a) => a.gamertag).join(", "),
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
    }));
    const live = this.liveVersion(slug)!;
    return ok({ ...view, history, release: live.signature ? { statement: this.statement(live.id), signature: live.signature } : null });
  }

  /** Whether a file may be downloaded: public when an approved, unpulled version uses it; any version for staff. */
  assetAllowed(sha256: string, caller: Caller, now: number): boolean {
    if (this.sql.exec("SELECT 1 FROM mod_versions WHERE sha256 = ? AND status = 'approved' AND pulled = 0", sha256)
      .toArray().length) return true;
    const session = this.session(caller, now);
    return !!session && atLeast(session.account, "moderator")
      && this.sql.exec("SELECT 1 FROM mod_versions WHERE sha256 = ?", sha256).toArray().length > 0;
  }

  /** The canonical statement signed for an approved version. */
  statement(versionId: number): string {
    const v = this.versions("v.id = ?", versionId)[0]!;
    const approvers = this.approvals(v.id).map((a) => a.xuid);
    return JSON.stringify({ approved_at: v.decided_at, approvers, bytes: v.bytes, grants: JSON.parse(v.grants), sha256: v.sha256,
      slug: v.slug, version: v.version });
  }

  setSignature(versionId: number, signature: string): void {
    this.sql.exec("UPDATE mod_versions SET signature = ? WHERE id = ?", signature, versionId);
  }

  /** Pulled versions with the reason staff gave, as the canonical body of the signed revocation list. */
  revocations(): string {
    const revoked = this.sql.exec<{ slug: string; version: string; sha256: string; pull_reason: string }>(
      "SELECT slug, version, sha256, pull_reason FROM mod_versions WHERE pulled = 1 ORDER BY id").toArray()
      .map((v) => ({ slug: v.slug, version: v.version, sha256: v.sha256, reason: v.pull_reason }));
    return JSON.stringify({ revoked });
  }

  // --- Player writes -------------------------------------------------------------------------------------

  /** Adds a public mod's current version to the player's library. */
  send(caller: Caller, slug: string, now: number): MarketResult {
    const session = this.writer(caller, now);
    if ("status" in session) return session;
    if (session.account.suspended) return fail(403, "Your account is suspended.");
    const listing = this.listing(slug);
    const live = listing && !listing.hidden ? this.liveVersion(slug) : undefined;
    if (!live) return fail(404, "No public mod with that name.");
    const xuid = session.account.xuid;
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mod_library WHERE xuid = ? AND slug != ?", xuid, slug).one().n;
    if (count >= MAX_LIBRARY) return fail(409, "Your library is full. Remove a mod in game first.");
    this.sql.exec(`INSERT INTO mod_library (xuid, slug, version_id, sent_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (xuid, slug) DO UPDATE SET version_id = excluded.version_id, sent_at = excluded.sent_at`, xuid, slug, live.id, now);
    return ok({ queued: true, version: live.version }, { notify: [xuid] });
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
    delete errors.source;
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
  submit(caller: Caller, listingInput: unknown, file: { sha256: string; bytes: number; grants: Grants | null }, now: number): MarketResult {
    const checked = this.precheck(caller, listingInput, now);
    if (checked.status !== 200) return checked;
    const session = this.writer(caller, now) as { account: Account };
    const grants = file.grants ?? {};
    const reach = reachOf(grants);
    const { fields, errors } = validateListing(listingInput, reach);
    if (Object.keys(errors).length) return fail(422, "Check the highlighted fields.", errors);
    // Durable Object storage commits the synchronous writes of one turn atomically.
    this.sql.exec(`INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO UPDATE SET name = excluded.name, summary = excluded.summary,
        description = excluded.description, source = excluded.source`,
      fields.slug, session.account.xuid, fields.name, fields.summary, fields.description, fields.source, now);
    const id = this.sql.exec<{ id: number }>(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?) RETURNING id`,
      fields.slug, fields.version, file.sha256, file.bytes, JSON.stringify(grants), reach, now).one().id;
    return ok(this.versionView(this.versions("v.id = ?", id)[0]!));
  }

  // --- Staff ---------------------------------------------------------------------------------------------

  private versionView(v: VersionRow) {
    const listing = this.listing(v.slug)!;
    const previous = this.versions("v.slug = ? AND v.status = 'approved' AND v.submitted_at < ? ORDER BY v.submitted_at DESC LIMIT 1",
      v.slug, v.submitted_at)[0];
    const grants = JSON.parse(v.grants) as Grants;
    return {
      id: String(v.id), slug: v.slug, version: v.version, grants, reach: v.reach, status: v.status, note: v.note,
      creator: v.creator, creator_name: this.name(v.creator), sha256: v.sha256, bytes: v.bytes,
      submitted_at: v.submitted_at, decided_at: v.decided_at, pulled: !!v.pulled, pull_reason: v.pull_reason,
      name: listing.name, summary: listing.summary, source: listing.source, hidden: !!listing.hidden,
      capabilities: requestedCapabilities(grants), rule: approvalRule(v.reach as Reach), approvals: this.approvals(v.id),
      previous: previous ? { version: previous.version, diff: grantDiff(JSON.parse(previous.grants), grants) } : null,
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
      this.sql.exec("INSERT INTO mod_approvals (version_id, xuid, admin, at) VALUES (?, ?, ?, ?)", v.id, staff.xuid,
        atLeast(staff, "admin") ? 1 : 0, now);
      const approvals = [...state.approvals, { xuid: staff.xuid, admin: atLeast(staff, "admin") }];
      const done = approvalsComplete(state.reach, approvals);
      if (done) this.sql.exec("UPDATE mod_versions SET status = 'approved', decided_at = ?, note = ? WHERE id = ?", now, note, v.id);
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
}

/** One marketplace request from the Worker, carrying the caller's session hash and CSRF header. */
export type MarketCall = Caller & (
  | { op: "me" } | { op: "mods" } | { op: "mod"; slug: string } | { op: "mine" } | { op: "queue" } | { op: "reports" }
  | { op: "people" } | { op: "audit" } | { op: "signout" }
  | { op: "send"; slug: string } | { op: "report"; slug: string; body: unknown }
  | { op: "precheck"; body: unknown } | { op: "submit"; body: unknown; file: { sha256: string; bytes: number; grants: Grants | null } }
  | { op: "version"; id: number } | { op: "decide"; id: number; body: unknown } | { op: "pull"; id: number; body: unknown }
  | { op: "hide"; slug: string; body: unknown } | { op: "resolve"; id: number; body: unknown }
  | { op: "role"; body: unknown } | { op: "suspend"; body: unknown } | { op: "asset"; sha256: string }
  | { op: "begin"; state: string; verifier: string; returnTo: string } | { op: "consume"; state: string }
  | { op: "signin"; xuid: string; gamertag: string; newSession: string; newCsrf: string }
);

/** Routes one call to the store. */
export function handle(store: MarketplaceStore, call: MarketCall, now: number): MarketResult {
  switch (call.op) {
    case "me": return store.me(call, now);
    case "mods": return store.mods();
    case "mod": return store.mod(call.slug);
    case "mine": return store.mine(call, now);
    case "queue": return store.queue(call, now);
    case "reports": return store.reports(call, now);
    case "people": return store.people(call, now);
    case "audit": return store.audit(call, now);
    case "send": return store.send(call, call.slug, now);
    case "report": return store.report(call, call.slug, call.body, now);
    case "precheck": return store.precheck(call, call.body, now);
    case "submit": return store.submit(call, call.body, call.file, now);
    case "version": return store.version(call, call.id, now);
    case "decide": return store.decide(call, call.id, call.body, now);
    case "pull": return store.pull(call, call.id, call.body, now);
    case "hide": return store.hide(call, call.slug, call.body, now);
    case "resolve": return store.resolve(call, call.id, call.body, now);
    case "role": return store.setRole(call, call.body, now);
    case "suspend": return store.suspend(call, call.body, now);
    case "asset": return ok({ allowed: store.assetAllowed(call.sha256, call, now) });
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
      if (call.session) store.signOut(call.session);
      return ok({});
  }
}
