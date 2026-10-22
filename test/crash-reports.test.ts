/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0001_crash_reports.sql?raw";
import { receive, expire } from "../src/crash-reports";
import { validPayload, MAX_COMPRESSED_BYTES, MAX_JSON_BYTES, RETENTION_MS } from "../src/crash-reports/schema";

beforeAll(async () => {
  for (const sql of migration.replace(/^--.*$/gm, "").split(";").filter((sql) => sql.trim())) {
    await env.CRASH_INDEX.prepare(sql).run();
  }
});
beforeEach(async () => {
  await env.CRASH_INDEX.prepare("DELETE FROM crash_reports").run();
  const objects = await env.CRASH_REPORTS.list();
  if (objects.objects.length) await env.CRASH_REPORTS.delete(objects.objects.map((object) => object.key));
});

/** A synthetic payload with no account or server identity. */
function payload() {
  return { schema: 1, report_id: crypto.randomUUID().replaceAll("-", ""),
    install_id: crypto.randomUUID().replaceAll("-", ""), signature: "panic: a.rs:1: boom",
    kind: "panic", release: "1.2.3", commit: "abcdef", build_profile: "release", os: "linux", arch: "x86_64",
    gpu: "test GPU", driver: null, backend: "vulkan", uptime_ms: 1, report: { message: "boom" }, native: null, stack: null, log: ["INFO test"] };
}
/** Encodes a body exactly as the client does, with a unique request IP per test request. */
async function request(value: unknown): Promise<Request> {
  const body = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return new Request("https://api.test/v1/crash-reports", { method: "POST", body,
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "CF-Connecting-IP": crypto.randomUUID() } });
}
/** Keeps storage real while giving each test explicit control of the rate-limit result. */
function bindings() {
  return { ...env, CRASH_IP_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    CRASH_INSTALL_LIMIT: { limit: vi.fn(async () => ({ success: true })) } };
}
/** Calls the actual owner route with its configured fixture bearer token. */
function owner(path = "", token = "test-crash-owner") {
  return exports.default.fetch(`https://api.test/v1/crash-reports${path}`,
    { headers: { Authorization: `Bearer ${token}` } });
}

describe("crash reports", { timeout: 30000 }, () => {
  it("stores a retry once and keeps grouping counts correct", async () => {
    const value = payload();
    expect((await receive(await request(value), bindings())).status).toBe(201);
    expect((await receive(await request(value), bindings())).status).toBe(200);
    const other = { ...value, report_id: payload().report_id };
    expect((await receive(await request(other), bindings())).status).toBe(201);
    const groups = await (await owner("?groups=1")).json();
    expect(groups).toMatchObject({ groups: [{ signature: value.signature, version: "1.2.3", os: "linux", gpu: "test GPU", backend: "vulkan", count: 2 }] });
    expect((await (await owner(`/${value.report_id}`)).json())).toEqual(value);
    expect((await env.CRASH_REPORTS.list()).objects).toHaveLength(2);
  });

  it("rejects id reuse with a changed payload or install", async () => {
    const value = payload();
    await receive(await request(value), bindings());
    expect((await receive(await request({ ...value, log: ["changed"] }), bindings())).status).toBe(422);
    expect((await receive(await request({ ...value, install_id: payload().install_id }), bindings())).status).toBe(422);
    expect(await (await owner(`/${value.report_id}`)).json()).toEqual(value);
  });

  it("resumes a reservation after an R2 failure without creating a duplicate", async () => {
    const value = payload();
    const broken = bindings();
    const put = vi.spyOn(broken.CRASH_REPORTS, "put").mockRejectedValueOnce(new Error("unavailable"));
    await expect(receive(await request(value), broken)).rejects.toThrow("unavailable");
    put.mockRestore();
    expect(await (await owner("?groups=1")).json()).toEqual({ groups: [] });
    expect((await receive(await request(value), bindings())).status).toBe(201);
    expect((await env.CRASH_REPORTS.list()).objects).toHaveLength(1);
  });

  it("requires the owner secret for both listing and payload access", async () => {
    const value = payload();
    await receive(await request(value), bindings());
    for (const path of ["", "?groups=1", `/${value.report_id}`]) {
      expect((await owner(path, "wrong")).status).toBe(401);
      expect((await exports.default.fetch(`https://api.test/v1/crash-reports${path}`)).status).toBe(401);
      expect((await owner(path)).status).toBe(200);
    }
  });

  it("enforces schema, module indices and bounded nesting", async () => {
    const value = payload();
    for (const bad of [{ ...value, schema: 2 }, { ...value, install_id: "xuid" }, { ...value, minidump: "memory" },
      { ...value, report: { message: "x", session_id: "secret" } }, { ...value, log: Array(201).fill("x") },
      { ...value, stack: { reason: "signal", modules: [], frames: [{ module: 0, offset: "0x10", trust: "context" }] } }]) {
      expect((await receive(await request(bad), bindings())).status).toBe(422);
    }
    let nested: unknown = {};
    for (let i = 0; i < 30; i++) nested = { nested };
    expect(validPayload({ ...value, report: { message: "x", renderer: nested } })).toBe(false);
    expect(await env.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("caps the compressed body and gzip expansion and rejects malformed encodings", async () => {
    const value = payload();
    const tooLarge = await request(value);
    tooLarge.headers.set("Content-Length", String(MAX_COMPRESSED_BYTES + 1));
    expect((await receive(tooLarge, bindings())).status).toBe(413);
    const raw = new Request("https://api.test/v1/crash-reports", { method: "POST", body: new Uint8Array(MAX_COMPRESSED_BYTES + 1),
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } });
    expect((await receive(raw, bindings())).status).toBe(413);
    expect((await receive(await request({ ...value, log: ["x".repeat(MAX_JSON_BYTES)] }), bindings())).status).toBe(413);
    expect((await receive(new Request("https://api.test", { method: "POST", body: "x" }), bindings())).status).toBe(415);
    expect((await receive(new Request("https://api.test", { method: "POST", body: "not gzip",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }), bindings())).status).toBe(400);
  });

  it("enforces each rate limit before any storage write", async () => {
    for (const name of ["CRASH_IP_LIMIT", "CRASH_INSTALL_LIMIT"] as const) {
      const limited = bindings();
      limited[name].limit.mockResolvedValue({ success: false });
      const response = await receive(await request(payload()), limited);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(await env.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("hides expired reports and deletes their objects and index rows", async () => {
    const old = payload(), fresh = payload();
    const now = Date.now();
    await receive(await request(old), bindings(), now - RETENTION_MS - 1);
    await receive(await request(fresh), bindings(), now);
    expect((await owner(`/${old.report_id}`)).status).toBe(404);
    expect(await expire(env, now)).toBe(1);
    expect(await expire(env, now)).toBe(0);
    expect((await env.CRASH_REPORTS.list()).objects).toHaveLength(1);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 1 }] });
  });
  it("uses the configured per-install limiter", async () => {
    const first = payload();
    for (let i = 0; i < 7; i++) {
      const value = { ...first, report_id: payload().report_id };
      expect((await receive(await request(value), env)).status).toBe(i < 6 ? 201 : 429);
    }
  });

  it("uses the configured per-IP limiter even for malformed bodies", async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 31; i++) {
      const req = new Request("https://api.test/v1/crash-reports", { method: "POST", body: "invalid",
        headers: { "CF-Connecting-IP": ip } });
      expect((await receive(req, env)).status).toBe(i < 30 ? 415 : 429);
    }
  });

});
