import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { publicCache } from "../public-cache";
import { hubFor } from "../routing";
import { downloadModAsset } from "../mod-assets";
import { MAX_COMPONENT_BYTES, readComponent } from "./component";
import { clip, malformedText, type Grants } from "./policy";
import { linkCode, normalizeLinkCode, randomToken, sha256Base64Url } from "./auth";
import { authorizeUrl, googleIdentity } from "./google";
import { MAX_RETURN_TO, OAUTH_STATE_MS, openSignIn, sealSignIn } from "./oauth-state";
import { PLAYER_SESSION_MS, anonymousResult, type Caller, type MarketCall, type MarketResult, type MediaFile } from "./store";
import { BodyLimitError, MAX_IMAGES, MAX_UPLOAD_BYTES, imageType, readLimited, sha256 } from "./uploads";
import { isMarketplaceUpdateQuery } from "./updates";
import { OFFICIAL_SLUG } from "./official";

const SESSION_COOKIE = "cinnabar_session";
const OAUTH_COOKIE = "cinnabar_oauth";
/** Header carrying the Ed25519 signature of a signed public body, such as the revocation list. */
const SIGNATURE_HEADER = "X-Cinnabar-Signature";
const CSRF_HEADER = "X-Cinnabar-CSRF";
const MAX_JSON_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
/** Keeps stored images inert even if a browser is tricked into rendering one as a document. */
const IMAGE_CSP = "default-src 'none'; sandbox";
/** Edge and browser lifetimes of the public catalogue, a missing listing and the signed revocation list. */
const CATALOGUE_CACHE = "public, max-age=30";
const MISSING_LISTING_CACHE = "public, max-age=10";
const REVOCATIONS_CACHE = "public, max-age=60";

type Ctx = Context<{ Bindings: Env }>;

/** The configured website origin, normalised, or null while the marketplace's web access is unconfigured. */
function siteOrigin(env: Env): string | null {
  try {
    return env.MARKETPLACE_ORIGIN ? new URL(env.MARKETPLACE_ORIGIN).origin : null;
  } catch {
    return null;
  }
}

/** The caller's session hash and CSRF header, read from the request. */
async function caller(c: Ctx): Promise<Caller> {
  const token = getCookie(c, SESSION_COOKIE, "host");
  return { session: token ? await sha256Base64Url(token) : undefined, csrf: c.req.header(CSRF_HEADER) };
}

/** The store's answer to `request`; one that needs a session but carries none is answered here without calling the Hub. */
async function call(c: Ctx, request: MarketCall): Promise<MarketResult> {
  return (!request.session && anonymousResult(request.op)) || hubFor(c.env).marketplace(request);
}

function reply(c: Ctx, result: MarketResult, cache = "no-store"): Response {
  c.header("Cache-Control", cache);
  return result.status === 204 ? c.body(null, 204) : c.json(result.body as object, result.status as 200);
}

/** Answers with the store's result for `request` made as the signed-in caller. */
async function forward(c: Ctx, request: MarketCall): Promise<Response> {
  return reply(c, await call(c, { ...request, ...(await caller(c)) }));
}

/** Like `forward`, adding the bounded JSON body; an oversized or malformed body is a 400 carrying `invalid`. */
async function forwardJson(c: Ctx, invalid: string, request: (body: unknown) => MarketCall): Promise<Response> {
  const body = await readJson(c);
  if (body === null) return c.json({ error: invalid }, 400);
  return forward(c, request(body));
}

/** Whether the store lets anyone download the public file `request` names. */
async function publicFile(c: Ctx, request: MarketCall): Promise<boolean> {
  return ((await call(c, request)).body as { allowed: boolean }).allowed;
}

/** Streams a stored object with `headers`, or Hono's 404 when it's missing. */
async function stream(c: Ctx, key: string, headers: Record<string, string>): Promise<Response> {
  const object = await c.env.MOD_FILES.get(key);
  return object ? c.body(object.body, 200, headers) : c.notFound();
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
const callbackUrl = (c: Ctx) => new URL("/v1/auth/google/callback", c.req.url).toString();

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
  // Browsers hide custom headers cross-origin unless they are exposed, and the signature is needed to verify the body.
  if (c.res.headers.has(SIGNATURE_HEADER)) c.res.headers.set("Access-Control-Expose-Headers", SIGNATURE_HEADER);
};
// Only marketplace paths, so the cached presence routes keep their own headers.
for (const path of ["/auth/*", "/me", "/me/*", "/mods", "/mods/*", "/submissions", "/staff/*"]) marketplaceRoutes.use(path, cors);

