import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { readComponent } from "../src/marketplace/component";
import { TOKEN_URL, XBOX_USER_URL, XSTS_URL } from "../src/marketplace/microsoft";
import { approvalRule, canApprove, canSetRole, grantDiff, reachOf, validateListing, type Actor } from "../src/marketplace/policy";
import { REVOCATION_BUDGET_BYTES, REVOCATION_MEMO_MS } from "../src/marketplace/revocations";
import { marketplaceRoutes } from "../src/marketplace/routes";
import { CLIENT_REVISION, SCAN_POLICY, VALIDATOR, PROMPT_VERSION, SCAN_LEASE_MS } from "../src/marketplace/scanning";
import { BodyLimitError, readLimited } from "../src/marketplace/uploads";
import { MarketplaceStore } from "../src/marketplace/store";
import { signText } from "../src/marketplace/signing";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const SITE = "https://site.test";
const OWNER = "2535400000009001";
const PUBLIC_KEY = "MCowBQYDK2VwAyEAlSb5YEqBeXmlmyc5Xg5zqHKLWklg3zlZbCj4GAVu/TQ=";
const open: Client[] = [];

/**
 * Fakes Microsoft and Xbox: the authorization code is `xuid:gamertag`, or `xerr:<code>` for an XSTS refusal.
 * Install after the fake issuer; other requests go to its implementation.
 */
function installFakeXbox(): void {
  const spy = vi.mocked(globalThis.fetch);
  const previous = spy.getMockImplementation()!;
  spy.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: `ms:${form.get("code")}` });
    }
    if (url === XBOX_USER_URL) {
      const ticket = JSON.parse(String(init?.body)).Properties.RpsTicket as string;
      return Response.json({ Token: ticket.replace("d=ms:", "") });
    }
    if (url === XSTS_URL) {
      const code = JSON.parse(String(init?.body)).Properties.UserTokens[0] as string;
      const [xuid, gamertag] = code.split(":");
      if (xuid === "xerr") return Response.json({ XErr: Number(gamertag) }, { status: 401 });
      return Response.json({ DisplayClaims: { xui: [{ xid: xuid, gtg: gamertag, uhs: "h" }] } });
    }
    return previous(input, init);
  });
}

beforeAll(() => {
  installFakeIssuer();
  installFakeXbox();
  // These tests observe current Hub state after each change; test/edge-cache.test.ts covers the public cache path.
  vi.spyOn(caches, "open").mockRejectedValue(new Error("Edge cache disabled for marketplace state tests"));
});
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

/** Calls the Worker without following redirects, so sign-in steps can be inspected. */
const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(`https://api.test/v1${path}`, { redirect: "manual", ...init });

/** A signed-in browser: its session cookie and CSRF token. */
interface Browser {
  cookie: string;
  csrf: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))!;
  return header.split(";")[0]!.slice(name.length + 1);
}

/** Runs the whole Microsoft sign-in redirect dance for an Xbox identity and returns the signed-in browser. */
async function signIn(xuid: string, gamertag: string, returnTo = `${SITE}/mods/#/staff`): Promise<Browser> {
  const start = await api(`/auth/microsoft/start?return_to=${encodeURIComponent(returnTo)}`);
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.get("Location")!);
  const state = consent.searchParams.get("state")!;
  const oauth = cookieValue(start, "__Host-cinnabar_oauth");
  const callback = await api(`/auth/microsoft/callback?code=${encodeURIComponent(`${xuid}:${gamertag}`)}&state=${state}`, {
    headers: { Cookie: `__Host-cinnabar_oauth=${oauth}` },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).toBe(returnTo);
  const cookie = `__Host-cinnabar_session=${cookieValue(callback, "__Host-cinnabar_session")}`;
  const me = (await (await api("/me", { headers: { Cookie: cookie } })).json()) as { csrf: string };
  const browser: Browser = {
    cookie, csrf: me.csrf,
    get: (path) => api(path, { headers: { Cookie: cookie, Origin: SITE } }),
    post: (path, body) => api(path, {
      method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Cookie: cookie, Origin: SITE, "X-Cinnabar-CSRF": me.csrf, "Content-Type": "application/json" },
    }),
  };
  return browser;
}

