import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeLinkCode, sha256Base64Url } from "../src/marketplace/auth";
import { MarketplaceStore } from "../src/marketplace/store";
import { OAUTH_STATE_MS, openSignIn, sealSignIn } from "../src/marketplace/oauth-state";
import { marketplaceRoutes } from "../src/marketplace/routes";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const SITE = "https://site.test";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const sockets: Client[] = [];
const profiles = new Map<string, object>();
interface Me { account: { id: string; display_name: string; email: string; role: string; suspended: boolean; xbox: { xuid: string; gamertag: string } | null }; library: unknown[]; csrf: string; game_online: boolean }
let serial = 0;
const api = (path: string, init?: RequestInit) => exports.default.fetch(`https://api.test/v1${path}`, { redirect: "manual", ...init });
const cookie = (r: Response, name: string) => r.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(";")[0];

beforeAll(() => {
  installFakeIssuer();
  const previous = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TOKEN) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(form.get("client_secret")).toBe("test-google-secret");
      expect(form.get("redirect_uri")).toBe("https://api.test/v1/auth/google/callback");
      const code = form.get("code")!;
      return profiles.has(code) ? Response.json({ access_token: code, token_type: "Bearer" }) : Response.json({}, { status: 400 });
    }
    if (url === USERINFO) {
      const code = new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";
      return Response.json(profiles.get(code) ?? {}, { status: profiles.has(code) ? 200 : 401 });
    }
    return previous(input, init);
  });
});
afterEach(async () => { await Promise.all(sockets.splice(0).map(c => (c.close(), c.closed))); });

/** Completes mocked Google sign-in and exposes a browser with the actual session/CSRF cookies. */
async function browser(profile: object = { sub: `account-${++serial}`, name: "Account Player", email: `player-${serial}@test.invalid`, email_verified: true }) {
  const start = await api("/auth/google/start?return_to=" + encodeURIComponent(`${SITE}/account?keep=1`));
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  const code = `code-${++serial}`;
  profiles.set(code, profile);
  const callback = await api(`/auth/google/callback?state=${state}&code=${code}`, { headers: { Cookie: cookie(start, "__Host-cinnabar_oauth")! } });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).toBe(`${SITE}/account?keep=1`);
  const session = cookie(callback, "__Host-cinnabar_session")!;
  const get = (path: string) => api(path, { headers: { Cookie: session, Origin: SITE } });
  const me = await (await get("/me")).json() as Me;
  const post = (path: string) => api(path, { method: "POST", headers: { Cookie: session, Origin: SITE, "X-Cinnabar-CSRF": me.csrf } });
  return { get, post, me, session };
}

