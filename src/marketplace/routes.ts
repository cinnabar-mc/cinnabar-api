import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { encodeBase64Url } from "../identity";
import { hubFor } from "../routing";
import { MAX_COMPONENT_BYTES, readComponent } from "./component";
import { SignInFailure, authorizeUrl, pkceChallenge, randomToken, xboxIdentity } from "./microsoft";
import { PLAYER_SESSION_MS, type Caller, type MarketCall, type MarketResult, type MediaFile } from "./store";
import { BodyLimitError, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, imageType, readLimited, sha256 } from "./uploads";

const SESSION_COOKIE = "cinnabar_session";
const OAUTH_COOKIE = "cinnabar_oauth";
const CSRF_HEADER = "X-Cinnabar-CSRF";
const MAX_JSON_BYTES = 64 * 1024;

type Ctx = Context<{ Bindings: Env }>;

/** The configured website origin, normalised, or null while the marketplace's web access is unconfigured. */
function siteOrigin(env: Env): string | null {
  try {
    return env.MARKETPLACE_ORIGIN ? new URL(env.MARKETPLACE_ORIGIN).origin : null;
  } catch {
    return null;
  }
}

async function sessionHash(token: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

/** The caller's session hash and CSRF header, read from the request. */
async function caller(c: Ctx): Promise<Caller> {
  const token = getCookie(c, SESSION_COOKIE, "host");
  return { session: token ? await sessionHash(token) : undefined, csrf: c.req.header(CSRF_HEADER) };
}

async function call(c: Ctx, request: MarketCall): Promise<MarketResult> {
  return hubFor(c.env).marketplace(request);
}

function reply(c: Ctx, result: MarketResult, cache = "no-store"): Response {
  c.header("Cache-Control", cache);
  return c.json(result.body as object, result.status as 200);
}

/** Parses a small JSON body, or returns null when it's oversized or not JSON. */
async function readJson(c: Ctx): Promise<unknown | null> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readLimited(c.req.raw, MAX_JSON_BYTES));
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const id = (value: string): number | null => (/^[0-9]{1,12}$/.test(value) ? Number(value) : null);

/** Marketplace and web sign-in routes, mounted under `/v1`. */
export const marketplaceRoutes = new Hono<{ Bindings: Env }>();

/** Credentialed CORS for the configured website; anyone may read the public catalogue without credentials. */
const cors = async (c: Ctx, next: () => Promise<void>) => {
  const origin = c.req.header("Origin");
  const site = siteOrigin(c.env);
  const trusted = !!origin && origin === site;
  if (c.req.method === "OPTIONS") {
    if (!trusted) return c.body(null, 403);
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": `Content-Type, ${CSRF_HEADER}`,
      "Access-Control-Max-Age": "600", Vary: "Origin",
    });
  }
  // Writes from any other browser origin are refused outright; the CSRF token is the second check.
  if (c.req.method !== "GET" && origin && !trusted) return c.json({ error: "Unknown origin." }, 403);
  await next();
  c.res.headers.append("Vary", "Origin");
  if (trusted) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
  } else if (c.req.method === "GET" && c.req.path.startsWith("/v1/mods")) {
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  }
};
// Only marketplace paths, so the cached presence routes keep their own headers.
for (const path of ["/auth/*", "/me", "/me/*", "/mods", "/mods/*", "/submissions", "/staff/*"]) marketplaceRoutes.use(path, cors);

marketplaceRoutes.get("/auth/microsoft/start", async (c) => {
  const site = siteOrigin(c.env);
  if (!site || !c.env.MICROSOFT_CLIENT_ID) return c.json({ error: "Sign-in isn't configured yet." }, 503);
  let returnTo = `${site}/mods/`;
  const requested = c.req.query("return_to");
  if (requested) {
    try {
      const url = new URL(requested);
      if (url.origin === site) returnTo = url.toString();
    } catch {
      // Fall back to the marketplace page.
    }
  }
  const state = randomToken();
  const verifier = randomToken();
  await call(c, { op: "begin", state, verifier, returnTo });
  // Binds the pending sign-in to this browser, so a link can't sign someone into another person's account.
  setCookie(c, OAUTH_COOKIE, state, { prefix: "host", httpOnly: true, sameSite: "Lax", maxAge: 600 });
  c.header("Cache-Control", "no-store");
  const redirectUri = new URL("/v1/auth/microsoft/callback", c.req.url).toString();
  return c.redirect(authorizeUrl(c.env.MICROSOFT_CLIENT_ID, redirectUri, state, await pkceChallenge(verifier)), 302);
});