/** The client's next message, failing with `label` instead of hanging when none arrives. */
function next(client: Client, label: string): Promise<Record<string, unknown>> {
  return Promise.race([client.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${label}`)), 1500))]);
}

/** Whether `signature` (unpadded base64url) is the test signer's Ed25519 signature of `text`. */
async function verifies(text: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(PUBLIC_KEY), (c) => c.charCodeAt(0)), "Ed25519", false, ["verify"]);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("Ed25519", key, bytes, new TextEncoder().encode(text));
}

/** Posts a multipart submission as `browser`. */
const upload = (browser: Browser, form: FormData) =>
  api("/submissions", { method: "POST", body: form, headers: { Cookie: browser.cookie, Origin: SITE, "X-Cinnabar-CSRF": browser.csrf } });

/** Builds a component carrying only the given top-level custom sections. */
function component(sections: [string, string][], layer = [0x0d, 0, 1, 0]): Uint8Array {
  const bytes = [0, 0x61, 0x73, 0x6d, ...layer];
  const encoder = new TextEncoder();
  for (const [name, data] of sections) {
    const body = [...[encoder.encode(name).length], ...encoder.encode(name), ...encoder.encode(data)];
    bytes.push(0, body.length, ...body);
  }
  return new Uint8Array(bytes);
}

/** Submits a component built from `grants` through the multipart upload route. */
async function submit(browser: Browser, slug: string, version: string, grants: object, extra: object = {}, scan = true): Promise<Response> {
  const form = new FormData();
  form.set("listing", JSON.stringify({ slug, name: slug, summary: `A test mod called ${slug}.`, version, ...extra }));
  form.set("file", new File([component([["version", version], ["cinnabar:grants", JSON.stringify(grants)]])], `${slug}.wasm`));
  const result = await upload(browser, form);
  if (result.status === 200 && scan) await scanOne();
  return result;
}

/** Scanner protocol helper. The full trusted validator is exercised separately by the Node scanner tests. */
const scanner = (path: string, body?: unknown, lease?: string) => api(`/internal/marketplace/${path}`, {
  method: "POST", headers: { Authorization: "Bearer test-scanner-token", "Content-Type": "application/json", ...(lease ? { "X-Scan-Lease": lease } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** Fetches a claimed job's file with the scanner credential and `lease`. */
const scanFile = (job: any, sha256: string, lease: string = job.lease) => api(`/internal/marketplace/jobs/${job.id}/files/${sha256}`, {
  headers: { Authorization: "Bearer test-scanner-token", "X-Scan-Lease": lease },
});
async function claim(): Promise<any> { return ((await (await scanner("claim")).json()) as any).job; }
function report(job: any, extra: object = {}) {
  return { sha256: job.sha256, policy: SCAN_POLICY, validator: VALIDATOR, client_revision: CLIENT_REVISION, deterministic: "pass", imports: [], exports: [],
    media: job.media.map((m: { sha256: string }) => m.sha256), findings: [],
    ai: { verdict: "clear", model: "test-model", prompt: PROMPT_VERSION, findings: [] }, ...extra };
}
async function scanOne(extra: object = {}): Promise<Response> {
  const job = await claim();
  expect(job).toBeTruthy();
  const response = await scanner(`jobs/${job.id}/complete`, report(job, extra), job.lease);
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}

/** The owner promotes `gamertag` to `role` (owners manage admins; admins manage moderators). */
async function promote(by: Browser, gamertag: string, role: string): Promise<void> {
  const res = await by.post("/staff/people/role", { gamertag, role, reason: "Test staff" });
  expect(res.status, await res.clone().text()).toBe(200);
}

describe("marketplace policy", () => {
  const staff = (xuid: string, role: Actor["role"]): Actor => ({ xuid, role, suspended: false });

  it("files mods by their furthest capability and gates approvals by reach", () => {
    expect(reachOf({ hud: true })).toBe(0);
    expect(reachOf({ audio: true })).toBe(0);
    expect(reachOf({ clock: true })).toBe(1);
    expect(reachOf({ hud: true, entities: true })).toBe(1);
    expect(reachOf({ commands: ["tp"] })).toBe(3);
    expect(reachOf({ commands: [] })).toBe(0);
    expect(() => reachOf({ fly: true })).toThrow(/Unknown capability/);
    expect(approvalRule(4)).toEqual({ count: 2, admin: true });
    const network = { creator: "1", status: "submitted" as const, reach: 4 as const, approvals: [{ xuid: "2", admin: false }] };
    expect(canApprove(staff("3", "moderator"), network)).toEqual({ ok: false, reason: "Network mods need an admin's approval." });
    expect(canApprove(staff("4", "admin"), network).ok).toBe(true);
    expect(canApprove(staff("1", "owner"), { ...network, approvals: [] })).toEqual({ ok: false, reason: "You can't review your own mod." });
    expect(canSetRole(staff("5", "admin"), staff("6", "player"), "admin").ok).toBe(false);
    expect(canSetRole(staff("5", "owner"), staff("6", "player"), "admin").ok).toBe(true);
  });

  it("reads component metadata and grants without compiling them", () => {
    const parsed = readComponent(component([["version", "1.2.0"], ["cinnabar:grants", '{"camera":true}']]));
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.grants).toEqual({ camera: true });
    expect(() => readComponent(component([], [1, 0, 0, 0]))).toThrow(/core module/);
    expect(() => readComponent(component([["cinnabar:grants", '{"fly":true}']]))).toThrow(/Unknown capability/);
  });

  it("detects value-level authority changes and refuses ambiguous declarations", () => {
    expect(grantDiff({ commands: ["help"] }, { commands: ["help", "tp"] })).toMatchObject({
      added: [], changed: ["commands"], commands: { added: ["tp"], removed: [] }, expanded: true,
    });
    expect(grantDiff({ commands: ["help", "tp"] }, { commands: ["tp", "help", "help"] }).expanded).toBe(false);
    expect(() => readComponent(component([["cinnabar:grants", '{"hud":true,"h\\u0075d":false}']]))).toThrow(/Duplicate capability/);
    expect(() => readComponent(component([["cinnabar:grants", '{}'], ["cinnabar:grants", '{}']]))).toThrow(/Duplicate metadata/);
    expect(() => readComponent(component([], [13, 1, 1, 0]))).toThrow(/header/);
    expect(() => readComponent(new Uint8Array([0,97,115,109,13,0,1,0,0,255,255,255,255,16]))).toThrow(/Malformed length/);
  });

  it("bounds actual chunked bytes even when Content-Length lies", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
    await expect(readLimited(new Request("https://api.test", { method: "POST", body, headers: { "Content-Length": "1" } }), 10)).rejects.toBeInstanceOf(BodyLimitError);
    expect(cancelled).toBe(true);
  });
});

describe("Microsoft sign-in", () => {
  it("starts with PKCE and a browser-bound state, then signs the Xbox identity in", async () => {
    const start = await api(`/auth/microsoft/start?return_to=${encodeURIComponent("https://evil.test/")}`);
    const consent = new URL(start.headers.get("Location")!);
    expect(consent.origin + consent.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
    expect(consent.searchParams.get("scope")).toBe("XboxLive.signin");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("redirect_uri")).toBe("https://api.test/v1/auth/microsoft/callback");
    expect(start.headers.getSetCookie()[0]).toMatch(/^__Host-cinnabar_oauth=.+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);

    const browser = await signIn("2535400000001001", "Steve");
    const me = await (await browser.get("/me")).json() as { account: { gamertag: string; role: string }; game_online: boolean };
    expect(me.account).toMatchObject({ gamertag: "Steve", role: "player" });
    expect(me.game_online).toBe(false);
  });

  it("refuses a callback that didn't start in this browser and explains Xbox refusals", async () => {
    const start = await api("/auth/microsoft/start");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    expect((await api(`/auth/microsoft/callback?code=1:x&state=${state}`)).status).toBe(400);

    const again = await api("/auth/microsoft/start");
    const next = new URL(again.headers.get("Location")!).searchParams.get("state")!;
    const oauth = cookieValue(again, "__Host-cinnabar_oauth");
    const child = await api(`/auth/microsoft/callback?code=xerr:2148916238&state=${next}`, { headers: { Cookie: `__Host-cinnabar_oauth=${oauth}` } });
    expect(child.headers.get("Location")).toBe(`${SITE}/mods/?signin_error=child_account`);
    expect(child.headers.getSetCookie().some((c) => c.startsWith("__Host-cinnabar_session="))).toBe(false);
    // The state is single-use.
    expect((await api(`/auth/microsoft/callback?code=1:x&state=${next}`, { headers: { Cookie: `__Host-cinnabar_oauth=${oauth}` } })).status).toBe(400);
  });

  it("allows credentials only for the website and checks CSRF on every write", async () => {
    const preflight = await api("/mods/x/send", { method: "OPTIONS", headers: { Origin: SITE } });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect((await api("/mods/x/send", { method: "OPTIONS", headers: { Origin: "https://evil.test" } })).status).toBe(403);
    expect((await api("/mods", { headers: { Origin: "https://evil.test" } })).headers.get("Access-Control-Allow-Origin")).toBe("*");

    const browser = await signIn("2535400000001002", "Alex");
    const noToken = await api("/auth/signout", { method: "POST", headers: { Cookie: browser.cookie, Origin: "https://evil.test" } });
    expect(noToken.status).toBe(403);
    const missing = await api("/mods/nothing/send", { method: "POST", headers: { Cookie: browser.cookie, Origin: SITE } });
    expect(missing.status).toBe(403);
    expect((await browser.post("/mods/nothing/send")).status).toBe(404);
    expect((await api("/staff/queue", { headers: { Cookie: browser.cookie } })).status).toBe(403);
    expect((await api("/staff/queue")).status).toBe(401);
  });
});

describe("submission, review and delivery", () => {
  it("keeps a mod private until staff approve it, signs it, and delivers it to the player's game", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000002001", "BlockSmith42");
    const moderator = await signIn("2535400000002002", "PixelWarden");
    await promote(owner, "PixelWarden", "moderator");

    const submitted = await submit(creator, "compass", "0.1.0", { hud: true, player_state: true });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const version = await submitted.json() as { id: string; reach: number; status: string; sha256: string };
    expect(version).toMatchObject({ reach: 1, status: "submitted" });
    expect((await api("/mods/compass")).status).toBe(404);
    expect((await api(`/mods/assets/${version.sha256}`)).status).toBe(404);
    expect((await moderator.get(`/staff/versions/${version.id}/file`)).status).toBe(200);
    expect((await submit(creator, "compass", "0.1.0", {})).status).toBe(409);

    const approved = await moderator.post(`/staff/versions/${version.id}/decision`, { decision: "approve" });
    expect((await approved.json() as { status: string }).status).toBe("approved");
    const listing = await (await api("/mods/compass")).json() as {
      reviewed_by: string; capabilities: string[]; release: { statement: string; signature: string };
    };
    expect(listing.reviewed_by).toBe("PixelWarden");
    expect(listing.capabilities).toEqual(["hud", "player_state"]);
    expect(await verifies(listing.release.statement, listing.release.signature)).toBe(true);
    expect(JSON.parse(listing.release.statement)).toMatchObject({ slug: "compass", version: "0.1.0", sha256: version.sha256 });
    const file = await api(`/mods/assets/${version.sha256}`);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));

    const player = await signIn("2535400000002003", "MossyCobble");
    const { client } = await login({ xuid: "2535400000002003" });
    open.push(client);
    expect(((await (await player.get("/me")).json()) as { game_online: boolean }).game_online).toBe(true);
    expect((await player.post("/mods/compass/send")).status).toBe(200);
    const pushed = await next(client, "library push");
    expect(pushed).toMatchObject({ type: "mod_library", mods: [{ slug: "compass", version: "0.1.0", sha256: version.sha256, pulled: false }] });

    const { client: later, welcome } = await login({ xuid: "2535400000002003" });
    open.push(later);
    expect(welcome.mod_library).toMatchObject([{ slug: "compass", grants: { hud: true, player_state: true } }]);

    // Pulling tells every holder why, removes the listing and the public file, and joins the signed revocation list.
    const admin = await signIn("2535400000002004", "RedstoneRook");
    await promote(owner, "RedstoneRook", "admin");
    expect((await moderator.post(`/staff/versions/${version.id}/pull`, { reason: "x" })).status).toBe(403);
    expect((await admin.post(`/staff/versions/${version.id}/pull`, { reason: "Crashes on Android" })).status).toBe(200);
    expect(await next(client, "pull push")).toMatchObject({ type: "mod_library", mods: [{ slug: "compass", pulled: true, pull_reason: "Crashes on Android" }] });
    expect((await api("/mods/compass")).status).toBe(404);
    expect((await api(`/mods/assets/${version.sha256}`)).status).toBe(404);
    const revocations = await api("/mods/revocations");
    expect(await revocations.json()).toMatchObject({ revoked: [{ slug: "compass", reason: "Crashes on Android" }] });
    expect(revocations.headers.get("X-Cinnabar-Signature")).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const audit = await (await admin.get("/staff/audit")).json() as { action: string; actor_name: string }[];
    expect(audit[0]).toMatchObject({ action: "pulled", actor_name: "RedstoneRook" });
  });

  it("needs two approvals, one from an admin, before a network mod goes public", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000003001", "QuartzQueue");
    const first = await signIn("2535400000003002", "ModOne");
    const second = await signIn("2535400000003003", "ModTwo");
    const admin = await signIn("2535400000003004", "AdminOne");
    await promote(owner, "AdminOne", "admin");
    await promote(owner, "ModOne", "moderator");
    await promote(owner, "ModTwo", "moderator");

    const noSource = await submit(creator, "party-sync", "0.3.0", { packets: true });
    expect(noSource.status).toBe(422);
    expect(((await noSource.json()) as { fields: Record<string, string> }).fields.source).toMatch(/source/);
    const { id } = await (await submit(creator, "party-sync", "0.3.0", { packets: true },
      { source: "https://github.com/quartzqueue/party-sync" })).json() as { id: string };

    expect(((await (await first.post(`/staff/versions/${id}/decision`, { decision: "approve" })).json()) as { status: string }).status).toBe("submitted");
    const blocked = await second.post(`/staff/versions/${id}/decision`, { decision: "approve" });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe("Network mods need an admin's approval.");
    expect((await first.post(`/staff/versions/${id}/decision`, { decision: "approve" })).status).toBe(403);
    expect((await creator.post(`/staff/versions/${id}/decision`, { decision: "approve" })).status).toBe(403);
    expect(((await (await admin.post(`/staff/versions/${id}/decision`, { decision: "approve" })).json()) as { status: string }).status).toBe("approved");
    expect(((await (await api("/mods/party-sync")).json()) as { reviewed_by: string }).reviewed_by).toBe("ModOne, AdminOne");
  });

  it("sends rejections and change requests back with a note, and limits reports", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000004001", "GhastlyGus");
    const moderator = await signIn("2535400000004002", "ModThree");
    await promote(owner, "ModThree", "moderator");
    const { id } = await (await submit(creator, "ore-glow", "0.1.0", { block_highlights: true, render_through_walls: true })).json() as { id: string };
    expect((await moderator.post(`/staff/versions/${id}/decision`, { decision: "reject" })).status).toBe(400);
    const rejected = await moderator.post(`/staff/versions/${id}/decision`, { decision: "reject", note: "Shows ores through walls." });
    expect(((await rejected.json()) as { status: string }).status).toBe("rejected");
    const mine = await (await creator.get("/me/mods")).json() as { slug: string; status: string; note: string }[];
    expect(mine[0]).toMatchObject({ slug: "ore-glow", status: "rejected", note: "Shows ores through walls." });

    const { id: ok } = await (await submit(creator, "sky-tint", "0.1.0", { environment: true })).json() as { id: string };
    await moderator.post(`/staff/versions/${ok}/decision`, { decision: "approve" });
    const reporter = await signIn("2535400000004003", "Reporter");
    expect((await reporter.post("/mods/sky-tint/reports", { reason: "broken", details: "short" })).status).toBe(400);
    for (let i = 0; i < 10; i++) {
      expect((await reporter.post("/mods/sky-tint/reports", { reason: "broken", details: "The panel won't close with Escape." })).status).toBe(200);
    }
    expect((await reporter.post("/mods/sky-tint/reports", { reason: "broken", details: "The panel won't close with Escape." })).status).toBe(429);
    const reports = await (await moderator.get("/staff/reports")).json() as { id: string; reporter_name: string }[];
    expect(reports[0]!.reporter_name).toBe("Reporter");
    expect((await moderator.post(`/staff/reports/${reports[0]!.id}/resolve`, { note: "Fixed in 0.1.1" })).status).toBe(200);
  });

  it("only lets owners manage admins, requires a fresh sign-in, and ends a demoted moderator's sessions", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const admin = await signIn("2535400000005001", "AdminTwo");
    const target = await signIn("2535400000005002", "Helper");
    await promote(owner, "AdminTwo", "admin");
    expect((await admin.post("/staff/people/role", { gamertag: "Helper", role: "admin", reason: "x" })).status).toBe(403);
    expect((await admin.post("/staff/people/role", { gamertag: "OreKeeper", role: "player", reason: "x" })).status).toBe(403);
    expect((await admin.post("/staff/people/role", { gamertag: "helper", role: "moderator", reason: "" })).status).toBe(400);
    await promote(admin, "helper", "moderator");
    expect((await target.get("/staff/queue")).status).toBe(200);
    const people = await (await admin.get("/staff/people")).json() as { gamertag: string; role: string }[];
    expect(people.map((p) => [p.gamertag, p.role])).toEqual(expect.arrayContaining([["OreKeeper", "owner"], ["Helper", "moderator"]]));

    await runInDurableObject(hub(), (_: Hub, state) => {
      state.storage.sql.exec("UPDATE web_sessions SET created_at = created_at - 3600000 WHERE xuid = ?", "2535400000005001");
    });
    const stale = await admin.post("/staff/people/role", { gamertag: "Helper", role: "player", reason: "Stepped down" });
    expect(stale.status).toBe(401);
    await promote(await signIn("2535400000005001", "AdminTwo"), "Helper", "player");
    expect((await target.get("/staff/queue")).status).toBe(401);
  });
});

describe("upload and publication pipeline", () => {
  let creatorId = 2535400000006200n;
  /** Create an explicitly established project with one human-approved baseline. */
  async function established(slug: string, version = "1.0.0") {
    const owner = await signIn(OWNER, "OreKeeper");
    const gamertag = `Creator${String(++creatorId).slice(-4)}`;
    const creator = await signIn(String(creatorId), gamertag);
    const initial = await (await submit(creator, slug, version, { hud: true })).json() as { id: string };
    expect((await owner.post(`/staff/versions/${initial.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await owner.post(`/staff/mods/${slug}/trust`, { trusted: true, reason: "Established project reviewed by staff" })).status).toBe(200);
    return { owner, creator, initial, gamertag };
  }

  it("persists original signed bytes across policy changes and store restarts", async () => {
    const { initial } = await established("historical-signature", "8.7.41");
    const original = await (await api("/mods/historical-signature")).json() as any;
    const historical = JSON.stringify({ ...JSON.parse(original.release.statement), policy: "historical-policy", client_revision: "a".repeat(40) });
    const signature = await signText(env.MARKETPLACE_SIGNING_KEY!, historical);
    await runInDurableObject(hub(), (_: Hub, state) => {
      expect(state.storage.sql.exec<{ statement: string }>("SELECT statement FROM mod_versions WHERE id = ?", Number(initial.id)).toArray()[0]!.statement).toBe(original.release.statement);
      // Model a release signed by an older server, then restart under today's contract/policy.
      state.storage.sql.exec("UPDATE mod_versions SET statement = ?, signature = ? WHERE id = ?", historical, signature, Number(initial.id));
      const restored = new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      expect(restored.statement(Number(initial.id))).toBe(historical);
    });
    for (const path of ["/mods/historical-signature", `/mods/historical-signature/releases/${original.version}/${original.sha256}`]) {
      expect(await (await api(path)).json()).toMatchObject({ release: { statement: historical, signature } });
    }
    expect(await verifies(historical, signature)).toBe(true);
  });

  it("holds legacy signatures without original statement bytes for fresh scanning and review", async () => {
    const { initial, owner } = await established("missing-statement", "8.7.42");
    await runInDurableObject(hub(), (_: Hub, state) => {
      state.storage.sql.exec("UPDATE mod_versions SET statement = NULL WHERE id = ?", Number(initial.id));
      state.storage.sql.exec("DELETE FROM market_schema WHERE version = 2");
      new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      expect(state.storage.sql.exec("SELECT 1 FROM mod_approvals WHERE version_id = ?", Number(initial.id)).toArray()).toHaveLength(0);
    });
    expect((await api("/mods/missing-statement")).status).toBe(404);
    expect(await (await owner.get(`/staff/versions/${initial.id}`)).json()).toMatchObject({ status: "submitted", scan: { state: "queued" } });
    await scanOne();
    expect((await owner.post(`/staff/versions/${initial.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await api("/mods/missing-statement")).status).toBe(200);
  });

  it("removes exact browser library selections with session, CSRF and stale-send protection", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006291", "RemovalCreator");
    const player = await signIn("2535400000006292", "RemovalPlayer");
    const other = await signIn("2535400000006293", "OtherRemovalPlayer");
    const version = await (await submit(creator, "browser-removal", "7.4.93", { hud: true })).json() as { id: string };
    expect((await owner.post(`/staff/versions/${version.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await player.post("/mods/browser-removal/send")).status).toBe(200);
    const read = async () => (await (await player.get("/me")).json() as {
      library: { slug: string; sha256: string; sent_at: string }[];
    }).library;
    const selected = (await read())[0]!;
    await runInDurableObject(hub(), (_: Hub, state) => {
      state.storage.sql.exec("DELETE FROM mod_library_clock WHERE xuid = ?", "2535400000006292");
      state.storage.sql.exec("DELETE FROM market_schema WHERE version = 3");
      new MarketplaceStore(state.storage.sql, new Set([OWNER]));
    });
    const path = "/mods/browser-removal/remove";
    expect((await api(path, { method: "POST", headers: { Origin: SITE }, body: JSON.stringify(selected) })).status).toBe(401);
    expect((await api(path, { method: "POST", headers: { Origin: SITE, Cookie: player.cookie }, body: JSON.stringify(selected) })).status).toBe(403);
    expect((await api(path, { method: "POST", headers: { Origin: "https://evil.test", Cookie: player.cookie,
      "X-Cinnabar-CSRF": player.csrf }, body: JSON.stringify(selected) })).status).toBe(403);
    expect((await other.post(path, { ...selected, xuid: "2535400000006292" })).status).toBe(409);
    expect((await player.post(path, null)).status).toBe(400);
    for (const body of [{}, [], { ...selected, sha256: "invalid" }, { ...selected, sent_at: "invalid" },
      { ...selected, sent_at: 123 }, { ...selected, sent_at: "x".repeat(1000) }]) {
      expect((await player.post(path, body)).status).toBe(422);
    }
    expect(await read()).toEqual([selected]);
    // A later send of the very same bytes is still a different selection.
    await runInDurableObject(hub(), (_: Hub, state) => {
      const store = new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      const now = Date.parse(selected.sent_at);
      store.signIn("2535400000006292", "RemovalPlayer", "removal-fixture-session", "removal-fixture-csrf", now);
      expect(store.send({ session: "removal-fixture-session", csrf: "removal-fixture-csrf" }, "browser-removal", now).status).toBe(200);
    });
    expect((await player.post(path, selected)).status).toBe(409);
    let current = (await read())[0]!;
    expect(current.sent_at).not.toBe(selected.sent_at);
    expect((await player.post(path, { ...current, sha256: "0".repeat(64) })).status).toBe(409);
    await runInDurableObject(hub(), (_: Hub, state) => {
      let store = new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      expect(store.removeLibrary("2535400000006292", current.slug, current.sha256, current.sent_at)).toBe(true);
      store = new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      expect(store.send({ session: "removal-fixture-session", csrf: "removal-fixture-csrf" }, current.slug, Date.parse(current.sent_at)).status).toBe(200);
    });
    expect((await player.post(path, current)).status).toBe(409);
    const readded = (await read())[0]!;
    expect(readded.sent_at).not.toBe(current.sent_at);
    current = readded;
    // Hidden/pulled releases remain removable even though the catalogue cannot serve them.
    expect((await owner.post(`/staff/versions/${version.id}/pull`, { reason: "Removal fixture withdrawal" })).status).toBe(200);
    expect((await api("/mods/browser-removal")).status).toBe(404);
    const { client } = await login({ xuid: "2535400000006292" });
    open.push(client);
    const removed = await player.post(path, current);
    expect(removed.headers.get("Cache-Control")).toBe("no-store");
    expect(await removed.json()).toEqual({ removed: true });
    expect(await next(client, "browser removal push")).toMatchObject({ type: "mod_library", mods: [] });
    expect(await read()).toEqual([]);
  });

  it("serves the exact older signed release and signs expiring revocation evidence", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006199", "PinnedReleaseCreator");
    const initial = await (await submit(creator, "pinned-client", "7.4.91", { hud: true })).json() as { id: string };
    expect((await owner.post(`/staff/versions/${initial.id}/decision`, { decision: "approve" })).status).toBe(200);
    const baseline = await (await owner.get(`/staff/versions/${initial.id}`)).json() as { sha256: string };
    const path = `/mods/pinned-client/releases/7.4.91/${baseline.sha256}`;
    const original = await (await api(path)).json();
    expect(original).toMatchObject({ release: { statement: expect.any(String), signature: expect.any(String) } });
    expect((await api(`/mods/pinned-client/releases/7.4.90/${baseline.sha256}`)).status).toBe(404);
    const player = await signIn("2535400000006197", "LibraryRemovalPlayer");
    const { client } = await login({ xuid: "2535400000006197" });
    const { client: other } = await login({ xuid: "2535400000006196" });
    open.push(client, other);
    expect((await player.post("/mods/pinned-client/send")).status).toBe(200);
    const pushed = await next(client, "library selection") as { mods: { slug: string; sha256: string; sent_at: string }[] };
    const selected = pushed.mods[0]!;
    const remove = { type: "mod_library_remove", slug: selected.slug, sha256: selected.sha256, sent_at: selected.sent_at };
    other.send(remove);
    expect(await next(other, "other account removal acknowledgement")).toMatchObject({ type: "mod_library", mods: [] });
    client.send({ ...remove, sent_at: "2000-01-01T00:00:00.000Z" });
    expect(await next(client, "stale removal acknowledgement")).toMatchObject({ mods: [{ slug: "pinned-client" }] });
    client.send(remove);
    expect(await next(client, "exact removal acknowledgement")).toMatchObject({ mods: [] });
    expect(await (await player.get("/me")).json()).toMatchObject({ library: [] });
    const updated = await (await submit(creator, "pinned-client", "7.4.92", { hud: true })).json() as { id: string };
    expect((await owner.post(`/staff/versions/${updated.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect(await (await api(path)).json()).toEqual(original);
    expect((await api(`/mods/other-project/releases/7.4.91/${baseline.sha256}`)).status).toBe(404);
    expect((await owner.post(`/staff/versions/${initial.id}/pull`, { reason: "Synthetic revoked release" })).status).toBe(200);
    expect((await api(path)).status).toBe(404);
    const response = await api("/mods/revocations");
    const text = await response.text();
    const body = JSON.parse(text) as { issued_at: number; expires_at: number };
    expect(body.issued_at).toBeLessThanOrEqual(Date.now());
    expect(body.expires_at - body.issued_at).toBe(15 * 60_000);
    expect(await verifies(text, response.headers.get("X-Cinnabar-Signature")!)).toBe(true);
  });

  it("authenticates uploads before reading bodies and gives scanner tokens no staff privileges", async () => {
    expect((await api("/submissions", { method: "POST", body: "invalid body" })).status).toBe(401);
    expect((await api("/internal/marketplace/claim", { method: "POST" })).status).toBe(401);
    expect((await api("/staff/queue", { headers: { Authorization: "Bearer test-scanner-token" } })).status).toBe(401);
    const creator = await signIn("2535400000006101", "Uploader");
    expect((await api("/submissions", { method: "POST", body: "invalid body", headers: { Cookie: creator.cookie } })).status).toBe(403);
  });

  it("stores uploads in the file bucket and requires a current scan before approval", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006102", "PendingUploader");
    const v = await (await submit(creator, "pending-mod", "1.0.0", { hud: true }, {}, false)).json() as any;
    expect(v.scan.state).toBe("queued");
    expect(await env.MOD_FILES.head(`mods/${v.sha256}`)).not.toBeNull();
    expect((await api(`/mods/assets/${v.sha256}`)).status).toBe(404);
    const staffFile = await owner.get(`/staff/versions/${v.id}/file`);
    expect(staffFile.status).toBe(200);
    const bytes = await staffFile.arrayBuffer();
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(409);
    const job = await claim();
    const file = await scanFile(job, v.sha256);
    expect(file.status).toBe(200);
    expect(await file.arrayBuffer()).toEqual(bytes);
    expect((await scanFile(job, v.sha256, "wrong")).status).toBe(404);
    const bad = report(job, { sha256: "0".repeat(64) });
    expect((await scanner(`jobs/${job.id}/complete`, bad, job.lease)).status).toBe(422);
    expect((await scanner(`jobs/${job.id}/complete`, report(job, { policy: "old-policy" }), job.lease)).status).toBe(422);
    expect((await scanner(`jobs/${job.id}/complete`, report(job), job.lease)).status).toBe(200);
    const duplicate = await scanner(`jobs/${job.id}/complete`, report(job), job.lease);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect((await api(`/mods/assets/${v.sha256}`)).status).toBe(404);
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await api(`/mods/assets/${v.sha256}`)).status).toBe(200);
  });

  it("automatically publishes a checked established update once and preserves its signed evidence", async () => {
    const { creator } = await established("trusted-mod");
    const v = await (await submit(creator, "trusted-mod", "1.0.1", { hud: true }, {}, false)).json() as any;
    const job = await claim();
    const result = await scanner(`jobs/${job.id}/complete`, report(job), job.lease);
    expect(await result.json()).toMatchObject({ automatic: true });
    const listing = await (await api("/mods/trusted-mod")).json() as any;
    expect(listing).toMatchObject({ version: "1.0.1", publication: "automatic" });
    expect(JSON.parse(listing.release.statement)).toMatchObject({ sha256: v.sha256, policy: SCAN_POLICY, scan_job: job.id, publication: "automatic" });
    expect((await scanner(`jobs/${job.id}/complete`, report(job), job.lease)).status).toBe(200);
    const mine = await (await creator.get("/me/mods")).json() as any[];
    expect(mine.filter(x => x.version === "1.0.1")).toHaveLength(1);
  });

  it("holds permission expansion, metadata changes, and new imports for a human", async () => {
    const { creator } = await established("changed-mod");
    for (const [version, grants, extra, scan] of [
      ["1.1.0", { hud: true, players: true }, {}, {}],
      ["1.2.0", { hud: true }, { summary: "A description staff have not seen yet." }, {}],
      ["1.3.0", { hud: true }, {}, { imports: ["cinnabar:extension/hud@0.1.0"] }],
    ] as const) {
      await submit(creator, "changed-mod", version, grants, extra, false);
      expect(await (await scanOne(scan)).json()).toMatchObject({ automatic: false });
    }
    expect(await (await api("/mods/changed-mod")).json()).toMatchObject({ version: "1.0.0" });
  });

  it("holds AI flags for explained human review and blocks errors or deterministic failures", async () => {
    const { owner, creator } = await established("flagged-mod");
    const v = await (await submit(creator, "flagged-mod", "1.1.0", { hud: true }, {}, false)).json() as any;
    await scanOne({ ai: { verdict: "flag", model: "test-model", prompt: PROMPT_VERSION, findings: ["Suspicious string"] } });
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(422);
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve", note: "Reviewed the finding against the submitted artifact" })).status).toBe(200);
    for (const [version, failure] of [
      ["1.2.0", { deterministic: "block", findings: ["Unsupported host import"] }],
      ["1.3.0", { ai: { verdict: "error", model: "test-model", prompt: PROMPT_VERSION, findings: ["Timed out"] } }],
    ] as const) {
      const failed = await (await submit(creator, "flagged-mod", version, { hud: true }, {}, false)).json() as any;
      await scanOne(failure);
      expect((await owner.post(`/staff/versions/${failed.id}/decision`, { decision: "approve", note: "Cannot bypass checks" })).status).toBe(409);
    }
  });

  it("rechecks revoked trust, open reports, suspension and the exact baseline at completion", async () => {
    const { owner, creator, initial, gamertag } = await established("revoked-mod");
    await submit(creator, "revoked-mod", "1.1.0", { hud: true }, {}, false);
    const job = await claim();
    await owner.post("/staff/mods/revoked-mod/trust", { trusted: false, reason: "Incident under review" });
    expect(await (await scanner(`jobs/${job.id}/complete`, report(job), job.lease)).json()).toMatchObject({ automatic: false });
    await owner.post("/staff/mods/revoked-mod/trust", { trusted: true, reason: "New review completed" });
    await submit(creator, "revoked-mod", "1.2.0", { hud: true }, {}, false);
    const nextJob = await claim();
    const reporter = await signIn("2535400000006103", "IncidentReporter");
    await reporter.post("/mods/revoked-mod/reports", { reason: "malicious", details: "Please check this suspicious behavior." });
    expect(await (await scanner(`jobs/${nextJob.id}/complete`, report(nextJob), nextJob.lease)).json()).toMatchObject({ automatic: false });
    await owner.post(`/staff/versions/${initial.id}/pull`, { reason: "Withdrawn during investigation" });
    expect((await api("/mods/revoked-mod")).status).toBe(404);
    await owner.post("/staff/people/suspend", { gamertag, suspended: true, reason: "Incident under review" });
    expect((await submit(creator, "revoked-mod", "1.3.0", { hud: true })).status).toBe(403);
  });

  it("does not replace approved listing text with an unreviewed edit", async () => {
    const { creator, owner } = await established("snapshot-mod");
    const edit = await (await submit(creator, "snapshot-mod", "2.0.0", { hud: true }, { description: "Unreviewed text", name: "Changed name" })).json() as any;
    expect(await (await api("/mods/snapshot-mod")).json()).toMatchObject({ name: "snapshot-mod", description: "", version: "1.0.0" });
    await owner.post(`/staff/versions/${edit.id}/decision`, { decision: "approve" });
    expect(await (await api("/mods/snapshot-mod")).json()).toMatchObject({ name: "Changed name", description: "Unreviewed text", version: "2.0.0" });
  });

  it("reclaims expired leases, rejects stale completion and exhausts retries into a hold", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006104", "RetryCreator");
    const v = await (await submit(creator, "retry-mod", "1.0.0", { hud: true }, {}, false)).json() as any;
    const first = await claim();
    const expire = () => runInDurableObject(hub(), (_: Hub, state) => { state.storage.sql.exec("UPDATE mod_pipeline SET lease_until = ? WHERE version_id = ?", Date.now() - SCAN_LEASE_MS, Number(v.id)); });
    await expire();
    const second = await claim();
    expect(second.lease).not.toBe(first.lease);
    expect((await scanner(`jobs/${first.id}/complete`, report(first), first.lease)).status).toBe(409);
    await expire(); await claim(); await expire();
    expect(await claim()).toBeNull();
    expect(await (await owner.get(`/staff/versions/${v.id}`)).json()).toMatchObject({ scan: { state: "failed", attempts: 3 } });
    expect((await owner.post(`/staff/versions/${v.id}/rescan`)).status).toBe(200);
    expect((await claim()).id).not.toBe(first.id);
  });

  it("recovers publication after a stored file is restored without exposing an unsigned release", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006105", "RecoveryCreator");
    const v = await (await submit(creator, "recovery-mod", "1.0.0", { hud: true })).json() as any;
    const key = `mods/${v.sha256}`;
    const bytes = await (await env.MOD_FILES.get(key))!.arrayBuffer();
    await env.MOD_FILES.delete(key);
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(503);
    expect((await api("/mods/recovery-mod")).status).toBe(404);
    expect((await creator.post("/mods/recovery-mod/send")).status).toBe(404);
    await env.MOD_FILES.put(key, bytes);
    await hub().recoverModPublications();
    expect((await api("/mods/recovery-mod")).status).toBe(200);
  });

  it("holds a concurrently scanned update whose approved baseline changed", async () => {
    const { creator } = await established("parallel-mod");
    await submit(creator, "parallel-mod", "1.0.1", { hud: true }, {}, false);
    await submit(creator, "parallel-mod", "1.0.2", { hud: true }, {}, false);
    const first = await claim(); const second = await claim();
    expect(await (await scanner(`jobs/${first.id}/complete`, report(first), first.lease)).json()).toMatchObject({ automatic: true });
    expect(await (await scanner(`jobs/${second.id}/complete`, report(second), second.lease)).json()).toMatchObject({ automatic: false });
    expect(await (await api("/mods/parallel-mod")).json()).toMatchObject({ version: "1.0.1" });
  });

  it("rechecks trust after signing work and cannot commit an old publication ticket", async () => {
    const { creator } = await established("race-mod");
    const v = await (await submit(creator, "race-mod", "1.0.1", { hud: true }, {}, false)).json() as any;
    await runInDurableObject(hub(), (_: Hub, state) => {
      const store = new MarketplaceStore(state.storage.sql, new Set([OWNER]));
      const job = (store.claimScan(Date.now()).body as any).job;
      expect(store.completeScan(job.id, job.lease, report(job), Date.now()).approved).toBe(Number(v.id));
      const candidate = store.publicationReady(Number(v.id), Date.now())!;
      expect(candidate).not.toBeNull();
      state.storage.sql.exec("DELETE FROM mod_trust WHERE slug = ?", "race-mod");
      expect(store.publish(Number(v.id), candidate.statement, "signature-from-outdated-ticket", Date.now())).toBe(false);
    });
    expect(await (await api("/mods/race-mod")).json()).toMatchObject({ version: "1.0.0" });
  });

  it("stores images with components, binds their hashes to scans and publishes after approval", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006106", "ImageCreator");
    const form = new FormData();
    form.set("listing", JSON.stringify({ slug: "image-mod", name: "Image mod", summary: "A mod with a screenshot.", version: "1.0.0",
      category: "Interface", license: "MIT", notes: "Initial screenshot release" }));
    form.set("file", new File([component([["cinnabar:grants", "{}"]])], "image-mod.wasm"));
    // Public synthetic 1x1 raster; actual full image decoding is tested by the scanner suite.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    form.append("images", new File([png], "Screenshot.png", { type: "image/png" }));
    form.set("image_metadata", JSON.stringify([{ caption: "HUD screenshot", alt: "Coordinates above the hotbar" }]));
    const result = await upload(creator, form);
    expect(result.status).toBe(200);
    const v = await result.json() as any;
    expect(v).toMatchObject({ category: "Interface", license: "MIT", notes: "Initial screenshot release", scan: { review_ready: false } });
    expect(v.gallery[0]).toMatchObject({ caption: "HUD screenshot", alt: "Coordinates above the hotbar" });
    const mediaHash = v.gallery[0].sha256;
    expect(await env.MOD_FILES.head(`media/${mediaHash}`)).not.toBeNull();
    expect((await api(`/mods/media/${mediaHash}`)).status).toBe(404);
    const privatePath = `/me/mods/${v.id}/media/${mediaHash}`;
    expect((await creator.get(privatePath)).status).toBe(200);
    expect((await owner.get(privatePath)).status).toBe(200);
    expect((await api(privatePath)).status).toBe(404);
    const stranger = await signIn("2535400000006108", "ImageStranger");
    expect((await stranger.get(privatePath)).status).toBe(404);
    const job = await claim();
    expect((await scanner(`jobs/${job.id}/complete`, report(job, { media: [] }), job.lease)).status).toBe(422);
    expect((await scanner(`jobs/${job.id}/complete`, report(job), job.lease)).status).toBe(200);
    expect(await (await owner.get(`/staff/versions/${v.id}`)).json()).toMatchObject({ scan: { review_ready: true } });
    await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" });
    const publicView = await (await api("/mods/image-mod")).json() as any;
    expect(publicView).toMatchObject({ license: "MIT", category: "Interface", status: "approved", grants: {},
      history: [{ notes: "Initial screenshot release", publication: "manual" }], scan: { report: { deterministic: "pass" } } });
    expect(publicView.scan.report.findings).toBeUndefined();
    expect(publicView.scan.job).toBeUndefined();
    const image = await api(`/mods/media/${mediaHash}`);
    expect(image.status).toBe(200); expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    await owner.post(`/staff/versions/${v.id}/pull`, { reason: "Withdraw screenshot" });
    expect((await api(`/mods/media/${mediaHash}`)).status).toBe(404);
  });

  it("holds expired trust and refuses manual approval of an expired scan", async () => {
    const { creator, owner } = await established("expiry-mod");
    const v = await (await submit(creator, "expiry-mod", "1.0.1", { hud: true }, {}, false)).json() as any;
    await runInDurableObject(hub(), (_: Hub, state) => { state.storage.sql.exec("UPDATE mod_trust SET expires_at = 0 WHERE slug = ?", "expiry-mod"); });
    expect(await (await scanOne()).json()).toMatchObject({ automatic: false });
    await runInDurableObject(hub(), (_: Hub, state) => { state.storage.sql.exec("UPDATE mod_pipeline SET completed_at = 0 WHERE version_id = ?", Number(v.id)); });
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(409);
    expect(await (await api("/mods/expiry-mod")).json()).toMatchObject({ version: "1.0.0" });
  });

  it("upgrades pre-pipeline releases without moving stored files and retains access across rescans", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000006107", "LegacyCreator");
    const v = await (await submit(creator, "legacy-mod", "0.9.7", { hud: true }, {}, false)).json() as any;
    const key = `mods/${v.sha256}`;
    const bytes = await (await env.MOD_FILES.get(key))!.arrayBuffer();
    await runInDurableObject(hub(), (_: Hub, state) => {
      // Older stores retain this unused column; upgrades must work without rebuilding the table.
      state.storage.sql.exec("ALTER TABLE mod_pipeline ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
      state.storage.sql.exec("DELETE FROM mod_pipeline WHERE version_id = ?", Number(v.id));
      state.storage.sql.exec("UPDATE mod_versions SET status = 'approved', signature = 'old-signature' WHERE id = ?", Number(v.id));
      state.storage.sql.exec("DELETE FROM market_schema WHERE version = 1");
      new MarketplaceStore(state.storage.sql, new Set([OWNER]));
    });
    expect((await api(`/mods/assets/${v.sha256}`)).status).toBe(404);
    const rescan = await owner.post(`/staff/versions/${v.id}/rescan`);
    expect(rescan.status).toBe(200);
    const job = await claim();
    const file = await scanFile(job, v.sha256);
    expect(file.status).toBe(200); expect(await file.arrayBuffer()).toEqual(bytes);
    expect((await scanner(`jobs/${job.id}/complete`, report(job), job.lease)).status).toBe(200);
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await api("/mods/legacy-mod")).status).toBe(200);
  });

  it("rejects unmatched or oversized image captions before storing a release", async () => {
    const creator = await signIn("2535400000006109", "MetadataCreator");
    for (const metadata of [[], [{ caption: "x".repeat(161), alt: "" }], [{ caption: "Caption", alt: null }], [{ caption: "Lone \ud83d", alt: "" }]]) {
      const form = new FormData();
      form.set("listing", JSON.stringify({ slug: "bad-image-meta", name: "Bad metadata", summary: "A metadata validation fixture.", version: "1.0.0" }));
      form.set("file", new File([component([])], "fixture.wasm"));
      form.append("images", new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])], "fixture.png"));
      form.set("image_metadata", JSON.stringify(metadata));
      expect((await upload(creator, form)).status).toBe(422);
    }
    expect(await (await creator.get("/me/mods")).json()).toEqual([]);
  });
});

/** Publishes `slug` from a fresh creator with one owner approval. */
async function published(owner: Browser, creatorXuid: string, slug: string) {
  const creator = await signIn(creatorXuid, `Maker${creatorXuid.slice(-4)}`);
  const v = await (await submit(creator, slug, "1.0.0", { hud: true })).json() as { id: string };
  expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(200);
  return { creator, v };
}

describe("moderation input and targeting", () => {
  it("keeps pull reasons well-formed so every client can parse the signed revocation list", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const { v } = await published(owner, "2535400000007101", "unicode-pull");
    expect((await owner.post(`/staff/versions/${v.id}/pull`, { reason: "Broken \ud83d" })).status).toBe(422);
    // The 500th UTF-16 unit is the emoji's high surrogate.
    const reason = `${"a".repeat(499)}\u{1F600} and more`;
    expect((await owner.post(`/staff/versions/${v.id}/pull`, { reason })).status).toBe(200);
    const text = await (await api("/mods/revocations")).text();
    expect(text).not.toMatch(/\\ud[89a-f]/i);
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new TextEncoder().encode(text));
    const revoked = (JSON.parse(strict) as { revoked: { slug: string; reason: string }[] }).revoked;
    const entry = revoked.find((r) => r.slug === "unicode-pull")!;
    expect(entry.reason.isWellFormed()).toBe(true);
    expect(entry.reason).toBe(`${"a".repeat(499)}\u{1F600}`);
  });

  it("refuses ill-formed staff and creator text before it reaches stored or signed bodies", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000007102", "TextCreator");
    const bad = await submit(creator, "lone-text", "1.0.0", { hud: true }, { name: "Lone \udc00" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ fields: { name: expect.any(String) } });
    const commands = await submit(creator, "lone-text", "1.0.0", { commands: ["lone\ud83d"] }, { source: "https://github.com/cinnabar-mc/lone-text" });
    expect(commands.status).toBe(422);
    expect(await commands.json()).toMatchObject({ error: expect.stringContaining("Unicode") });
    const v = await (await submit(creator, "lone-text", "1.0.0", { hud: true })).json() as { id: string };
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "changes", note: "Fix \ud83d" })).status).toBe(422);
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(200);
    const reporter = await signIn("2535400000007103", "TextReporter");
    expect((await reporter.post("/mods/lone-text/reports", { reason: "broken", details: "It crashes on load \ud83d" })).status).toBe(422);
    expect((await owner.post("/staff/mods/lone-text/hide", { hidden: false, reason: "Audit \ud83d" })).status).toBe(422);
  });

  it("makes legacy stored text well-formed in signed release statements", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000007104", "LegacyTextCreator");
    const v = await (await submit(creator, "legacy-text", "1.0.0", { hud: true })).json() as { id: string };
    await runInDurableObject(hub(), (_: Hub, state) => {
      const row = state.storage.sql.exec<{ metadata: string }>("SELECT metadata FROM mod_pipeline WHERE version_id = ?", Number(v.id)).one();
      // JSON keeps the lone surrogate as an ASCII escape, so it survives storage.
      const metadata = JSON.stringify({ ...JSON.parse(row.metadata), name: "Legacy \ud83d" });
      state.storage.sql.exec("UPDATE mod_pipeline SET metadata = ? WHERE version_id = ?", metadata, Number(v.id));
    });
    expect((await owner.post(`/staff/versions/${v.id}/decision`, { decision: "approve" })).status).toBe(200);
    const { release } = await (await api("/mods/legacy-text")).json() as { release: { statement: string; signature: string } };
    expect(release.statement).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(release.statement)).toMatchObject({ metadata: { name: "Legacy \ufffd" } });
    expect(await verifies(release.statement, release.signature)).toBe(true);
  });

  it("refuses role changes and suspensions when several accounts share a gamertag", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    await signIn("2535400000007111", "Twin");
    await signIn("2535400000007112", "twin");
    const role = await owner.post("/staff/people/role", { gamertag: "Twin", role: "moderator", reason: "Ambiguous target" });
    expect(role.status).toBe(409);
    const suspend = await owner.post("/staff/people/suspend", { gamertag: "TWIN", suspended: true, reason: "Ambiguous target" });
    expect(suspend.status).toBe(409);
    const people = await (await owner.get("/staff/people")).json() as { xuid: string }[];
    expect(people.map((p) => p.xuid)).not.toEqual(expect.arrayContaining(["2535400000007111"]));
    expect(people.map((p) => p.xuid)).not.toEqual(expect.arrayContaining(["2535400000007112"]));
  });

  it("refuses reports from suspended accounts and against hidden listings", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    await published(owner, "2535400000007121", "report-gates");
    const details = { reason: "broken", details: "The panel won't close with Escape." };
    const suspended = await signIn("2535400000007122", "SuspendedReporter");
    expect((await owner.post("/staff/people/suspend", { gamertag: "SuspendedReporter", suspended: true, reason: "Spam reports" })).status).toBe(200);
    expect((await suspended.post("/mods/report-gates/reports", details)).status).toBe(403);
    const reporter = await signIn("2535400000007123", "HiddenReporter");
    expect((await owner.post("/staff/mods/report-gates/hide", { hidden: true, reason: "Under review" })).status).toBe(200);
    expect((await reporter.post("/mods/report-gates/reports", details)).status).toBe(404);
    const reports = await (await owner.get("/staff/reports")).json() as { slug: string }[];
    expect(reports.filter((r) => r.slug === "report-gates")).toEqual([]);
  });

  it("forbids staff from rescanning their own pending release", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const creator = await signIn("2535400000007131", "StaffCreator");
    await promote(owner, "StaffCreator", "moderator");
    const v = await (await submit(creator, "self-rescan", "1.0.0", { hud: true })).json() as { id: string };
    const own = await creator.post(`/staff/versions/${v.id}/rescan`);
    expect(own.status).toBe(403);
    expect(await (await owner.get(`/staff/versions/${v.id}`)).json()).toMatchObject({ scan: { state: "complete" } });
    expect((await owner.post(`/staff/versions/${v.id}/rescan`)).status).toBe(200);
  });
});

describe("staff conflicts, public load and revocation limits", () => {
  // Earlier tests can leave jobs queued, such as a requested rescan; scanOne claims the oldest job.
  beforeAll(async () => {
    for (let job = await claim(); job; job = await claim()) await scanner(`jobs/${job.id}/complete`, report(job), job.lease);
  });

  it("refuses staff hiding, restoring or resolving reports on their own mod, and leaves restoring to admins", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const admin = await signIn("2535400000008001", "ConflictAdmin");
    const reviewer = await signIn("2535400000008002", "ConflictReviewer");
    const { creator, v } = await published(owner, "2535400000008003", "conflict-mod");
    await promote(owner, "ConflictAdmin", "admin");
    await promote(owner, "ConflictReviewer", "moderator");
    await promote(owner, "Maker8003", "moderator");
    const hide = (by: Browser, body: unknown) => by.post("/staff/mods/conflict-mod/hide", body);
    expect((await hide(creator, { hidden: true, reason: "Hiding my own mod" })).status).toBe(403);
    expect((await hide(admin, { hidden: true, reason: "Reported as malicious" })).status).toBe(200);
    expect((await hide(creator, { hidden: false, reason: "Restoring my own mod" })).status).toBe(403);
    expect((await hide(reviewer, { hidden: false, reason: "Looks fine to me" })).status).toBe(403);
    // A missing or non-boolean value is not a restoration.
    expect((await hide(admin, { reason: "No explicit value" })).status).toBe(422);
    expect((await hide(admin, { hidden: "false", reason: "String value" })).status).toBe(422);
    expect((await hide(admin, { hidden: 0, reason: "Number value" })).status).toBe(422);
    expect((await api("/mods/conflict-mod")).status).toBe(404);
    expect((await hide(admin, { hidden: false, reason: "Administrative review completed" })).status).toBe(200);
    expect((await api("/mods/conflict-mod")).status).toBe(200);

    // An open report holds the creator's trusted updates; they can't clear it themselves.
    expect((await owner.post("/staff/mods/conflict-mod/trust", { trusted: true, reason: "Re-established after review" })).status).toBe(200);
    const reporter = await signIn("2535400000008004", "ConflictReporter");
    expect((await reporter.post("/mods/conflict-mod/reports", { reason: "malicious", details: "It sends my inventory somewhere." })).status).toBe(200);
    const reportId = (await (await owner.get("/staff/reports")).json() as { id: string; slug: string }[]).find(r => r.slug === "conflict-mod")!.id;
    expect((await creator.post(`/staff/reports/${reportId}/resolve`, { note: "Not malicious" })).status).toBe(403);
    expect((await (await owner.get("/staff/reports")).json() as { id: string; status: string }[]).find(r => r.id === reportId)!.status).toBe("open");
    await submit(creator, "conflict-mod", "1.0.1", { hud: true }, {}, false);
    expect(await (await scanOne()).json()).toMatchObject({ automatic: false });
    expect(await (await api("/mods/conflict-mod")).json()).toMatchObject({ version: "1.0.0", version_id: v.id });
    expect((await reviewer.post(`/staff/reports/${reportId}/resolve`, { note: "Checked the network calls" })).status).toBe(200);
  });

  it("refuses listing slugs that fixed routes under /mods/ would shadow", async () => {
    const fixed = new Set(marketplaceRoutes.routes.flatMap(route => /^\/mods\/([^/:*]+)/.exec(route.path)?.[1] ?? []));
    expect(fixed).toContain("revocations");
    for (const slug of fixed) {
      expect(validateListing({ slug, name: slug, summary: "A reserved slug fixture.", version: "1.0.0" }, 0).errors.slug, slug).toBeTruthy();
    }
    const creator = await signIn("2535400000008011", "ReservedCreator");
    const refused = await submit(creator, "revocations", "1.0.0", { hud: true }, {}, false);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ fields: { slug: expect.any(String) } });
  });

  it("stops automatic publication once the granting admin is demoted or suspended", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const granter = await signIn("2535400000008021", "TrustGranter");
    await promote(owner, "TrustGranter", "admin");
    const { creator } = await published(owner, "2535400000008022", "granted-mod");
    expect((await granter.post("/staff/mods/granted-mod/trust", { trusted: true, reason: "Reviewed the project history" })).status).toBe(200);
    const update = async (version: string) => {
      const v = await (await submit(creator, "granted-mod", version, { hud: true }, {}, false)).json() as { id: string };
      return { id: v.id, automatic: (await (await scanOne()).json() as { automatic: boolean }).automatic };
    };
    expect((await update("1.0.1")).automatic).toBe(true);
    await promote(owner, "TrustGranter", "moderator");
    const held = await update("1.0.2");
    expect(held.automatic).toBe(false);
    expect(await (await owner.get(`/staff/versions/${held.id}`)).json()).toMatchObject({ trust: { trusted: false } });
    await promote(owner, "TrustGranter", "admin");
    expect((await update("1.0.3")).automatic).toBe(true);
    expect((await owner.post("/staff/people/suspend", { gamertag: "TrustGranter", suspended: true, reason: "Account compromised" })).status).toBe(200);
    expect((await update("1.0.4")).automatic).toBe(false);
    expect(await (await api("/mods/granted-mod")).json()).toMatchObject({ version: "1.0.3" });
  });

  it("authorizes public screenshots exactly as before, through a digest index", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const admin = await signIn("2535400000008031", "MediaAdmin");
    await promote(owner, "MediaAdmin", "admin");
    const creator = await signIn("2535400000008032", "MediaCreator");
    /** Uploads a release with one PNG whose digest is unique to `version`, returning the version and image digest. */
    const release = async (version: string) => {
      const form = new FormData();
      form.set("listing", JSON.stringify({ slug: "indexed-media", name: "Indexed media", summary: "A screenshot index fixture.", version }));
      form.set("file", new File([component([["cinnabar:grants", "{}"]])], "indexed-media.wasm"));
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new TextEncoder().encode(`indexed-media ${version}`)]);
      form.append("images", new File([png], "screenshot.png", { type: "image/png" }));
      const v = await (await upload(creator, form)).json() as { id: string; sha256: string; gallery: { sha256: string }[] };
      await scanOne();
      return { id: v.id, sha256: v.sha256, image: v.gallery[0]!.sha256 };
    };
    const status = async (image: string) => (await api(`/mods/media/${image}`)).status;
    const first = await release("1.0.0");
    expect(await status(first.image)).toBe(404);
    expect((await owner.post(`/staff/versions/${first.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect(await status(first.image)).toBe(200);
    // A pending release's screenshot stays private while an older one of the same listing is public.
    const second = await release("1.1.0");
    expect(await status(second.image)).toBe(404);
    expect((await admin.post("/staff/mods/indexed-media/hide", { hidden: true, reason: "Media review" })).status).toBe(200);
    expect(await status(first.image)).toBe(404);
    expect((await admin.post("/staff/mods/indexed-media/hide", { hidden: false, reason: "Media reviewed" })).status).toBe(200);
    expect(await status(first.image)).toBe(200);
    expect((await owner.post("/staff/people/suspend", { gamertag: "MediaCreator", suspended: true, reason: "Media review" })).status).toBe(200);
    expect(await status(first.image)).toBe(404);
    expect((await owner.post("/staff/people/suspend", { gamertag: "MediaCreator", suspended: false, reason: "Media reviewed" })).status).toBe(200);
    expect(await status(first.image)).toBe(200);

    await runInDurableObject(hub(), (_: Hub, state) => {
      const sql = state.storage.sql;
      // Releases stored before the index existed are backfilled once.
      sql.exec("DELETE FROM mod_media");
      sql.exec("DELETE FROM market_schema WHERE version = 4");
      new MarketplaceStore(sql, new Set([OWNER]));
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const counting = { exec: (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = sql.exec(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      } } as unknown as SqlStorage;
      const store = new MarketplaceStore(counting, new Set([OWNER]));
      /** Rows the public checks for the first release read. */
      const rowsRead = () => {
        cursors.length = 0;
        expect(store.mediaAllowed(first.image)).toBe(true);
        expect(store.assetAllowed(first.sha256)).toBe(true);
        expect(store.mediaAllowed(second.image)).toBe(false);
        return cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
      };
      const before = rowsRead();
      // Many more published releases must not make each anonymous check read more rows.
      sql.exec(`INSERT INTO mod_listings (slug, creator, name, summary, description, source, created_at)
        VALUES ('bulk-media', '2535400000008033', 'Bulk', 'Bulk media fixture.', '', '', 0)`);
      for (let i = 0; i < 200; i++) {
        const hash = i.toString(16).padStart(64, "b");
        const id = sql.exec<{ id: number }>(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at,
          decided_at, signature, statement) VALUES ('bulk-media', ?, ?, 1, '{}', 0, 'approved', 0, 0, 'fixture', 'fixture') RETURNING id`,
          `0.0.${i}`, hash).one().id;
        sql.exec("INSERT INTO mod_pipeline (version_id, metadata, media, job_id, state) VALUES (?, '{}', ?, ?, 'complete')", id,
          JSON.stringify([{ sha256: hash.replace(/b/g, "c"), bytes: 12, type: "image/png", caption: "Bulk" }]), `bulk-media-${i}`);
      }
      sql.exec("DELETE FROM market_schema WHERE version = 4");
      new MarketplaceStore(sql, new Set([OWNER]));
      expect(store.mediaAllowed((7).toString(16).padStart(64, "b").replace(/b/g, "c"))).toBe(true);
      expect(rowsRead()).toBe(before);
      sql.exec("DELETE FROM mod_media WHERE version_id IN (SELECT id FROM mod_versions WHERE slug = 'bulk-media')");
      sql.exec("DELETE FROM mod_pipeline WHERE version_id IN (SELECT id FROM mod_versions WHERE slug = 'bulk-media')");
      sql.exec("DELETE FROM mod_versions WHERE slug = 'bulk-media'");
      sql.exec("DELETE FROM mod_listings WHERE slug = 'bulk-media'");
    });
    expect(await status(first.image)).toBe(200);
    expect((await owner.post(`/staff/versions/${first.id}/pull`, { reason: "Withdraw indexed screenshot" })).status).toBe(200);
    expect(await status(first.image)).toBe(404);
  });

  it("reuses a signed revocation list briefly and signs a new one after a pull", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const { v } = await published(owner, "2535400000008041", "memo-pull");
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const read = async () => {
        const response = await api("/mods/revocations");
        const text = await response.text();
        expect(await verifies(text, response.headers.get("X-Cinnabar-Signature")!)).toBe(true);
        return { text, body: JSON.parse(text) as { issued_at: number; revoked: { slug: string }[] } };
      };
      const first = await read();
      clock.mockReturnValue(start + 10_000);
      expect((await read()).text).toBe(first.text);
      expect((await owner.post(`/staff/versions/${v.id}/pull`, { reason: "Memo fixture withdrawal" })).status).toBe(200);
      const pulled = await read();
      expect(pulled.body.issued_at).toBe(start + 10_000);
      expect(pulled.body.revoked.map(r => r.slug)).toContain("memo-pull");
      clock.mockReturnValue(start + 10_000 + REVOCATION_MEMO_MS);
      expect((await read()).body.issued_at).toBe(start + 10_000 + REVOCATION_MEMO_MS);
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses a pull whose signed revocation list would exceed the client's size budget", async () => {
    const owner = await signIn(OWNER, "OreKeeper");
    const { v } = await published(owner, "2535400000008051", "budget-pull");
    const encoder = new TextEncoder();
    await runInDurableObject(hub(), (_: Hub, state) => {
      const sql = state.storage.sql;
      const store = new MarketplaceStore(sql, new Set([OWNER]));
      // Fill the list to within a few hundred bytes of the budget, tracking each appended entry's size.
      let size = encoder.encode(store.revocations(Date.now())).byteLength;
      for (let i = 0; size < REVOCATION_BUDGET_BYTES - 400; i++) {
        const reason = "r".repeat(Math.max(1, Math.min(500, REVOCATION_BUDGET_BYTES - 400 - size - 150)));
        const entry = { slug: "budget-filler", version: `0.0.${i}`, sha256: "d".repeat(64), reason };
        sql.exec(`INSERT INTO mod_versions (slug, version, sha256, bytes, grants, reach, status, submitted_at, pulled, pull_reason)
          VALUES (?, ?, ?, 1, '{}', 0, 'approved', 0, 1, ?)`, entry.slug, entry.version, entry.sha256, reason);
        size += encoder.encode(JSON.stringify(entry)).byteLength + 1;
      }
      size = encoder.encode(store.revocations(Date.now())).byteLength;
      expect(size).toBeGreaterThanOrEqual(REVOCATION_BUDGET_BYTES - 400);
      expect(size).toBeLessThanOrEqual(REVOCATION_BUDGET_BYTES - 200);
    });
    try {
      const refused = await owner.post(`/staff/versions/${v.id}/pull`, { reason: "x".repeat(500) });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: expect.stringContaining("revocation list") });
      expect((await api("/mods/budget-pull")).status).toBe(200);
      expect(await (await owner.get(`/staff/versions/${v.id}`)).json()).toMatchObject({ pulled: false });
      // A shorter reason still fits, and the list clients download stays within the budget.
      expect((await owner.post(`/staff/versions/${v.id}/pull`, { reason: "Short reason" })).status).toBe(200);
      const served = await (await api("/mods/revocations")).arrayBuffer();
      expect(served.byteLength).toBeLessThanOrEqual(REVOCATION_BUDGET_BYTES);
      expect(new TextDecoder().decode(served)).toContain("budget-pull");
    } finally {
      await runInDurableObject(hub(), (_: Hub, state) => { state.storage.sql.exec("DELETE FROM mod_versions WHERE slug = 'budget-filler'"); });
    }
  });
});