describe("Cinnabar accounts", () => {
  it("starts Google authorization with PKCE and sealed state", async () => {
    const start = await api("/auth/google/start?return_to=https://evil.test/");
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get("Location")!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "test-client", response_type: "code", scope: "openid email profile",
      redirect_uri: "https://api.test/v1/auth/google/callback", code_challenge_method: "S256" });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = await openSignIn(env.MARKETPLACE_SIGNING_KEY!, cookie(start, "__Host-cinnabar_oauth")!.split("=")[1], Date.now());
    if (!pending || pending === "expired") throw new Error("No sealed state");
    expect(pending.provider).toBe("google");
    expect(pending.returnTo).toBe(`${SITE}/mods/`);
    expect(url.searchParams.get("code_challenge")).toBe(await sha256Base64Url(pending.verifier));
    expect(start.headers.getSetCookie()[0]).toMatch(/^__Host-cinnabar_oauth=.+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it("creates an opaque account and session and reuses a returning identity", async () => {
    const profile = { sub: "returning-account", name: "Returning Player", email: "returning@test.invalid", email_verified: true };
    const first = await browser(profile), second = await browser(profile);
    expect(first.me).toEqual({ account: { id: expect.any(String), display_name: profile.name, email: profile.email,
      role: "player", suspended: false, xbox: null }, library: [], csrf: expect.any(String), game_online: false });
    expect(first.me.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.me.account.id).toBe(first.me.account.id);
    expect(second.session).not.toBe(first.session);
    const expectedHash = await sha256Base64Url(first.session.split("=")[1]!);
    await runInDurableObject(hub(), (_, state) => {
      const session = state.storage.sql.exec<{ account_id: string; id_hash: string; csrf: string }>(
        "SELECT account_id, id_hash, csrf FROM web_sessions WHERE id_hash = ?", expectedHash).one();
      expect(session).toEqual({ account_id: first.me.account.id, id_hash: expectedHash, csrf: first.me.csrf });
    });
  });

  it("refuses send without an Xbox link and removes Microsoft web sign-in", async () => {
    const b = await browser();
    const sent = await b.post("/mods/anything/send");
    expect(sent.status).toBe(409);
    expect(await sent.json()).toEqual({ error: "Link your Xbox account in Cinnabar first." });
    expect((await api("/auth/microsoft/start")).status).toBe(404);
    expect((await api("/auth/microsoft/callback")).status).toBe(404);
  });

  it("requires all Google configuration before starting or finishing sign-in", async () => {
    for (const key of ["MARKETPLACE_ORIGIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MARKETPLACE_SIGNING_KEY"]) {
      for (const path of ["/auth/google/start", "/auth/google/callback"]) {
        const result = await marketplaceRoutes.request(`https://api.test${path}`, undefined, { ...env, [key]: "" });
        expect(result.status, `${key} ${path}`).toBe(503);
      }
    }
  });
});

/** Waits for a schema-validated game message with a bounded deadline. */
const next = (client: Client) => Promise.race([client.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Missing account-link message")), 1500))]);
/** Opens a game socket whose XUID and gamertag are signed by the test issuer. */
async function game(xuid: string) {
  const { client, welcome } = await login({ xuid, xname: "Signed Gamertag" });
  sockets.push(client);
  return { client, welcome };
}
/** Issues a code through the real session + CSRF HTTP endpoint. */
async function issue(b: Awaited<ReturnType<typeof browser>>) {
  const response = await b.post("/me/xbox/link-code");
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json() as { code: string; expires_in: number };
  expect(value).toEqual({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/), expires_in: 600 });
  return value.code;
}

describe("provider-generic account matching and authority", () => {
  it("auto-links only when both the incoming and account emails are verified", async () => {
    const verified = await browser({ sub: "verified-origin", email: "match@test.invalid", email_verified: true, name: "Original" });
    const linked = await browser({ sub: "verified-second", email: " MATCH@Test.Invalid ", email_verified: true, name: "Second identity" });
    expect(linked.me.account.id).toBe(verified.me.account.id);
    const unverified = await browser({ sub: "unverified-third", email: "match@test.invalid", email_verified: false, name: "Unverified" });
    expect(unverified.me.account.id).not.toBe(verified.me.account.id);
    const unverifiedTarget = await browser({ sub: "unverified-target", email: "unverified-target@test.invalid", email_verified: false, name: "Unverified target" });
    const verifiedIncoming = await browser({ sub: "verified-incoming", email: "unverified-target@test.invalid", email_verified: true, name: "Verified incoming" });
    expect(verifiedIncoming.me.account.id).not.toBe(unverifiedTarget.me.account.id);
    // A later provider uses exactly the same resolution logic; no Google-specific merge logic lives in the store.
    await hub().marketplace({ op: "signin", identity: { provider: "future-provider", subject: "provider-subject", email: "match@test.invalid",
      email_verified: true, display_name: "Future provider" }, newSession: "future-session", newCsrf: "future-csrf" });
    const me = (await hub().marketplace({ op: "me", session: "future-session" }) as { body: Me }).body;
    expect(me.account.id).toBe(verified.me.account.id);
    const changed = await browser({ sub: "verified-origin", email: "new-email@test.invalid", email_verified: true, name: "Renamed" });
    expect(changed.me.account.id).toBe(verified.me.account.id);
    expect(changed.me.account.display_name).toBe("Renamed");
  });

  it("does not merge ambiguous verified emails", async () => {
    const a = await browser({ sub: "ambiguous-a", email: "ambiguous@test.invalid", email_verified: false, name: "A" });
    const b = await browser({ sub: "ambiguous-b", email: "ambiguous@test.invalid", email_verified: false, name: "B" });
    await browser({ sub: "ambiguous-a", email: "ambiguous@test.invalid", email_verified: true, name: "A" });
    await browser({ sub: "ambiguous-b", email: "ambiguous@test.invalid", email_verified: true, name: "B" });
    const c = await browser({ sub: "ambiguous-c", email: "ambiguous@test.invalid", email_verified: true, name: "C" });
    expect(c.me.account.id).not.toBe(a.me.account.id);
    expect(c.me.account.id).not.toBe(b.me.account.id);
  });

  it("grants owner only through a verified configured email and preserves staff/session suspension rules", async () => {
    const owner = await browser({ sub: "email-owner", email: "2535400000009001@TEST.INVALID", email_verified: true, name: "Email Owner" });
    const impostor = await browser({ sub: "unverified-owner", email: "2535400000009001@test.invalid", email_verified: false, name: "Unverified Owner" });
    expect(owner.me.account.role).toBe("owner");
    expect(impostor.me.account.role).toBe("player");
    expect((await impostor.get("/staff/people")).status).toBe(403);
    expect((await owner.get("/staff/people")).status).toBe(200);
    await runInDurableObject(hub(), (_, state) => {
      state.storage.sql.exec("UPDATE web_sessions SET created_at = ? WHERE account_id = ?", Date.now() - 12 * 3600_000, owner.me.account.id);
      state.storage.sql.exec("UPDATE accounts SET suspended = 1 WHERE id = ?", impostor.me.account.id);
    });
    expect((await (await owner.get("/me")).json() as { account: unknown }).account).toBeNull();
    const suspended = await browser({ sub: "unverified-owner", email: "2535400000009001@test.invalid", email_verified: false, name: "Unverified Owner" });
    expect(suspended.me.account.suspended).toBe(true);
    expect((await suspended.post("/me/xbox/link-code")).status).toBe(403);
    expect((await suspended.post("/mods/anything/send")).status).toBe(403);
    expect((await suspended.post("/auth/signout")).status).toBe(200);
  });
});

describe("Xbox linking through authenticated game connections", () => {
  it("issues hashed codes, replaces them, links signed identity once, and pushes the account library immediately", async () => {
    const b = await browser();
    const old = await issue(b), current = await issue(b);
    expect(current).not.toBe(old);
    const expectedHash = await sha256Base64Url(normalizeLinkCode(current));
    await runInDurableObject(hub(), (_, state) => {
      const sql = state.storage.sql;
      const rows = sql.exec<{ code_hash: string }>("SELECT code_hash FROM account_link_codes WHERE account_id = ?", b.me.account.id).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.code_hash).toBe(expectedHash);
      sql.exec("INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at) VALUES ('linked-library', ?, 'Linked library', '', '', '', ?)", b.me.account.id, Date.now());
      const id = sql.exec<{ id: number }>("INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at) VALUES ('linked-library', '1.0.0', ?, 8, '{}', 0, 'submitted', ?) RETURNING id", "a".repeat(64), Date.now()).one().id;
      sql.exec("INSERT INTO mod_library (account_id, slug, version_id, sent_at) VALUES (?, 'linked-library', ?, ?)", b.me.account.id, id, Date.now());
    });
    const { client, welcome } = await game("2535400000091001");
    expect(welcome.mod_library).toBeUndefined();
    client.send({ type: "account_link", code: old });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "invalid" });
    // XUID/name fields supplied by the message cannot override the authenticated identity.
    client.send({ type: "account_link", code: current.toLowerCase().replace("-", " "), xuid: "2535400000099999", gamertag: "Forged" });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: true, account: { display_name: b.me.account.display_name } });
    expect(await next(client)).toMatchObject({ type: "mod_library", mods: [{ slug: "linked-library", sha256: "a".repeat(64) }] });
    const me = await (await b.get("/me")).json() as Me;
    expect(me.account.xbox).toEqual({ xuid: "2535400000091001", gamertag: "Signed Gamertag" });
    expect(me.game_online).toBe(true);
    expect(me.library).toHaveLength(1);
    client.send({ type: "account_link", code: current });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "invalid" });
    expect((await b.post("/me/xbox/link-code")).status).toBe(409);
    const { welcome: later } = await game("2535400000091001");
    expect(later.mod_library).toMatchObject([{ slug: "linked-library" }]);
    const unlinked = await b.post("/me/xbox/unlink");
    expect(unlinked.status).toBe(204);
    expect(await unlinked.text()).toBe("");
    expect(await next(client)).toEqual({ type: "mod_library", mods: [] });
    expect((await (await b.get("/me")).json() as Me)).toMatchObject({ account: { xbox: null }, game_online: false, library: [{ slug: "linked-library" }] });
    const replacement = await issue(b);
    const { client: otherXbox } = await game("2535400000091002");
    otherXbox.send({ type: "account_link", code: replacement });
    expect(await next(otherXbox)).toMatchObject({ type: "account_link_result", ok: true });
    expect(await next(otherXbox)).toMatchObject({ type: "mod_library", mods: [{ slug: "linked-library" }] });
    // A late game removal from the old Xbox can no longer touch the retained account's selections.
    client.send({ type: "mod_library_remove", slug: "linked-library", sha256: "a".repeat(64), sent_at: (me.library[0] as { sent_at: string }).sent_at });
    expect(await next(client)).toEqual({ type: "mod_library", mods: [] });
    expect((await (await b.get("/me")).json() as Me).library).toHaveLength(1);
  });

  it("expires codes and rejects an XUID or account that is already bound", async () => {
    const first = await browser(), second = await browser();
    const expired = await issue(first);
    await runInDurableObject(hub(), (_, state) => {
      state.storage.sql.exec("UPDATE account_link_codes SET expires_at = ? WHERE account_id = ?", Date.now(), first.me.account.id);
    });
    const { client } = await game("2535400000091003");
    client.send({ type: "account_link", code: expired });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "expired" });
    const live = await issue(first);
    client.send({ type: "account_link", code: live });
    expect(await next(client)).toMatchObject({ type: "account_link_result", ok: true });
    expect(await next(client)).toEqual({ type: "mod_library", mods: [] });
    const nextCode = await issue(second);
    client.send({ type: "account_link", code: nextCode });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "already_linked" });
    expect((await (await second.get("/me")).json() as Me).account.xbox).toBeNull();
    // A refused attempt does not consume the code. Another verified Xbox can still redeem it.
    const { client: other } = await game("2535400000091004");
    other.send({ type: "account_link", code: nextCode });
    expect(await next(other)).toMatchObject({ type: "account_link_result", ok: true });
    expect(await next(other)).toEqual({ type: "mod_library", mods: [] });
    await first.post("/me/xbox/unlink");
    expect(await next(client)).toEqual({ type: "mod_library", mods: [] });
    const firstAgain = await issue(first);
    client.send({ type: "account_link", code: firstAgain });
    expect(await next(client)).toMatchObject({ type: "account_link_result", ok: true });
    expect(await next(client)).toEqual({ type: "mod_library", mods: [] });
  });

  it("rate limits code issuance and redemption, and requires session, CSRF and trusted Origin", async () => {
    const b = await browser();
    for (let i = 0; i < 5; i++) await issue(b);
    expect((await b.post("/me/xbox/link-code")).status).toBe(429);
    await runInDurableObject(hub(), (_, state) => state.storage.sql.exec("UPDATE account_link_attempts SET at = ? WHERE account_id = ?", Date.now() - 600_000, b.me.account.id));
    await issue(b);
    const { client } = await game("2535400000091005");
    for (let i = 0; i < 10; i++) {
      client.send({ type: "account_link", code: "AAAA-AAAA" });
      expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "invalid" });
    }
    await evictDurableObject(hub());
    client.send({ type: "account_link", code: "AAAA-AAAA" });
    expect(await next(client)).toEqual({ type: "account_link_result", ok: false, error: "rate_limited" });
    for (const path of ["/me/xbox/link-code", "/me/xbox/unlink"]) {
      expect((await api(path, { method: "POST" })).status).toBe(401);
      expect((await api(path, { method: "POST", headers: { Cookie: b.session, Origin: SITE } })).status).toBe(403);
      expect((await api(path, { method: "POST", headers: { Cookie: b.session, Origin: "https://evil.test", "X-Cinnabar-CSRF": b.me.csrf } })).status).toBe(403);
    }
  });
});

