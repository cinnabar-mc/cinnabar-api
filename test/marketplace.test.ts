import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { readComponent } from "../src/marketplace/component";
import { TOKEN_URL, XBOX_USER_URL, XSTS_URL } from "../src/marketplace/microsoft";
import { approvalRule, canApprove, canSetRole, reachOf, type Actor } from "../src/marketplace/policy";
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
async function submit(browser: Browser, slug: string, version: string, grants: object, extra: object = {}): Promise<Response> {
  const form = new FormData();
  form.set("listing", JSON.stringify({ slug, name: slug, summary: `A test mod called ${slug}.`, version, ...extra }));
  form.set("file", new File([component([["version", version], ["cinnabar:grants", JSON.stringify(grants)]])], `${slug}.wasm`));
  return api("/submissions", { method: "POST", body: form, headers: { Cookie: browser.cookie, Origin: SITE, "X-Cinnabar-CSRF": browser.csrf } });
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
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(PUBLIC_KEY), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(listing.release.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode(listing.release.statement))).toBe(true);
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