marketplaceRoutes.get("/auth/google/start", async (c) => {
  c.header("Cache-Control", "no-store");
  const site = siteOrigin(c.env);
  const secret = c.env.MARKETPLACE_SIGNING_KEY;
  if (!site || !c.env.GOOGLE_CLIENT_ID || c.env.GOOGLE_CLIENT_ID.startsWith("REPLACE_") || !c.env.GOOGLE_CLIENT_SECRET || !secret) return c.json({ error: "Sign-in isn't configured yet." }, 503);
  let returnTo = `${site}/mods/`;
  const requested = c.req.query("return_to");
  if (requested) {
    try {
      const url = new URL(requested);
      if (url.origin === site && url.toString().length <= MAX_RETURN_TO) returnTo = url.toString();
    } catch {
      // Fall back to the marketplace page.
    }
  }
  const state = randomToken();
  const verifier = randomToken();
  // The pending sign-in lives only in this browser's sealed cookie, which also binds it to this browser, so a link
  // can't sign someone into another person's account and anonymous starts never write to the Hub.
  setCookie(c, OAUTH_COOKIE, await sealSignIn(secret, { provider: "google", state, verifier, returnTo }, Date.now()),
    { prefix: "host", httpOnly: true, sameSite: "Lax", maxAge: OAUTH_STATE_MS / 1000 });
  return c.redirect(authorizeUrl(c.env.GOOGLE_CLIENT_ID, callbackUrl(c), state, await sha256Base64Url(verifier)), 302);
});

marketplaceRoutes.get("/auth/google/callback", async (c) => {
  c.header("Cache-Control", "no-store");
  const site = siteOrigin(c.env);
  const secret = c.env.MARKETPLACE_SIGNING_KEY;
  if (!site || !c.env.GOOGLE_CLIENT_ID || c.env.GOOGLE_CLIENT_ID.startsWith("REPLACE_") || !c.env.GOOGLE_CLIENT_SECRET || !secret) return c.json({ error: "Sign-in isn't configured yet." }, 503);
  const state = c.req.query("state") ?? "";
  const pending = await openSignIn(secret, getCookie(c, OAUTH_COOKIE, "host"), Date.now());
  // Clearing the cookie makes the pending sign-in single-use in this browser; Google redeems each code only once.
  deleteCookie(c, OAUTH_COOKIE, { prefix: "host" });
  const failed = () => c.redirect(`${site}/mods/?signin_error=failed`, 302);
  if (pending === "expired") return failed();
  if (!pending || pending.provider !== "google" || !state || state !== pending.state
    || !URL.canParse(pending.returnTo) || new URL(pending.returnTo).origin !== site) {
    return failed();
  }
  const { verifier, returnTo } = pending;
  const back = (error?: string) => {
    const url = new URL(returnTo);
    if (error) url.searchParams.set("signin_error", error);
    return c.redirect(url.toString(), 302);
  };
  const code = c.req.query("code");
  if (!code) return back(c.req.query("error") === "access_denied" ? "cancelled" : "failed");
  let identity;
  try {
    identity = await googleIdentity({
      clientId: c.env.GOOGLE_CLIENT_ID, clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: callbackUrl(c), code, verifier,
    });
  } catch (error) {
    console.error("Google sign-in failed:", error instanceof Error ? error.message : "unknown error");
    return back("failed");
  }
  const token = randomToken();
  const signedIn = await call(c, { op: "signin", identity, newSession: await sha256Base64Url(token), newCsrf: randomToken(24) });
  if (signedIn.status !== 200) {
    console.error("Google sign-in was refused by the store:", signedIn.status);
    return back("failed");
  }
  setCookie(c, SESSION_COOKIE, token, { prefix: "host", httpOnly: true, sameSite: "Lax", maxAge: PLAYER_SESSION_MS / 1000 });
  return back();
});

marketplaceRoutes.post("/auth/signout", async (c) => {
  const result = await call(c, { op: "signout", ...(await caller(c)) });
  deleteCookie(c, SESSION_COOKIE, { prefix: "host" });
  return reply(c, result);
});

marketplaceRoutes.get("/me", (c) => forward(c, { op: "me" }));
marketplaceRoutes.post("/me/xbox/link-code", async c => {
  const code = linkCode();
  const result = await call(c, { op: "link-code", ...(await caller(c)), codeHash: await sha256Base64Url(normalizeLinkCode(code)) });
  return reply(c, result.status === 200 ? { ...result, body: { code, expires_in: 600 } } : result);
});
marketplaceRoutes.post("/me/xbox/unlink", c => forward(c, { op: "unlink" }));
marketplaceRoutes.get("/me/mods", (c) => forward(c, { op: "mine" }));
marketplaceRoutes.get("/mods", publicCache(CATALOGUE_CACHE), async (c) => {
  const cache = await hubFor(c.env).hasOfficialMod() ? "no-store" : CATALOGUE_CACHE;
  return reply(c, await call(c, { op: "mods" }), cache);
});