marketplaceRoutes.get("/auth/microsoft/callback", async (c) => {
  c.header("Cache-Control", "no-store");
  const site = siteOrigin(c.env);
  if (!site || !c.env.MICROSOFT_CLIENT_ID) return c.json({ error: "Sign-in isn't configured yet." }, 503);
  const state = c.req.query("state") ?? "";
  const expected = getCookie(c, OAUTH_COOKIE, "host");
  deleteCookie(c, OAUTH_COOKIE, { prefix: "host" });
  if (!state || state !== expected) return c.text("This sign-in didn't start in this browser. Go back and try again.", 400);
  const pending = await call(c, { op: "consume", state });
  if (pending.status !== 200) return c.text("This sign-in link expired. Go back and try again.", 400);
  const { verifier, returnTo } = pending.body as { verifier: string; returnTo: string };
  const back = (error?: string) => {
    const url = new URL(returnTo);
    if (error) url.searchParams.set("signin_error", error);
    return c.redirect(url.toString(), 302);
  };
  const code = c.req.query("code");
  if (!code) return back(c.req.query("error") === "access_denied" ? "cancelled" : "failed");
  let identity: { xuid: string; gamertag: string };
  try {
    identity = await xboxIdentity({
      clientId: c.env.MICROSOFT_CLIENT_ID, clientSecret: c.env.MICROSOFT_CLIENT_SECRET,
      redirectUri: new URL("/v1/auth/microsoft/callback", c.req.url).toString(), code, verifier,
    });
  } catch (error) {
    return back(error instanceof SignInFailure ? error.code : "failed");
  }
  const token = randomToken();
  await call(c, { op: "signin", ...identity, newSession: await sessionHash(token), newCsrf: randomToken(24) });
  setCookie(c, SESSION_COOKIE, token, { prefix: "host", httpOnly: true, sameSite: "Lax", maxAge: PLAYER_SESSION_MS / 1000 });
  return back();
});

marketplaceRoutes.post("/auth/signout", async (c) => {
  const result = await call(c, { op: "signout", ...(await caller(c)) });
  deleteCookie(c, SESSION_COOKIE, { prefix: "host" });
  return reply(c, result);
});

marketplaceRoutes.get("/me", async (c) => reply(c, await call(c, { op: "me", ...(await caller(c)) })));
marketplaceRoutes.get("/me/mods", async (c) => reply(c, await call(c, { op: "mine", ...(await caller(c)) })));
marketplaceRoutes.get("/mods", async (c) => reply(c, await call(c, { op: "mods" }), "public, max-age=30"));

marketplaceRoutes.get("/mods/revocations", async (c) => {
  const { body, signature } = await hubFor(c.env).modRevocations();
  c.header("Cache-Control", "public, max-age=60");
  if (signature) c.header("X-Cinnabar-Signature", signature);
  return c.body(body, 200, { "Content-Type": "application/json" });
});

/** Streams a stored component when the store allows it for this caller. */
async function asset(c: Ctx, sha256: string, cache: string): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: "Not found." }, 404);
  const allowed = await call(c, { op: "asset", sha256, ...(await caller(c)) });
  if (!(allowed.body as { allowed: boolean }).allowed) return c.json({ error: "Not found." }, 404);
  const object = await c.env.MOD_FILES.get(`mods/${sha256}`);
  if (!object) return c.json({ error: "Not found." }, 404);
  return c.body(object.body, 200, { "Content-Type": "application/wasm", "Cache-Control": cache, ETag: `"${sha256}"`,
    "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" });
}

marketplaceRoutes.get("/mods/assets/:sha256", (c) => asset(c, c.req.param("sha256"), "no-store"));
marketplaceRoutes.get("/mods/media/:sha256", async c => {
  const hash = c.req.param("sha256");
  if (!/^[0-9a-f]{64}$/.test(hash)) return c.notFound();
  const allowed = await call(c, { op: "media", sha256: hash });
  if (!(allowed.body as { allowed: boolean }).allowed) return c.notFound();
  const object = await c.env.MOD_FILES.get(`media/${hash}`);
  if (!object) return c.notFound();
  return c.body(object.body, 200, { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
});
marketplaceRoutes.get("/mods/:slug", async (c) => reply(c, await call(c, { op: "mod", slug: c.req.param("slug") }), "public, max-age=30"));

marketplaceRoutes.post("/mods/:slug/send", async (c) =>
  reply(c, await call(c, { op: "send", slug: c.req.param("slug"), ...(await caller(c)) })));

marketplaceRoutes.post("/mods/:slug/reports", async (c) => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "Send the report as JSON." }, 400);
  return reply(c, await call(c, { op: "report", slug: c.req.param("slug"), body, ...(await caller(c)) }));
});

