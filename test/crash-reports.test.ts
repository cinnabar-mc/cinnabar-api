/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import worker from "../src/index";
import local from "../crash-bindings.local.json";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0001_crash_reports.sql?raw";
import { receive, expire, listing, report } from "../src/crash-reports";
import { validPayload, MAX_COMPRESSED_BYTES, MAX_JSON_BYTES, RETENTION_MS } from "../src/crash-reports/schema";

// The fixture configuration supplies every optional crash binding.
const crashEnv = env as Env & CrashBindings;

beforeAll(async () => {
  for (const sql of migration.replace(/^--.*$/gm, "").split(";").filter((sql) => sql.trim())) {
    await crashEnv.CRASH_INDEX.prepare(sql).run();
  }
});
beforeEach(async () => {
  await crashEnv.CRASH_INDEX.prepare("DELETE FROM crash_reports").run();
  const objects = await crashEnv.CRASH_REPORTS.list();
  if (objects.objects.length) await crashEnv.CRASH_REPORTS.delete(objects.objects.map((object) => object.key));
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
  return { ...crashEnv, CRASH_IP_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    CRASH_INSTALL_LIMIT: { limit: vi.fn(async () => ({ success: true })) } };
}
/** Calls the actual owner route with its configured fixture bearer token. */
function owner(path = "", token = "test-crash-owner") {
  return exports.default.fetch(`https://api.test/v1/crash-reports${path}`,
    { headers: { Authorization: `Bearer ${token}` } });
}

describe("crash reports", { timeout: 30000 }, () => {
  it("keeps crash routes unavailable until storage is provisioned", async () => {
    const unconfigured = { ...env, CRASH_REPORTS: undefined, CRASH_INDEX: undefined,
      CRASH_IP_LIMIT: undefined, CRASH_INSTALL_LIMIT: undefined } as unknown as Env;
    expect((await receive(await request(payload()), unconfigured)).status).toBe(503);
    expect((await listing(new URL("https://api.test/v1/crash-reports"), unconfigured)).status).toBe(503);
    expect((await report(payload().report_id, unconfigured)).status).toBe(503);
    expect(await expire(unconfigured)).toBe(0);
  });

  it("stores a retry once and keeps grouping counts correct", async () => {
    const value = payload();
    expect((await receive(await request(value), bindings())).status).toBe(201);
    expect((await receive(await request(value), bindings())).status).toBe(200);
    const other = { ...value, report_id: payload().report_id };
    expect((await receive(await request(other), bindings())).status).toBe(201);
    const groups = await (await owner("?groups=1")).json();
    expect(groups).toMatchObject({ groups: [{ signature: value.signature, version: "1.2.3", os: "linux", gpu: "test GPU", backend: "vulkan", count: 2 }] });
    expect((await (await owner(`/${value.report_id}`)).json())).toEqual(value);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(2);
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
    expect(await (await owner("?groups=1")).json()).toEqual({ groups: [], next_cursor: null });
    expect((await receive(await request(value), bindings())).status).toBe(201);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(1);
  });

  it("completes an existing R2 object when index confirmation was interrupted", async () => {
    const value = payload();
    await receive(await request(value), bindings());
    await crashEnv.CRASH_INDEX.prepare("UPDATE crash_reports SET stored = 0 WHERE id = ?").bind(value.report_id).run();
    expect((await receive(await request(value), bindings())).status).toBe(201);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(1);
    expect(await (await owner(`/${value.report_id}`)).json()).toEqual(value);
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
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
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
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("hides expired reports and deletes their objects and index rows", async () => {
    const old = payload(), fresh = payload();
    const now = Date.now();
    await receive(await request(old), bindings(), now - RETENTION_MS - 1);
    await receive(await request(fresh), bindings(), now);
    expect((await owner(`/${old.report_id}`)).status).toBe(404);
    expect(await expire(env, now)).toBe(1);
    expect(await expire(env, now)).toBe(0);
    expect((await crashEnv.CRASH_REPORTS.list()).objects.filter((object) => object.size > 0)).toHaveLength(1);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 1 }] });
  });
  it("does not resume a pending reservation while retention removes it", async () => {
    const value = payload();
    await receive(await request(value), bindings());
    await crashEnv.CRASH_REPORTS.delete(`reports/${value.report_id}.json`);
    await crashEnv.CRASH_INDEX.prepare("UPDATE crash_reports SET stored = 0, received_at = ? WHERE id = ?")
      .bind(Date.now() - RETENTION_MS - 1, value.report_id).run();
    const original = crashEnv.CRASH_REPORTS.put.bind(crashEnv.CRASH_REPORTS);
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put").mockImplementationOnce(async (key, data, options) => {
      await expire(crashEnv);
      return original(key, data, options);
    });
    try {
      expect((await receive(await request(value), bindings())).status).toBe(422);
    } finally { put.mockRestore(); }
    await expire(crashEnv);
    expect((await crashEnv.CRASH_REPORTS.list()).objects.filter((object) => object.size > 0)).toHaveLength(0);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("fences an in-flight retry when its pending reservation reaches retention", async () => {
    const value = payload();
    const received = Date.now();
    await receive(await request(value), bindings(), received);
    await crashEnv.CRASH_REPORTS.delete(`reports/${value.report_id}.json`);
    await crashEnv.CRASH_INDEX.prepare("UPDATE crash_reports SET stored = 0 WHERE id = ?").bind(value.report_id).run();
    const original = crashEnv.CRASH_REPORTS.put.bind(crashEnv.CRASH_REPORTS);
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put").mockImplementationOnce(async (key, data, options) => {
      await expire(crashEnv, received + RETENTION_MS + 1);
      return original(key, data, options);
    });
    try {
      const response = await receive(await request(value), bindings(), received + RETENTION_MS - 1);
      const object = await crashEnv.CRASH_REPORTS.get(`reports/${value.report_id}.json`);
      expect(await object?.text()).toBe("");
      expect([422, 503]).toContain(response.status);
    } finally { put.mockRestore(); }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("acknowledges both identical retries finalized concurrently", async () => {
    const value = payload();
    const original = crashEnv.CRASH_REPORTS.put.bind(crashEnv.CRASH_REPORTS);
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    let arrived = 0;
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put").mockImplementation(async (key, data, options) => {
      if (++arrived === 2) release();
      await both;
      return original(key, data, options);
    });
    try {
      const responses = await Promise.all([
        receive(await request(value), bindings()), receive(await request(value), bindings()),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    } finally { put.mockRestore(); }
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(1);
  });

  it("does not confirm a replacement reservation after its original expires", async () => {
    const value = payload();
    const received = Date.now();
    await receive(await request(value), bindings(), received);
    await crashEnv.CRASH_INDEX.prepare("UPDATE crash_reports SET stored = 0 WHERE id = ?").bind(value.report_id).run();
    await crashEnv.CRASH_REPORTS.delete(`reports/${value.report_id}.json`);
    const saved = await crashEnv.CRASH_INDEX.prepare("SELECT install_id, payload_hash FROM crash_reports WHERE id = ?")
      .bind(value.report_id).first<{ install_id: string; payload_hash: string }>();
    const original = crashEnv.CRASH_REPORTS.put.bind(crashEnv.CRASH_REPORTS);
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put").mockImplementationOnce(async (key, data, options) => {
      const object = await original(key, data, options);
      await expire(crashEnv, received + RETENTION_MS + 1);
      await crashEnv.CRASH_INDEX.prepare(`INSERT INTO crash_reports
        (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(value.report_id, saved!.install_id, saved!.payload_hash,
          received + RETENTION_MS + 2, value.signature, value.release, value.os, value.gpu, value.backend).run();
      return object;
    });
    try {
      expect((await receive(await request(value), bindings(), received + RETENTION_MS - 1)).status).toBe(503);
    } finally { put.mockRestore(); }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT stored FROM crash_reports WHERE id = ?").bind(value.report_id).first("stored")).toBe(0);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [] });
  });

  it("returns not found when retention replaces a payload during an owner read", async () => {
    const value = payload();
    await receive(await request(value), bindings());
    const original = crashEnv.CRASH_REPORTS.get.bind(crashEnv.CRASH_REPORTS);
    const get = vi.spyOn(crashEnv.CRASH_REPORTS, "get").mockImplementationOnce(async (key, options) => {
      await expire(crashEnv, Date.now() + RETENTION_MS + 1);
      return original(key, options);
    });
    try { expect((await report(value.report_id, crashEnv)).status).toBe(404); }
    finally { get.mockRestore(); }
  });

  it("paginates every crash group with tied timestamps", async () => {
    const received = Date.now();
    await crashEnv.CRASH_INDEX.batch(Array.from({ length: 101 }, (_, index) =>
      crashEnv.CRASH_INDEX.prepare(`INSERT INTO crash_reports
        (id, install_id, payload_hash, received_at, signature, version, os, gpu, backend, stored)
        VALUES (?, 'install', 'hash', ?, ?, 'release', 'os', 'gpu', 'backend', 1)`)
        .bind(index.toString(16).padStart(32, "0"), received, `group-${index}`)));
    const first = await (await owner("?groups=1")).json() as { groups: { signature: string }[]; next_cursor: string };
    expect(first.groups).toHaveLength(100);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await (await owner(`?groups=1&cursor=${encodeURIComponent(first.next_cursor)}`)).json() as
      { groups: { signature: string }[]; next_cursor: string | null };
    expect(second.groups).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.groups, ...second.groups].map((group) => group.signature)).size).toBe(101);
    expect((await owner("?groups=1&cursor=invalid")).status).toBe(400);
  });

  it("runs retention through the configured hourly schedule", async () => {
    const value = payload();
    await receive(await request(value), bindings(), Date.now() - RETENTION_MS - 1);
    await worker.scheduled({ cron: local.triggers.crons[0] } as ScheduledController, crashEnv);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
    expect(await (await crashEnv.CRASH_REPORTS.get(`reports/${value.report_id}.json`))?.text()).toBe("");
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