marketplaceRoutes.get("/mods/revocations", publicCache(REVOCATIONS_CACHE), async (c) => {
  const { body, signature } = await hubFor(c.env).modRevocations();
  c.header("Cache-Control", REVOCATIONS_CACHE);
  if (signature) c.header(SIGNATURE_HEADER, signature);
  return c.body(body, 200, { "Content-Type": "application/json" });
});

marketplaceRoutes.get("/mods/assets/:sha256", async (c) => {
  const hash = c.req.param("sha256");
  if (SHA256.test(hash)) {
    const size = await hubFor(c.env).officialModAssetSize(hash);
    if (size !== null) {
      const response = await downloadModAsset(hash, size, c.env.MOD_ASSETS);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }
  const object = SHA256.test(hash) && await publicFile(c, { op: "asset", sha256: hash }) ? await c.env.MOD_FILES.get(`mods/${hash}`) : null;
  if (!object) return c.json({ error: "Not found." }, 404);
  return c.body(object.body, 200, { "Content-Type": "application/wasm", "Cache-Control": "no-store", ETag: `"${hash}"`,
    "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" });
});
marketplaceRoutes.get("/mods/media/:sha256", async c => {
  const hash = c.req.param("sha256");
  const object = SHA256.test(hash) && await publicFile(c, { op: "media", sha256: hash }) ? await c.env.MOD_FILES.get(`media/${hash}`) : null;
  if (!object) return c.notFound();
  return c.body(object.body, 200, { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": IMAGE_CSP });
});
marketplaceRoutes.get("/mods/:slug", async (c, next) => {
  // Official pages must observe pulls on the next request, including cached missing pages before first publication.
  if (c.req.param("slug") === OFFICIAL_SLUG) { c.header("Cache-Control", "no-store"); await next(); }
  else await publicCache(CATALOGUE_CACHE)(c, next);
}, async (c) => {
  const result = await call(c, { op: "mod", slug: c.req.param("slug") });
  return reply(c, result, c.req.param("slug") === OFFICIAL_SLUG ? "no-store" : result.status === 404 ? MISSING_LISTING_CACHE : CATALOGUE_CACHE);
});
marketplaceRoutes.get("/mods/:slug/releases/:version/:sha256", async c => {
  const hash = c.req.param("sha256");
  return SHA256.test(hash) ? reply(c, await call(c, { op: "release", slug: c.req.param("slug"), version: c.req.param("version"), sha256: hash })) : c.notFound();
});
marketplaceRoutes.get("/mods/:slug/update", async c => {
  // Selection depends on every query identity, and pulls/visibility changes must apply on the next check.
  c.header("Cache-Control", "no-store");
  const query = { api_revisions: c.req.query("api_revisions") ?? "", host_revision: c.req.query("host_revision") ?? "",
    current_version: c.req.query("current_version") ?? "", current_sha256: c.req.query("current_sha256") ?? "" };
  if (!isMarketplaceUpdateQuery(query)) return c.body(null, 400);
  const result = await call(c, { op: "update", slug: c.req.param("slug"), query });
  return result.status === 204 ? c.body(null, 204) : reply(c, result);
});

marketplaceRoutes.post("/mods/:slug/send", (c) => forward(c, { op: "send", slug: c.req.param("slug") }));
marketplaceRoutes.post("/mods/:slug/remove", (c) =>
  forwardJson(c, "Send the library selection as JSON.", (body) => ({ op: "remove", slug: c.req.param("slug"), body })));
marketplaceRoutes.post("/mods/:slug/reports", (c) =>
  forwardJson(c, "Send the report as JSON.", (body) => ({ op: "report", slug: c.req.param("slug"), body })));

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
  let grants: Grants | null;
  try {
    const declarations = readComponent(bytes);
    if (declarations.version && declarations.version !== (listing as { version?: string }).version) {
      throw new Error("The component version must match the release version.");
    }
    grants = declarations.grants;
  } catch (error) {
    const message = error instanceof Error ? error.message : "This file can't be read.";
    return c.json({ error: message, fields: { file: message } }, 422);
  }
  const images = form.getAll("images");
  if (images.length > MAX_IMAGES) return c.json({ error: "Upload at most four images." }, 422);
  const metadata = form.getAll("image_metadata");
  let imageMetadata: { caption: string; alt: string }[] = [];
  if (metadata.length) {
    try {
      if (metadata.length !== 1 || typeof metadata[0] !== "string" || metadata[0].length > 8192) throw new Error();
      const raw: unknown = JSON.parse(metadata[0]);
      if (!Array.isArray(raw) || raw.length !== images.length) throw new Error();
      imageMetadata = raw.map(item => {
        if (!item || typeof item.caption !== "string" || item.caption.length > 160 || typeof item.alt !== "string" || item.alt.length > 300
          || malformedText(item.caption, item.alt)) throw new Error();
        return { caption: item.caption, alt: item.alt };
      });
    } catch { return c.json({ error: "Supply one caption and alt text per image, within their limits.", fields: { images: "Invalid image metadata." } }, 422); }
  }
  const media: { file: MediaFile; data: Uint8Array }[] = [];
  try {
    for (const [i, image] of images.entries()) {
      if (!(image instanceof File)) throw new Error("Choose an image file.");
      const data = new Uint8Array(await image.arrayBuffer());
      const type = imageType(data);
      const details = imageMetadata[i];
      media.push({ data, file: { sha256: await sha256(data), bytes: data.length, type,
        caption: details?.caption ?? clip(image.name.toWellFormed(), 160), alt: details?.alt ?? "" } });
    }
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid image." }, 422); }
  const hash = await sha256(bytes);
  for (const { file, data } of media) await c.env.MOD_FILES.put(`media/${file.sha256}`, data, { httpMetadata: { contentType: file.type } });
  await c.env.MOD_FILES.put(`mods/${hash}`, bytes, { httpMetadata: { contentType: "application/wasm" } });
  return reply(c, await call(c, { op: "submit", body: listing,
    file: { sha256: hash, bytes: bytes.byteLength, grants, media: media.map(m => m.file) }, ...who }));
});

for (const op of ["queue", "reports", "people", "audit"] as const) marketplaceRoutes.get(`/staff/${op}`, (c) => forward(c, { op }));

marketplaceRoutes.get("/staff/versions/:id", async (c) => {
  const versionId = id(c.req.param("id"));
  if (versionId === null) return c.json({ error: "No such version." }, 404);
  return forward(c, { op: "version", id: versionId });
});

marketplaceRoutes.get("/staff/versions/:id/file", async (c) => {
  const versionId = id(c.req.param("id"));
  if (versionId === null) return reply(c, { status: 404, body: { error: "No such version." } });
  const version = await call(c, { op: "version", id: versionId, ...(await caller(c)) });
  if (version.status !== 200) return reply(c, version);
  const details = version.body as { slug: string; sha256: string; bytes: number; pulled: boolean; file_withdrawn?: boolean };
  if (details.slug === OFFICIAL_SLUG) {
    if (details.pulled || details.file_withdrawn) return c.notFound();
    const response = await downloadModAsset(details.sha256, details.bytes, c.env.MOD_ASSETS);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  return stream(c, `mods/${(version.body as { sha256: string }).sha256}`, { "Content-Type": "application/wasm",
    "Cache-Control": "private, no-store", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" });
});

marketplaceRoutes.get("/me/mods/:id/media/:sha256", async c => {
  c.header("Cache-Control", "private, no-store");
  const target = id(c.req.param("id"));
  const hash = c.req.param("sha256");
  if (target === null || !SHA256.test(hash)) return c.notFound();
  const result = await call(c, { op: "private-media", id: target, sha256: hash, ...(await caller(c)) });
  if (result.status !== 200) return reply(c, result);
  const { key, type } = result.body as { key: string; type: string };
  return stream(c, key, { "Content-Type": type, "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": IMAGE_CSP });
});

marketplaceRoutes.post("/staff/versions/:id/rescan", async c => {
  const target = id(c.req.param("id"));
  return target === null ? c.notFound() : forward(c, { op: "rescan", id: target });
});
marketplaceRoutes.post("/staff/mods/:slug/trust", (c) =>
  forwardJson(c, "Send JSON.", (body) => ({ op: "trust", slug: c.req.param("slug"), body })));

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
  const { key, type } = result.body as { key: string; type: string };
  return stream(c, key, { "Content-Type": type, "Cache-Control": "no-store" });
});
marketplaceRoutes.post("/internal/marketplace/jobs/:job/complete", async c => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "Send a bounded scan report." }, 400);
  return reply(c, await call(c, { op: "scan-complete", job: c.req.param("job"), lease: c.req.header("X-Scan-Lease") ?? "", body }));
});

const INVALID_REQUEST = "Send the request as JSON.";
for (const [path, op] of [["/staff/versions/:id/decision", "decide"], ["/staff/versions/:id/pull", "pull"],
  ["/staff/reports/:id/resolve", "resolve"]] as const) {
  marketplaceRoutes.post(path, (c) => {
    const target = id(c.req.param("id"));
    if (target === null) return c.json({ error: "Not found." }, 404);
    return forwardJson(c, INVALID_REQUEST, (body) => ({ op, id: target, body }));
  });
}
marketplaceRoutes.post("/staff/mods/:slug/hide", (c) =>
  forwardJson(c, INVALID_REQUEST, (body) => ({ op: "hide", slug: c.req.param("slug"), body })));
for (const op of ["role", "suspend"] as const) {
  marketplaceRoutes.post(`/staff/people/${op}`, (c) => forwardJson(c, INVALID_REQUEST, (body) => ({ op, body })));
}