/** A multipart upload: `listing` (JSON listing fields) and `file` (the `.wasm` component). */
marketplaceRoutes.post("/submissions", async (c) => {
  const who = await caller(c);
  const authenticated = await call(c, { op: "upload-auth", ...who });
  if (authenticated.status !== 200) return reply(c, authenticated);
  let form: FormData;
  try {
    const bytes = await readLimited(c.req.raw, MAX_UPLOAD_BYTES);
    form = await new Response(bytes, { headers: { "Content-Type": c.req.header("Content-Type") ?? "" } }).formData();
  } catch (error) {
    if (error instanceof BodyLimitError) return c.json({ error: error.message }, 413);
    return c.json({ error: "Send the listing and file as a form." }, 400);
  }
  if (form.getAll("listing").length !== 1 || form.getAll("file").length !== 1) return c.json({ error: "Supply one listing and one component." }, 422);
  let listing: unknown;
  try {
    listing = JSON.parse(String(form.get("listing") ?? ""));
  } catch {
    return c.json({ error: "Send the listing as JSON." }, 400);
  }
  const checked = await call(c, { op: "precheck", body: listing, ...who });
  if (checked.status !== 200) return reply(c, checked);
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Choose your mod's .wasm file.", fields: { file: "Choose a file." } }, 422);
  if (file.size > MAX_COMPONENT_BYTES) return c.json({ error: "The file is over 16 MiB." }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let grants;
  try {
    const declarations = readComponent(bytes);
    grants = declarations.grants;
    if (declarations.version && declarations.version !== (listing as { version?: string }).version) {
      throw new Error("The component version must match the release version.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "This file can't be read.";
    return c.json({ error: message, fields: { file: message } }, 422);
  }
  const media: MediaFile[] = [];
  const images = form.getAll("images");
  if (images.length > MAX_IMAGES) return c.json({ error: "Upload at most four images." }, 422);
  let imageMetadata: { caption: string; alt: string }[] = [];
  if (form.has("image_metadata")) {
    try {
      if (form.getAll("image_metadata").length !== 1 || typeof form.get("image_metadata") !== "string"
        || String(form.get("image_metadata")).length > 8192) throw new Error();
      const raw: unknown = JSON.parse(String(form.get("image_metadata")));
      if (!Array.isArray(raw) || raw.length !== images.length) throw new Error();
      imageMetadata = raw.map(item => {
        if (!item || typeof item.caption !== "string" || item.caption.length > 160 || typeof item.alt !== "string" || item.alt.length > 300) throw new Error();
        return { caption: item.caption, alt: item.alt };
      });
    } catch { return c.json({ error: "Supply one caption and alt text per image, within their limits.", fields: { images: "Invalid image metadata." } }, 422); }
  }
  const imageBytes: Uint8Array[] = [];
  try {
    for (const image of images) {
      if (!(image instanceof File)) throw new Error("Choose an image file.");
      if (image.size > MAX_IMAGE_BYTES) throw new Error("Each image must be at most 1 MiB.");
      const data = new Uint8Array(await image.arrayBuffer());
      const type = imageType(data);
      const details = imageMetadata[media.length];
      media.push({ sha256: await sha256(data), bytes: data.length, type, caption: details?.caption ?? image.name.slice(0, 160), alt: details?.alt ?? "" });
      imageBytes.push(data);
    }
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid image." }, 422); }
  const hash = await sha256(bytes);
  for (let i = 0; i < media.length; i++) {
    await c.env.MOD_QUARANTINE.put(`media/${media[i]!.sha256}`, imageBytes[i]!, { httpMetadata: { contentType: media[i]!.type } });
  }
  await c.env.MOD_QUARANTINE.put(`mods/${hash}`, bytes, { httpMetadata: { contentType: "application/wasm" } });
  return reply(c, await call(c, { op: "submit", body: listing, file: { sha256: hash, bytes: bytes.byteLength, grants, media }, ...who }));
});

marketplaceRoutes.get("/staff/queue", async (c) => reply(c, await call(c, { op: "queue", ...(await caller(c)) })));
marketplaceRoutes.get("/staff/reports", async (c) => reply(c, await call(c, { op: "reports", ...(await caller(c)) })));
marketplaceRoutes.get("/staff/people", async (c) => reply(c, await call(c, { op: "people", ...(await caller(c)) })));
marketplaceRoutes.get("/staff/audit", async (c) => reply(c, await call(c, { op: "audit", ...(await caller(c)) })));

marketplaceRoutes.get("/staff/versions/:id", async (c) => {
  const versionId = id(c.req.param("id"));
  if (versionId === null) return c.json({ error: "No such version." }, 404);
  return reply(c, await call(c, { op: "version", id: versionId, ...(await caller(c)) }));
});

marketplaceRoutes.get("/staff/versions/:id/file", async (c) => {
  const versionId = id(c.req.param("id"));
  const version = versionId === null ? null : await call(c, { op: "version", id: versionId, ...(await caller(c)) });
  if (!version || version.status !== 200) return reply(c, version ?? { status: 404, body: { error: "No such version." } });
  const objectKey = `mods/${(version.body as { sha256: string }).sha256}`;
  const object = await c.env.MOD_QUARANTINE.get(objectKey) ?? await c.env.MOD_FILES.get(objectKey);
  if (!object) return c.notFound();
  return c.body(object.body, 200, { "Content-Type": "application/wasm", "Cache-Control": "private, no-store",
    "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" });
});

marketplaceRoutes.get("/me/mods/:id/media/:sha256", async c => {
  c.header("Cache-Control", "private, no-store");
  const target = id(c.req.param("id"));
  const hash = c.req.param("sha256");
  if (target === null || !/^[0-9a-f]{64}$/.test(hash)) return c.notFound();
  const result = await call(c, { op: "private-media", id: target, sha256: hash, ...(await caller(c)) });
  if (result.status !== 200) return reply(c, result);
  const { key, type } = result.body as { key: string; type: string };
  const object = await c.env.MOD_QUARANTINE.get(key);
  return object ? c.body(object.body, 200, { "Content-Type": type, "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" }) : c.notFound();
});

marketplaceRoutes.post("/staff/versions/:id/rescan", async c => {
  const target = id(c.req.param("id"));
  return target === null ? c.notFound() : reply(c, await call(c, { op: "rescan", id: target, ...(await caller(c)) }));
});
marketplaceRoutes.post("/staff/mods/:slug/trust", async c => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "Send JSON." }, 400);
  return reply(c, await call(c, { op: "trust", slug: c.req.param("slug"), body, ...(await caller(c)) }));
});

/** Scanner credentials authorize only this internal job protocol, never marketplace staff operations. */
marketplaceRoutes.use("/internal/marketplace/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const secret = c.env.MARKETPLACE_SCANNER_TOKEN;
  if (!secret) return c.json({ error: "Scanner is not configured." }, 503);
  const presented = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)));
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  if (different !== 0) return c.json({ error: "Unauthorized." }, 401);
  return next();
});
marketplaceRoutes.post("/internal/marketplace/claim", async c => reply(c, await call(c, { op: "scan-claim" })));
marketplaceRoutes.get("/internal/marketplace/jobs/:job/files/:sha256", async c => {
  const result = await call(c, { op: "scan-file", job: c.req.param("job"), lease: c.req.header("X-Scan-Lease") ?? "", sha256: c.req.param("sha256") });
  if (result.status !== 200) return reply(c, result);
  const { key, type, legacy } = result.body as { key: string; type: string; legacy: boolean };
  const object = await c.env.MOD_QUARANTINE.get(key)
    ?? (legacy ? await c.env.MOD_FILES.get(key) : null);
  return object ? c.body(object.body, 200, { "Content-Type": type, "Cache-Control": "no-store" }) : c.notFound();
});
marketplaceRoutes.post("/internal/marketplace/jobs/:job/complete", async c => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "Send a bounded scan report." }, 400);
  return reply(c, await call(c, { op: "scan-complete", job: c.req.param("job"), lease: c.req.header("X-Scan-Lease") ?? "", body }));
});

/** Registers a staff write that takes a numeric id and a JSON body. */
function staffWrite(path: string, op: "decide" | "pull" | "resolve"): void {
  marketplaceRoutes.post(path, async (c) => {
    const target = id(c.req.param("id") ?? "");
    const body = await readJson(c);
    if (target === null) return c.json({ error: "Not found." }, 404);
    if (body === null) return c.json({ error: "Send the request as JSON." }, 400);
    return reply(c, await call(c, { op, id: target, body, ...(await caller(c)) }));
  });
}
staffWrite("/staff/versions/:id/decision", "decide");
staffWrite("/staff/versions/:id/pull", "pull");
staffWrite("/staff/reports/:id/resolve", "resolve");

marketplaceRoutes.post("/staff/mods/:slug/hide", async (c) => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "Send the request as JSON." }, 400);
  return reply(c, await call(c, { op: "hide", slug: c.req.param("slug"), body, ...(await caller(c)) }));
});

for (const [path, op] of [["/staff/people/role", "role"], ["/staff/people/suspend", "suspend"]] as const) {
  marketplaceRoutes.post(path, async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "Send the request as JSON." }, 400);
    return reply(c, await call(c, { op, body, ...(await caller(c)) }));
  });
}