describe("sign-in failure isolation", () => {
  it("rejects altered, expired and wrong-provider state and failed Google exchanges without calling the Hub", async () => {
    const noHub = { ...env, HUB: { idFromName() { throw new Error("Hub called on failed sign-in"); } } } as unknown as Env;
    const call = (path: string, cookie?: string) => marketplaceRoutes.request(`https://api.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }, noHub);
    const pending = { provider: "google", state: "test-state", verifier: "v".repeat(43), returnTo: `${SITE}/account?keep=1` };
    const cases = [
      "__Host-cinnabar_oauth=altered",
      `__Host-cinnabar_oauth=${await sealSignIn(env.MARKETPLACE_SIGNING_KEY!, pending, Date.now() - OAUTH_STATE_MS)}`,
      `__Host-cinnabar_oauth=${await sealSignIn(env.MARKETPLACE_SIGNING_KEY!, { ...pending, provider: "future-provider" }, Date.now())}`,
    ];
    for (const cookie of cases) {
      const response = await call("/auth/google/callback?state=test-state&code=unknown", cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(`${SITE}/mods/?signin_error=failed`);
      expect(response.headers.getSetCookie().some(c => c.startsWith("__Host-cinnabar_session="))).toBe(false);
    }
    const valid = `__Host-cinnabar_oauth=${await sealSignIn(env.MARKETPLACE_SIGNING_KEY!, pending, Date.now())}`;
    profiles.set("malformed-claims", { sub: "malformed" });
    const malformed = await call("/auth/google/callback?state=test-state&code=malformed-claims", valid);
    expect(malformed.headers.get("Location")).toBe(`${SITE}/account?keep=1&signin_error=failed`);
    const failed = await call("/auth/google/callback?state=test-state&code=unknown", valid);
    expect(failed.headers.get("Location")).toBe(`${SITE}/account?keep=1&signin_error=failed`);
    const cancelled = await call("/auth/google/callback?state=test-state&error=access_denied", valid);
    expect(cancelled.headers.get("Location")).toBe(`${SITE}/account?keep=1&signin_error=cancelled`);
    for (const path of ["/me/xbox/link-code", "/me/xbox/unlink"]) {
      const response = await marketplaceRoutes.request(`https://api.test${path}`, { method: "POST" }, noHub);
      expect(response.status).toBe(401);
    }
  });
});

