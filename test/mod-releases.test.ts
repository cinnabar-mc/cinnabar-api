import { exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hub } from "./helpers";
import type { ModRelease, ModUpdateQuery } from "../src/mod-releases";

const HOST_A = "a".repeat(40);
const HOST_B = "b".repeat(40);
const REPOSITORY = "https://github.com/example/host.git";
const PACKAGE = "example-mod";

/** Creates synthetic metadata independent of any consumer's feature logic. */
function release(version = "1.0.0", host = HOST_A, revision = "1".repeat(40)): ModRelease {
  return {
    manifest: {
      schema_version: 1, package: PACKAGE, version, revision,
      host: { repository: REPOSITORY, revision: host, api_revision: host },
      artifact: { filename: "Example.wasm", size: 256, sha256: "c".repeat(64) },
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

beforeEach(async () => {
  await runInDurableObject(hub(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(hub());
});

describe("revision-aware mod releases", () => {
  it("retains the previous compatible release after publishing for a newer host", async () => {
    const old = release();
    const latest = release("2.0.0", HOST_B, "2".repeat(40));
    expect((await publish(old)).status).toBe(204);
    expect((await publish(latest)).status).toBe(204);
    expect(await (await update()).json()).toEqual(old);
    expect(await (await update({ host_revision: HOST_B, api_revisions: HOST_B })).json()).toEqual(latest);
    await evictDurableObject(hub());
    expect(await (await update()).json()).toEqual(old);
  });

  it("orders compatible releases by numeric version regardless of publication order", async () => {
    for (const version of ["1.10.0", "1.2.0", "1.9.0"]) {
      await publish(release(version, HOST_A, version.padEnd(40, "0").replaceAll(".", "a")));
    }
    expect(await (await update()).json()).toEqual(release("1.10.0", HOST_A, "1a10a0".padEnd(40, "0")));
  });

  it("never falls back for unsupported API revisions", async () => {
    await publish(release());
    expect((await update({ host_revision: HOST_B, api_revisions: HOST_B })).status).toBe(204);
    expect((await update()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("offers the same compatible mod to newer native commits without changing the mod build pin", async () => {
    const body = release();
    await publish(body);
    expect(await (await update({ host_revision: HOST_B })).json()).toEqual(body);
  });

  it("keeps old API support when a new native build adds capabilities", async () => {
    const old = release();
    const next = release("2.0.0", HOST_B, "2".repeat(40));
    await publish(old); await publish(next);
    expect(await (await update()).json()).toEqual(old);
    expect(await (await update({ host_revision: HOST_B, api_revisions: `${HOST_A},${HOST_B}` })).json()).toEqual(next);
    expect(await (await update({ host_revision: HOST_B, api_revisions: `${HOST_A},${"f".repeat(40)}` })).json()).toEqual(old);
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
    expect(selected.manifest.artifact.sha256).toBe("c".repeat(64));
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
});
