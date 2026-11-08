import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hub } from "./helpers";
import type { ModRelease, ModUpdateQuery } from "../src/mod-releases";
import { validateListing } from "../src/marketplace/policy";
import { MarketplaceStore, type MarketCall, type MarketResult } from "../src/marketplace/store";
import { sha256Base64Url } from "../src/marketplace/auth";
import { component, pngIcon } from "./component-fixtures";
import { ICON_SECTION } from "../src/marketplace/icon";
import { sha256 } from "../src/marketplace/uploads";

const HOST_A = "a".repeat(40);
const HOST_B = "b".repeat(40);
const REPOSITORY = "https://github.com/example/host.git";
const PACKAGE = "example-mod";
const BYTES = new Uint8Array(256);
BYTES.set([0, 97, 115, 109, 13, 0, 1, 0]);
// One inert, unnamed custom section pads the valid synthetic component to 256 bytes.
BYTES.set([0, 245, 1, 0], 8);
const HASH = [...new Uint8Array(await crypto.subtle.digest("SHA-256", BYTES))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The public service record retains the manifest and serves its verified artifact. */
function served(record: ModRelease): ModRelease {
  return { ...record, download_url: `https://api.test/v1/mod/assets/${record.manifest.artifact.sha256}` };
}


/** Creates synthetic metadata independent of any consumer's feature logic. */
function release(version = "1.0.0", host = HOST_A, revision = "1".repeat(40)): ModRelease {
  return {
    manifest: {
      schema_version: 1, package: PACKAGE, version, revision,
      host: { repository: REPOSITORY, revision: host, api_revision: host },
      artifact: { filename: "Example.wasm", size: 256, sha256: HASH },
    },
    download_url: `https://github.com/example/mod/releases/download/v${version}/Example.wasm`,
  };
}

/** Exercises the authenticated HTTP publication boundary. */
function publish(body: unknown, secret: string | null = "test-mod-hook-secret"): Promise<Response> {
  return exports.default.fetch("https://api.test/v1/mod/releases", {
    method: "POST",
    headers: secret === null ? {} : { Authorization: `Bearer ${secret}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Requests an update from an exact host and installed mod identity. */
function update(overrides: Partial<ModUpdateQuery> = {}): Promise<Response> {
  const query = new URLSearchParams({
    host_revision: HOST_A, api_revisions: HOST_A,
    current_version: "0.1.0", current_revision: "0".repeat(40), ...overrides,
  });
  return exports.default.fetch(`https://api.test/v1/mod/update?${query}`);
}

/** Preserve the HTTP-shaped result type across the test RPC structured-clone boundary. */
async function market(call: MarketCall): Promise<MarketResult> { return hub().marketplace(call); }

beforeEach(async () => {
  await runInDurableObject(hub(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(hub());
  await env.MOD_ASSETS.put(`mod-releases/${HASH}`, BYTES, { customMetadata: { sha256: HASH } });
});

describe("revision-aware mod releases", () => {
  it("reserves the Official Mod slug for the system publisher", () => {
    expect(validateListing({ slug: "cinnabar-mod", name: "Impersonator", summary: "A reserved official name.", version: "1.0.0" }, 0).errors.slug).toBeTruthy();
  });

  it("refuses official-slug submissions from ordinary creators before publication", async () => {
    await market({ op: "signin", identity: { provider: "google", subject: "2535400000008000", email: "2535400000008000@test.invalid", email_verified: true }, newSession: "creator-session", newCsrf: "creator-csrf" });
    const response = await market({ op: "submit", session: "creator-session", csrf: "creator-csrf",
      body: { slug: "cinnabar-mod", name: "Impersonator", summary: "An impersonation attempt.", version: "1.0.0" },
      file: { sha256: HASH, bytes: BYTES.length, grants: {}, media: [] } });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ fields: { slug: expect.any(String) } });
  });

  it("records the actual component grants and license and rejects malformed declarations before approving CI", async () => {
    // These bounded fixture sections have single-byte lengths and contain no executable code.
    const custom = (name: string, value: string) => {
      const label = [...new TextEncoder().encode(name)], data = [...new TextEncoder().encode(value)];
      return [0, label.length + data.length + 1, label.length, ...label, ...data];
    };
    const bytes = new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0,
      ...custom("cinnabar:grants", '{"hud":true}'), ...custom("licenses", "Fixture license notice"), ...custom("version", "1.0.0")]);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    const body = release(); body.manifest.artifact = { ...body.manifest.artifact, size: bytes.length, sha256: hash };
    await env.MOD_ASSETS.put(`mod-releases/${hash}`, bytes, { customMetadata: { sha256: hash } });
    expect((await publish(body)).status).toBe(204);
    const listing = (await market({ op: "mod", slug: "cinnabar-mod" })).body as { release: { statement: string } };
    expect(JSON.parse(listing.release.statement)).toMatchObject({ grants: { hud: true }, metadata: { license: "Fixture license notice" } });
    // The same valid bytes cannot be declared as a different version.
    const wrongVersion = release("2.0.0"); wrongVersion.manifest.artifact = body.manifest.artifact;
    expect((await publish(wrongVersion)).status).toBe(409);
    // The old upload boundary permits component-header bytes; publication now rejects invalid framing.
    const invalid = new Uint8Array([...bytes, ...custom("cinnabar:grants", '{"hud":false}')]);
    const badHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", invalid))].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.MOD_ASSETS.put(`mod-releases/${badHash}`, invalid, { customMetadata: { sha256: badHash } });
    wrongVersion.manifest.artifact = { ...body.manifest.artifact, size: invalid.length, sha256: badHash };
    expect((await publish(wrongVersion)).status).toBe(409);
    expect((await exports.default.fetch(`https://api.test/v1/mod/assets/${badHash}`)).status).toBe(404);
  });

  it.each([true, false])("takes the Official Mod icon from its component (valid PNG: %s)", async valid => {
    const png = valid ? pngIcon(2, 2, 120) : new Uint8Array([1, 2, 3]);
    const bytes = component([[ICON_SECTION, png]]), hash = await sha256(bytes);
    const body = release(); body.manifest.artifact = { ...body.manifest.artifact, size: bytes.length, sha256: hash };
    await env.MOD_ASSETS.put(`mod-releases/${hash}`, bytes, { customMetadata: { sha256: hash } });
    expect((await publish(body)).status).toBe(204);
    const listing = (await market({ op: "mod", slug: "cinnabar-mod" })).body as any;
    const iconHash = await sha256(png), icon = valid ? `/v1/mods/media/${iconHash}` : null;
    expect(listing).toMatchObject({ icon, gallery: [], publication: "official" });
    expect((await market({ op: "mods" })).body).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "cinnabar-mod", icon })]));
    const media = JSON.parse(listing.release.statement).media;
    expect(media).toEqual(valid ? [{ sha256: iconHash, bytes: png.length, type: "image/png", caption: "", role: "icon" }] : []);
    await market({ op: "signin", identity: { provider: "google", subject: "2535400000009001", email: "2535400000009001@test.invalid", email_verified: true }, newSession: "icon-owner", newCsrf: "icon-csrf" });
    const view = await market({ op: "version", session: "icon-owner", id: Number(listing.version_id) });
    expect(view.body).toMatchObject({ icon: valid ? `/v1/me/mods/${listing.version_id}/media/${iconHash}` : null,
      icon_error: valid ? null : "The icon is not a PNG." });
    if (valid) {
      const stored = await env.MOD_FILES.get(`media/${iconHash}`);
      expect(stored?.httpMetadata?.contentType).toBe("image/png");
      const response = await exports.default.fetch(`https://api.test${icon}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    }
    expect((await publish(body)).status).toBe(204);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).body).toEqual(listing);
    expect((await market({ op: "pull", session: "icon-owner", csrf: "icon-csrf", id: Number(listing.version_id), body: { reason: "Withdraw fixture" } })).status).toBe(200);
    if (icon) expect((await exports.default.fetch(`https://api.test${icon}`)).status).toBe(404);
  });

  it("publishes a signed official marketplace release through the existing mod hook", async () => {
    const body = release();
    body.manifest.host.revision = HOST_B;
    expect((await publish(body)).status).toBe(204);
    const result = await market({ op: "mod", slug: "cinnabar-mod" });
    expect(result.status).toBe(200);
    const listing = result.body as { creator: string; release: { statement: string; signature: string } };
    expect(listing.creator).toBe("system:official");
    expect(listing).toMatchObject({ icon: null, gallery: [] });
    expect(JSON.parse(listing.release.statement)).toMatchObject({ slug: "cinnabar-mod", version: "1.0.0", api_revision: HOST_A,
      client_revision: HOST_B, publication: "official", sha256: HASH, approvers: ["system:official"] });
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob("MCowBQYDK2VwAyEAlSb5YEqBeXmlmyc5Xg5zqHKLWklg3zlZbCj4GAVu/TQ="), c => c.charCodeAt(0)), "Ed25519", false, ["verify"]);
    const signature = Uint8Array.from(atob(listing.release.signature.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    expect(await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(listing.release.statement))).toBe(true);
    expect((await market({ op: "mods" })).body).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "cinnabar-mod" })]));
    expect(await (await update()).json()).toEqual(served(body));
    const query = new URLSearchParams({ api_revisions: HOST_A, host_revision: HOST_B, current_version: "0.1.0", current_sha256: "0".repeat(64) });
    const marketplaceUpdate = await exports.default.fetch(`https://api.test/v1/mods/cinnabar-mod/update?${query}`);
    expect(marketplaceUpdate.status).toBe(200);
    expect(await marketplaceUpdate.json()).toEqual({ release: listing.release });
    const bytes = await exports.default.fetch(`https://api.test/v1/mods/assets/${HASH}`);
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(BYTES);
  });

  it("leaves the native release hook for native notifications only", async () => {
    const response = await exports.default.fetch("https://api.test/v1/releases", {
      method: "POST", headers: { Authorization: "Bearer test-hook-secret" }, body: JSON.stringify(release()),
    });
    expect(response.status).toBe(400);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).status).toBe(404);
  });

  it("keeps original manifests and signatures stable across retries and rejects every immutable metadata change", async () => {
    const body = release();
    expect((await Promise.all([publish(body), publish(body)])).map(r => r.status)).toEqual([204, 204]);
    const first = (await market({ op: "mod", slug: "cinnabar-mod" })).body;
    await evictDurableObject(hub());
    expect((await publish(body)).status).toBe(204);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).body).toEqual(first);
    for (const mutate of [
      (r: ModRelease) => { r.manifest.revision = "3".repeat(40); },
      (r: ModRelease) => { r.manifest.host.revision = HOST_B; },
      (r: ModRelease) => { r.manifest.host.api_revision = HOST_B; },
      (r: ModRelease) => { r.manifest.artifact.filename = "Changed.wasm"; r.download_url = r.download_url.replace("Example.wasm", "Changed.wasm"); },
    ]) {
      const changed = structuredClone(body); mutate(changed);
      expect((await publish(changed)).status).toBe(409);
    }
    expect(await (await update()).json()).toEqual(served(body));
    expect(await env.MOD_FILES.head(`mods/${HASH}`)).toBeNull();
    const validation = await runInDurableObject(hub(), (_, state) => state.storage.sql.exec<{ validation: string }>("SELECT validation FROM mod_official_releases").one().validation);
    expect(JSON.parse(validation)).toMatchObject({ sha256: HASH, bytes: BYTES.length, approval: "authenticated-release-hook" });
  });

  it("withdraws a pulled official release from every download and update path without resurrecting its legacy row", async () => {
    const body = release();
    // Simulate a pre-migration catalogue row for exactly the version now managed by the marketplace.
    expect(await hub().publishModRelease(served(body))).toBe(true);
    expect((await publish(body)).status).toBe(204);
    for (const channel of ["stable", "beta", "nightly"] as const) {
      await hub().recordReleasedModApis(channel, [HOST_A]);
    }
    for (const path of ["/v1/mods", "/v1/mods/cinnabar-mod"]) {
      const response = await exports.default.fetch(`https://api.test${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await response.json();
    }
    const listing = (await market({ op: "mod", slug: "cinnabar-mod" })).body as { version_id: string };
    await market({ op: "signin", identity: { provider: "google", subject: "2535400000009001", email: "2535400000009001@test.invalid", email_verified: true }, newSession: "owner-session", newCsrf: "owner-csrf" });
    expect((await market({ op: "pull", session: "owner-session", csrf: "owner-csrf", id: Number(listing.version_id), body: { reason: "Withdraw test release" } })).status).toBe(200);
    expect((await update()).status).toBe(204);
    expect(await hub().latestModRelease()).toBeNull();
    const query = new URLSearchParams({ api_revisions: HOST_A, host_revision: HOST_A, current_version: "0.1.0", current_sha256: "0".repeat(64) });
    for (const path of ["/v1/mod/download", ...["stable", "beta", "nightly"].map(channel => `/v1/mod/download?channel=${channel}`),
      `/v1/mod/assets/${HASH}`, `/v1/mods/assets/${HASH}`,
      `/v1/mods/cinnabar-mod/releases/1.0.0/${HASH}`, "/v1/mods/cinnabar-mod"]) {
      expect((await exports.default.fetch(`https://api.test${path}`)).status, path).toBe(404);
    }
    expect((await exports.default.fetch(`https://api.test/v1/mods/cinnabar-mod/update?${query}`)).status).toBe(204);
    expect((await market({ op: "mods" })).body).toEqual([]);
    expect(await (await exports.default.fetch("https://api.test/v1/mods")).json()).toEqual([]);
    expect(JSON.parse((await hub().modRevocations()).body)).toMatchObject({ revoked: [expect.objectContaining({ slug: "cinnabar-mod", sha256: HASH })] });
    // A retry acknowledges publication but never clears withdrawal.
    expect((await publish(body)).status).toBe(204);
    await evictDurableObject(hub());
    expect((await update()).status).toBe(204);
    expect((await exports.default.fetch(`https://api.test/v1/mod/assets/${HASH}`)).status).toBe(404);
  });

  it("serves a union of original legacy generations and marketplace versions without a compatibility fallback", async () => {
    const legacy = served(release());
    expect(await hub().publishModRelease(legacy)).toBe(true);
    // Recreate the pre-upgrade schema marker while retaining the shipped legacy catalogue.
    await runInDurableObject(hub(), (_, state) => {
      state.storage.sql.exec("DROP TABLE mod_official_releases");
      state.storage.sql.exec("DELETE FROM market_schema WHERE version = 7");
    });
    await evictDurableObject(hub());
    expect(await (await update()).json()).toEqual(legacy);
    expect((await exports.default.fetch(`https://api.test/v1/mod/assets/${HASH}`)).status).toBe(200);
    // An interrupted migration must keep the already-public legacy release available until its signature commits.
    await runInDurableObject(hub(), (_, state) => new MarketplaceStore(state.storage.sql, new Set())
      .officialRelease(legacy, {}, "", Date.now()));
    expect((await update()).status).toBe(200);
    expect(await (await update()).json()).toEqual(legacy);
    const next = release("2.0.0", HOST_B, "2".repeat(40));
    expect((await publish(next)).status).toBe(204);
    await evictDurableObject(hub());
    expect(await (await update()).json()).toEqual(legacy);
    expect(await (await update({ api_revisions: HOST_B })).json()).toEqual(served(next));
    expect((await update({ api_revisions: "f".repeat(40) })).status).toBe(204);
    expect((await update({ api_revisions: HOST_B, current_revision: next.manifest.revision })).status).toBe(204);
    expect((await hub().latestModRelease())?.manifest.version).toBe("2.0.0");
    // Re-publishing a legacy version with changed metadata remains an immutable-version conflict.
    const changed = release("1.0.0", HOST_A, "3".repeat(40));
    expect((await publish(changed)).status).toBe(409);
    expect((await publish(release())).status).toBe(204);
    expect(await (await update()).json()).toEqual(legacy);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).body).toMatchObject({ version: "2.0.0" });
  });

  it("does not republish revoked official bytes under another version", async () => {
    expect((await publish(release())).status).toBe(204);
    expect((await publish(release("2.0.0", HOST_A, "2".repeat(40)))).status).toBe(204);
    const id = await runInDurableObject(hub(), (_, state) => state.storage.sql.exec<{ id: number }>(
      "SELECT id FROM mod_versions WHERE slug = 'cinnabar-mod' AND version = '1.0.0'").one().id);
    const latest = (await market({ op: "mod", slug: "cinnabar-mod" })).body as { version_id: string };
    const session = await sha256Base64Url("owner-token");
    await market({ op: "signin", identity: { provider: "google", subject: "2535400000009001", email: "2535400000009001@test.invalid", email_verified: true }, newSession: session, newCsrf: "owner-csrf" });
    const staffFile = () => exports.default.fetch(`https://api.test/v1/staff/versions/${latest.version_id}/file`,
      { headers: { Cookie: "__Host-cinnabar_session=owner-token" } });
    const inspected = await staffFile();
    expect(inspected.status).toBe(200);
    expect(new Uint8Array(await inspected.arrayBuffer())).toEqual(BYTES);
    expect((await market({ op: "pull", session, csrf: "owner-csrf", id, body: { reason: "Withdraw identical bytes" } })).status).toBe(200);
    expect((await update()).status).toBe(204);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).status).toBe(404);
    expect((await publish(release("3.0.0", HOST_A, "3".repeat(40)))).status).toBe(409);
    expect((await exports.default.fetch(`https://api.test/v1/mods/assets/${HASH}`)).status).toBe(404);
    expect((await staffFile()).status).toBe(404);
  });

  it("holds unsigned official publications privately and recovers them through the durable outbox", async () => {
    // Stage a validated decision directly, as a crash before signing would leave it.
    await runInDurableObject(hub(), (_, state) => {
      const store = new MarketplaceStore(state.storage.sql, new Set());
      store.officialRelease(served(release()), {}, "", Date.now());
    });
    expect((await update()).status).toBe(204);
    expect((await exports.default.fetch(`https://api.test/v1/mod/assets/${HASH}`)).status).toBe(404);
    expect((await market({ op: "mod", slug: "cinnabar-mod" })).status).toBe(404);
    await hub().recoverModPublications();
    expect(await (await update()).json()).toEqual(served(release()));
  });

  it("protects binary uploads and exposes only verified published artifacts", async () => {
    const bytes = BYTES.slice(); bytes[255] = 1;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const url = `https://api.test/v1/mod/assets/${hash}`;
    for (const token of [null, "wrong", "test-hook-secret"]) {
      expect((await exports.default.fetch(url, { method: "PUT", body: bytes,
        headers: token ? { Authorization: `Bearer ${token}` } : {} })).status).toBe(401);
    }
    const body = release(); body.manifest.artifact = { ...body.manifest.artifact, sha256: hash, size: bytes.length };
    expect((await publish(body)).status).toBe(409);
    const upload = () => exports.default.fetch(url, { method: "PUT", body: bytes,
      headers: { Authorization: "Bearer test-mod-hook-secret" } });
    expect((await upload()).status).toBe(204);
    expect((await exports.default.fetch(url)).status).toBe(404);
    expect((await publish(body)).status).toBe(204);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/wasm");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(await (await update()).json()).toEqual(served(body));
    expect((await upload()).status).toBe(204);
  });

  it("downloads the newest stable mod without a hash, credentials or installed identity", async () => {
    const url = "https://api.test/v1/mod/download";
    const empty = await exports.default.fetch(url);
    expect(empty.status).toBe(404);
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    const latestBytes = BYTES.slice(); latestBytes[255] = 10;
    const latestHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", latestBytes))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.MOD_ASSETS.put(`mod-releases/${latestHash}`, latestBytes, { customMetadata: { sha256: latestHash } });
    for (const version of ["1.10.0", "1.2.0", "1.9.0"]) {
      const body = release(version);
      if (version === "1.10.0") body.manifest.artifact.sha256 = latestHash;
      expect((await publish(body)).status).toBe(204);
    }
    await evictDurableObject(hub());
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/wasm");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="Example.wasm"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(latestBytes);
    expect((await hub().latestModRelease())?.manifest.version).toBe("1.10.0");
    const immutable = await exports.default.fetch(`https://api.test/v1/mod/assets/${HASH}`);
    expect(immutable.headers.get("Cache-Control")).toBe("no-store");
    await immutable.arrayBuffer();
  });

  it("restricts the initial download to the configured package and host repository", async () => {
    const official = release();
    const otherPackage = release("9.0.0"); otherPackage.manifest.package = "other-mod";
    const otherHost = release("8.0.0"); otherHost.manifest.host.repository = "https://example.com/other.git";
    for (const body of [official, otherPackage, otherHost]) await hub().publishModRelease(body);
    expect(await hub().latestModRelease()).toEqual(official);
  });

  it("selects fresh downloads by channel across legacy and official marketplace releases", async () => {
    const nightlyApi = "c".repeat(40);
    const releases: ModRelease[] = [];
    const artifacts: Uint8Array[] = [];
    for (const [index, [version, api]] of [
      ["1.0.0", HOST_A], ["1.10.0", HOST_B], ["1.2.0", HOST_B], ["2.0.0", nightlyApi],
    ].entries()) {
      const bytes = BYTES.slice(); bytes[255] = index + 1;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map(b => b.toString(16).padStart(2, "0")).join("");
      const body = release(version, api, String(index + 1).repeat(40));
      body.manifest.artifact.sha256 = hash;
      await env.MOD_ASSETS.put(`mod-releases/${hash}`, bytes, { customMetadata: { sha256: hash } });
      if (index === 0) expect(await hub().publishModRelease(served(body))).toBe(true);
      else expect((await publish(body)).status).toBe(204);
      releases.push(body); artifacts.push(bytes);
    }
    for (const [channel, api] of [["stable", HOST_A], ["beta", HOST_B], ["nightly", nightlyApi]]) {
      const response = await exports.default.fetch("https://api.test/v1/mod/host-revisions", {
        method: "POST", headers: { Authorization: "Bearer test-hook-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ channel, mod_api_revisions: [api] }),
      });
      expect(response.status).toBe(204);
    }
    await evictDurableObject(hub());
    for (const [query, index] of [["?channel=nightly", 3], ["?channel=beta", 1], ["?channel=stable", 0], ["", 1]] as const) {
      const response = await exports.default.fetch(`https://api.test/v1/mod/download${query}`);
      expect(response.status, query).toBe(200);
      expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="Example.wasm"');
      expect(response.headers.get("Content-Type")).toBe("application/wasm");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await response.arrayBuffer()), query).toEqual(artifacts[index]);
    }
    // The caller's own revisions still control updates, independently of channel reports.
    expect(await (await update({ api_revisions: nightlyApi })).json()).toEqual(served(releases[3]!));
    await market({ op: "signin", identity: { provider: "google", subject: "2535400000009001", email: "2535400000009001@test.invalid", email_verified: true }, newSession: "owner-session", newCsrf: "owner-csrf" });
    for (const version of ["1.10.0", "2.0.0"]) {
      const id = await runInDurableObject(hub(), (_, state) => state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM mod_versions WHERE slug = 'cinnabar-mod' AND version = ?", version).one().id);
      expect((await market({ op: "pull", session: "owner-session", csrf: "owner-csrf", id,
        body: { reason: "Withdraw test release" } })).status).toBe(200);
    }
    await evictDurableObject(hub());
    for (const query of ["", "?channel=beta"]) {
      const response = await exports.default.fetch(`https://api.test/v1/mod/download${query}`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(artifacts[2]);
    }
    const unavailable = await exports.default.fetch("https://api.test/v1/mod/download?channel=nightly");
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects invalid fresh-download channels with the existing Channel schema", async () => {
    for (const channel of ["", "unknown", "Beta", "nightly,stable", "null"]) {
      const response = await exports.default.fetch(`https://api.test/v1/mod/download?${new URLSearchParams({ channel })}`);
      expect(response.status, channel).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("advances the first-install download across API generations and keeps compatibility updates scoped", async () => {
    await publish(release());
    await publish(release("2.0.0", HOST_B, "2".repeat(40)));
    expect((await hub().latestModRelease())?.manifest.version).toBe("2.0.0");
    expect(await (await update()).json()).toEqual(served(release()));
    await env.MOD_ASSETS.delete(`mod-releases/${HASH}`);
    const response = await exports.default.fetch("https://api.test/v1/mod/download");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses the reported-channel union until the selected channel first reports", async () => {
    const report = (channel: string, mod_api_revisions: unknown, secret = "test-hook-secret") =>
      exports.default.fetch("https://api.test/v1/mod/host-revisions", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, mod_api_revisions }),
      });
    const newestInstall = () => runInDurableObject(hub(), (instance) => instance.latestModRelease()?.manifest.version);
    expect((await publish(release("1.0.0"))).status).toBe(204);
    expect((await publish(release("2.0.0", HOST_B, "2".repeat(40)))).status).toBe(204);

    // Before any build reports its revisions, nothing is excluded.
    expect(await newestInstall()).toBe("2.0.0");

    // The newest version waits for a host build, and stays available to hosts reporting it.
    expect((await report("nightly", [HOST_A])).status).toBe(204);
    expect(await newestInstall()).toBe("1.0.0");
    const hostB = await update({ host_revision: HOST_B, api_revisions: HOST_B });
    expect((await hostB.json() as ModRelease).manifest.version).toBe("2.0.0");
    const download = await exports.default.fetch("https://api.test/v1/mod/download");
    expect(download.status).toBe(200);
    await download.arrayBuffer();

    // Beta has never reported, so it uses the union; each report replaces its channel's list.
    expect((await report("stable", [HOST_B])).status).toBe(204);
    expect(await newestInstall()).toBe("2.0.0");
    expect((await report("stable", [HOST_A, HOST_A])).status).toBe(204);
    expect(await newestInstall()).toBe("1.0.0");

    // Reports survive a restart.
    await evictDurableObject(hub());
    expect(await newestInstall()).toBe("1.0.0");

    // An empty report excludes everything rather than restoring the unfiltered start.
    expect((await report("stable", [])).status).toBe(204);
    expect((await report("nightly", [])).status).toBe(204);
    expect(await newestInstall()).toBeUndefined();
    expect((await exports.default.fetch("https://api.test/v1/mod/download")).status).toBe(404);

    // Beta's own first report ends the union fallback, including an explicit empty report.
    expect((await report("nightly", [HOST_B])).status).toBe(204);
    expect(await newestInstall()).toBe("2.0.0");
    expect((await report("beta", [])).status).toBe(204);
    expect(await newestInstall()).toBeUndefined();
    expect((await exports.default.fetch("https://api.test/v1/mod/download?channel=beta")).status).toBe(404);
    expect((await report("beta", [HOST_A])).status).toBe(204);
    await evictDurableObject(hub());
    expect(await newestInstall()).toBe("1.0.0");
  });

  it("accepts a report of every supported revision and rejects invalid ones", async () => {
    const report = (channel: unknown, mod_api_revisions: unknown, secret = "test-hook-secret") =>
      exports.default.fetch("https://api.test/v1/mod/host-revisions", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, mod_api_revisions }),
      });
    expect((await report("nightly", Array(32).fill(HOST_A))).status).toBe(204);
    expect((await report("nightly", Array(33).fill(HOST_A))).status).toBe(400);
    expect((await report("nightly", ["not-a-revision"])).status).toBe(400);
    expect((await report("nightly", undefined)).status).toBe(400);
    expect((await report("unknown", [HOST_A])).status).toBe(400);
    expect((await report("nightly", [HOST_A], "wrong")).status).toBe(401);
    // Publishers of mods hold a separate credential, which cannot report hosts.
    expect((await report("nightly", [HOST_A], "test-mod-hook-secret")).status).toBe(401);
  });

  it("rejects corrupt, non-component and oversized uploads before publication", async () => {
    const url = `https://api.test/v1/mod/assets/${HASH}`;
    const headers = { Authorization: "Bearer test-mod-hook-secret" };
    const changed = BYTES.slice(); changed[255] = 1;
    for (const bytes of [changed, new Uint8Array(8)]) {
      expect((await exports.default.fetch(url, { method: "PUT", body: bytes, headers })).status).toBe(400);
    }
    expect((await exports.default.fetch(url, { method: "PUT", body: BYTES,
      headers: { ...headers, "Content-Length": String(32 * 1024 * 1024 + 1) } })).status).toBe(400);
    const stored = await env.MOD_ASSETS.get(`mod-releases/${HASH}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(BYTES);
  });

  it("retains the previous compatible release after publishing for a newer host", async () => {
    const old = release();
    const latest = release("2.0.0", HOST_B, "2".repeat(40));
    expect((await publish(old)).status).toBe(204);
    expect((await publish(latest)).status).toBe(204);
    expect(await (await update()).json()).toEqual(served(old));
    expect(await (await update({ host_revision: HOST_B, api_revisions: HOST_B })).json()).toEqual(served(latest));
    await evictDurableObject(hub());
    expect(await (await update()).json()).toEqual(served(old));
  });

  it("orders compatible releases by numeric version regardless of publication order", async () => {
    for (const version of ["1.10.0", "1.2.0", "1.9.0"]) {
      await publish(release(version, HOST_A, version.padEnd(40, "0").replaceAll(".", "a")));
    }
    expect(await (await update()).json()).toEqual(served(release("1.10.0", HOST_A, "1a10a0".padEnd(40, "0"))));
  });

  it("never falls back for unsupported API revisions", async () => {
    await publish(release());
    expect((await update({ host_revision: HOST_B, api_revisions: HOST_B })).status).toBe(204);
    expect((await update()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("offers the same compatible mod to newer native commits without changing the mod build pin", async () => {
    const body = release();
    await publish(body);
    expect(await (await update({ host_revision: HOST_B })).json()).toEqual(served(body));
  });

  it("keeps old API support when a new native build adds capabilities", async () => {
    const old = release();
    const next = release("2.0.0", HOST_B, "2".repeat(40));
    await publish(old); await publish(next);
    expect(await (await update()).json()).toEqual(served(old));
    expect(await (await update({ host_revision: HOST_B, api_revisions: `${HOST_A},${HOST_B}` })).json()).toEqual(served(next));
    expect(await (await update({ host_revision: HOST_B, api_revisions: `${HOST_A},${"f".repeat(40)}` })).json()).toEqual(served(old));
  });

  it("does not repeat the installed revision or downgrade a version", async () => {
    await publish(release());
    for (const query of [{ current_revision: "1".repeat(40) }, { current_version: "1.0.0" }, { current_version: "2.0.0" }]) {
      expect((await update(query)).status).toBe(204);
    }
  });

  it("accepts identical retries and rejects replacement of an existing version", async () => {
    const body = release();
    expect((await publish(body)).status).toBe(204);
    expect((await publish(body)).status).toBe(204);
    body.manifest.artifact.sha256 = "d".repeat(64);
    expect((await publish(body)).status).toBe(409);
    const selected = await (await update()).json() as ModRelease;
    expect(selected.manifest.artifact.sha256).toBe(HASH);
  });

  it("keeps concurrent conflicting publications consistent", async () => {
    const a = release();
    const b = release("1.0.0", HOST_B, "2".repeat(40));
    expect((await Promise.all([publish(a), publish(b)])).map((r) => r.status).sort()).toEqual([204, 409]);
    const selected = [(await update()).status, (await update({ host_revision: HOST_B, api_revisions: HOST_B })).status].sort();
    expect(selected).toEqual([200, 204]);
  });

  it("requires publication authorization before parsing a body", async () => {
    for (const secret of [null, "wrong", "test-hook-secret"]) expect((await publish("invalid", secret)).status).toBe(401);
  });

  it("restricts publishing to the configured repository and packages", async () => {
    for (const mutate of [
      (r: ModRelease) => { r.manifest.package = "other-mod"; },
      (r: ModRelease) => { r.manifest.host.repository = "https://example.com/other.git"; },
      (r: ModRelease) => { r.download_url = r.download_url.replace("example/mod", "other/mod"); },
      (r: ModRelease) => { r.download_url = r.download_url.replace("/v1.0.0/", "/latest/"); },
    ]) {
      const body = release(); mutate(body);
      expect((await publish(body)).status).toBe(403);
    }
  });

  it("rejects malformed, prerelease, abbreviated and unsafe metadata", async () => {
    for (const mutate of [
      (r: ModRelease) => { r.manifest.host.api_revision = "abcdef0"; },
      (r: ModRelease) => { r.manifest.host.revision = ""; },
      (r: ModRelease) => { r.manifest.version = "1.0.0-beta"; },
      (r: ModRelease) => { r.manifest.artifact.sha256 = "invalid"; },
      (r: ModRelease) => { r.download_url = "http://example.com/file.wasm"; },
      (r: ModRelease) => { r.download_url = "https://user:secret@example.com/file.wasm"; },
    ]) {
      const body = release(); mutate(body);
      expect((await publish(body)).status).toBe(400);
    }
    expect((await publish("{")).status).toBe(400);
    expect((await publish(" ".repeat(17 * 1024))).status).toBe(400);
  });

  it("requires both complete installed identities", async () => {
    for (const overrides of [{ api_revisions: "" }, { api_revisions: "abc" }, { host_revision: "abcdef0" }, { current_version: "" }, { current_revision: "" }]) {
      expect((await update(overrides)).status).toBe(400);
    }
    expect((await exports.default.fetch(`https://api.test/v1/mod/update`)).status).toBe(400);
  });

  it("accepts thirty-two complete API revisions and rejects longer or malformed lists", async () => {
    expect((await update({ api_revisions: Array(32).fill(HOST_A).join(",") })).status).toBe(204);
    for (const api_revisions of [Array(33).fill(HOST_A).join(","), `${HOST_A},`, `${HOST_A},abc`]) {
      expect((await update({ api_revisions })).status).toBe(400);
    }
  });
});