describe("account-ID persistence", () => {
  it("targets staff changes and audit by account ID without requiring an Xbox link", async () => {
    const owner = await browser({ sub: "id-owner", email: "2535400000009001@test.invalid", email_verified: true, name: "Owner by ID" });
    const target = await browser();
    const change = (path: string, body: object) => api(path, { method: "POST", headers: { Cookie: owner.session, Origin: SITE,
      "X-Cinnabar-CSRF": owner.me.csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const role = await change("/staff/people/role", { account_id: target.me.account.id, role: "moderator", reason: "Account-ID role fixture" });
    expect(role.status).toBe(200);
    expect(await role.json()).toMatchObject({ id: target.me.account.id, role: "moderator" });
    const suspension = await change("/staff/people/suspend", { account_id: target.me.account.id, suspended: true, reason: "Account-ID suspension fixture" });
    expect(suspension.status).toBe(200);
    expect(await suspension.json()).toMatchObject({ id: target.me.account.id, suspended: true });
    const audit = await (await owner.get("/staff/audit")).json() as { actor: string; target: string }[];
    expect(audit[0]).toMatchObject({ actor: owner.me.account.id, target: target.me.account.id });
  });

  it("migrates all legacy account references once without changing signed statements", async () => {
    const stub = env.HUB.get(env.HUB.idFromName("account-migration-fixture"));
    await runInDurableObject(stub, (_, state) => {
      const sql = state.storage.sql, now = Date.now();
      for (const table of ["accounts", "identities", "xbox_links", "account_link_codes", "account_link_attempts"]) sql.exec(`DROP TABLE ${table}`);
      for (const table of ["web_sessions", "mod_approvals", "mod_library", "mod_library_clock"]) sql.exec(`ALTER TABLE ${table} RENAME COLUMN account_id TO xuid`);
      sql.exec("DELETE FROM market_schema WHERE version = 8");
      const oldId = "2535400000092001";
      sql.exec("INSERT INTO market_accounts (xuid, gamertag, role, suspended, seen_at) VALUES (?, 'Legacy Player', 'admin', 1, ?)", oldId, now);
      sql.exec("INSERT INTO market_accounts (xuid, gamertag, role, seen_at) VALUES ('2535400000092002', 'Legacy Owner', 'owner', ?)", now);
      sql.exec("INSERT INTO web_sessions (id_hash, xuid, csrf, created_at) VALUES ('legacy-session', ?, 'legacy-csrf', ?)", oldId, now);
      sql.exec("INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at) VALUES ('legacy-account-mod', ?, 'Legacy', '', '', '', ?)", oldId, now);
      const signed = '{"approvers":["2535400000092001"],"api_revision":"original"}';
      const version = sql.exec<{ id: number }>("INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, statement, signature, submitted_at) VALUES ('legacy-account-mod', '1.0.0', ?, 8, '{}', 0, 'approved', ?, 'original-signature', ?) RETURNING id", "b".repeat(64), signed, now).one().id;
      sql.exec("INSERT INTO mod_pipeline (version_id, metadata, job_id, state) VALUES (?, '{}', 'account-migration-job', 'complete')", version);
      sql.exec("INSERT INTO mod_approvals (version_id, xuid, admin, at) VALUES (?, ?, 1, ?)", version, oldId, now);
      sql.exec("INSERT INTO mod_library (xuid, slug, version_id, sent_at) VALUES (?, 'legacy-account-mod', ?, ?)", oldId, version, now);
      sql.exec("INSERT INTO mod_library_clock (xuid, sent_at) VALUES (?, ?)", oldId, now);
      sql.exec("INSERT INTO mod_reports (slug, version, reporter, reason, details, at, resolved_by) VALUES ('legacy-account-mod', '1.0.0', ?, 'broken', '', ?, ?)", oldId, now, oldId);
      sql.exec("INSERT INTO mod_trust (slug, creator, granted_by, expires_at, reason) VALUES ('legacy-account-mod', ?, ?, ?, 'fixture')", oldId, oldId, now + 600_000);
      sql.exec("INSERT INTO mod_upload_attempts (creator, at) VALUES (?, ?)", oldId, now);
      sql.exec("INSERT INTO staff_audit (at, actor, action, target, note) VALUES (?, ?, 'fixture', ?, '')", now, oldId, oldId);
      const store = state.storage.transactionSync(() => new MarketplaceStore(sql, new Set()));
      const me = store.me({ session: "legacy-session" }, now).body as Me;
      const id = me.account.id;
      expect(id).not.toBe(oldId);
      expect(me.account).toMatchObject({ display_name: "Legacy Player", email: "", role: "admin", suspended: true, xbox: { xuid: oldId, gamertag: "Legacy Player" } });
      expect(me.library).toHaveLength(1);
      expect(sql.exec<{ role: string }>("SELECT role FROM accounts WHERE display_name = 'Legacy Owner'").one().role).toBe("player");
      for (const [table, column] of [["web_sessions", "account_id"], ["mod_approvals", "account_id"], ["mod_library", "account_id"],
        ["mod_library_clock", "account_id"], ["mod_listings", "creator"], ["mod_reports", "reporter"], ["mod_reports", "resolved_by"],
        ["mod_trust", "creator"], ["mod_trust", "granted_by"], ["mod_upload_attempts", "creator"], ["staff_audit", "actor"], ["staff_audit", "target"]]) {
        expect(sql.exec<{ value: string }>(`SELECT ${column} AS value FROM ${table}`).one().value, `${table}.${column}`).toBe(id);
      }
      expect(sql.exec<{ statement: string; signature: string }>("SELECT statement, signature FROM mod_versions WHERE id = ?", version).one()).toEqual({ statement: signed, signature: "original-signature" });
      new MarketplaceStore(sql, new Set());
      expect(sql.exec("SELECT id FROM accounts").toArray()).toHaveLength(2);
      expect(sql.exec("SELECT 1 FROM market_schema WHERE version = 8").toArray()).toHaveLength(1);
    });
  });
});
