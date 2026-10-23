/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import worker from "../src/index";
import local from "../crash-bindings.local.json";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { receive, expire, listing, report } from "../src/crash-reports";
import { DAY_MS } from "../src/crash-reports/admission";
import { RELEASE_CACHE_KEY, RELEASE_CACHE_NAME } from "../src/crash-reports/releases";
import { validPayload, MAX_COMPRESSED_BYTES, MAX_JSON_BYTES, RETENTION_MS } from "../src/crash-reports/schema";

// The fixture configuration supplies every optional crash binding.
const crashEnv = env as Env & CrashBindings;

beforeAll(async () => {
  const fixture = env as Env & { TEST_CRASH_MIGRATIONS: { name: string; queries: string[] }[] };
  await applyD1Migrations(crashEnv.CRASH_INDEX, fixture.TEST_CRASH_MIGRATIONS);
});
beforeEach(async () => {
  await crashEnv.CRASH_INDEX.batch(["crash_reports", "crash_groups", "crash_ips", "crash_days"].map((table) =>
    crashEnv.CRASH_INDEX.prepare(`DELETE FROM ${table}`)));
  await (await caches.open(RELEASE_CACHE_NAME)).put(RELEASE_CACHE_KEY, Response.json({ versions: ["1.2.3", "1.2.3-beta", "1.2.3-nightly"] },
    { headers: { "Cache-Control": "public, max-age=300" } }));
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
  return { ...crashEnv, CRASH_GLOBAL_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    CRASH_IP_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
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
      CRASH_GLOBAL_LIMIT: undefined, CRASH_IP_LIMIT: undefined, CRASH_INSTALL_LIMIT: undefined } as unknown as Env;
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
    expect(groups).toMatchObject({ groups: [{ signature: value.signature, version: "1.2.3", count: 2, samples: 2 }] });
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT os, gpu, backend FROM crash_reports LIMIT 1").first())
      .toEqual({ os: "linux", gpu: "other", backend: "vulkan" });
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
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 1, samples: 1 }] });
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

  it("enforces each minute rate limit before any payload or group write", async () => {
    for (const name of ["CRASH_IP_LIMIT", "CRASH_INSTALL_LIMIT"] as const) {
      const limited = bindings();
      limited[name].limit.mockResolvedValue({ success: false });
      const response = await receive(await request(payload()), limited);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(0);
  });

  it("acknowledges the global gate with one fixed key and no D1 or R2 calls", async () => {
    const limited = bindings();
    limited.CRASH_GLOBAL_LIMIT.limit.mockResolvedValue({ success: false });
    const storage = [vi.spyOn(limited.CRASH_INDEX, "withSession"), vi.spyOn(limited.CRASH_INDEX, "prepare"),
      vi.spyOn(limited.CRASH_INDEX, "batch"), vi.spyOn(limited.CRASH_REPORTS, "put"),
      vi.spyOn(limited.CRASH_REPORTS, "head"), vi.spyOn(limited.CRASH_REPORTS, "get"),
      vi.spyOn(limited.CRASH_REPORTS, "list"), vi.spyOn(limited.CRASH_REPORTS, "delete")];
    try {
      for (let index = 0; index < 2; index++) {
        const req = await request(payload());
        const response = await receive(req, limited);
        expect(response.status).toBe(202);
        expect(req.bodyUsed).toBe(false);
        expect(await response.text()).toBe("");
        expect(response.headers.has("Retry-After")).toBe(false);
      }
      expect(limited.CRASH_GLOBAL_LIMIT.limit.mock.calls).toEqual([
        [{ key: "crash-reports" }], [{ key: "crash-reports" }],
      ]);
      expect(limited.CRASH_IP_LIMIT.limit).not.toHaveBeenCalled();
      expect(limited.CRASH_INSTALL_LIMIT.limit).not.toHaveBeenCalled();
      for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of storage) spy.mockRestore(); }
  });

  it("fails closed when only the global binding is missing", async () => {
    const limited = { ...bindings(), CRASH_GLOBAL_LIMIT: undefined };
    expect((await receive(await request(payload()), limited)).status).toBe(503);
    expect(limited.CRASH_IP_LIMIT.limit).not.toHaveBeenCalled();
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_days").first("COUNT(*)")).toBe(0);
  });

  it("hides expired reports and deletes their objects and index rows", async () => {
    const old = payload(), fresh = payload();
    const now = Date.now();
    await receive(await request(old), bindings(), now - RETENTION_MS - 1);
    await receive(await request(fresh), bindings(), now);
    expect((await owner(`/${old.report_id}`)).status).toBe(404);
    expect(await expire(env, now)).toBeGreaterThanOrEqual(1);
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
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 1 }] });
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
      crashEnv.CRASH_INDEX.prepare(`INSERT INTO crash_groups
        (day, signature, version, cursor_id, count, latest_at) VALUES (?, ?, 'release', ?, 1, ?)`)
        .bind(Math.floor(received / DAY_MS), `group-${index}`, index.toString(16).padStart(32, "0"), received)));
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

  it("paginates recurring crash groups across days without repeats or stalled cursors", async () => {
    const latest = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
    const groups = Array.from({ length: 205 }, (_, index) => ({
      signature: `recurring-${index}`, version: "release", count: 3, samples: 3,
      latest_at: latest - Math.floor(index / 110),
      cursor_id: (index * 3).toString(16).padStart(32, "0"),
    })).sort((a, b) => b.latest_at - a.latest_at || b.cursor_id.localeCompare(a.cursor_id));
    await crashEnv.CRASH_INDEX.batch(groups.flatMap((group) => [2, 1, 0].map((daysAgo) => {
      const received = group.latest_at - daysAgo * DAY_MS;
      const id = (parseInt(group.cursor_id, 16) + 2 - daysAgo).toString(16).padStart(32, "0");
      return crashEnv.CRASH_INDEX.prepare(`INSERT INTO crash_groups
        (day, signature, version, cursor_id, count, latest_at, samples) VALUES (?, ?, ?, ?, 1, ?, 1)`)
        .bind(Math.floor(received / DAY_MS), group.signature, group.version, id, received);
    })));
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await owner(`?groups=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { groups: {
        signature: string; version: string; count: number; samples: number; latest_at: number;
      }[]; next_cursor: string | null };
      const expected = groups.slice(page * 100, (page + 1) * 100);
      expect(body.groups).toEqual(expected.map(({ cursor_id, ...group }) => group));
      seen.push(...body.groups.map((group) => group.signature));
      const last = expected.at(-1)!;
      expect(body.next_cursor).toBe(page < 2 ? `${last.latest_at}:${last.cursor_id}` : null);
      if (cursor && body.next_cursor) {
        const before = Number(cursor.split(":")[0]);
        const after = Number(body.next_cursor.split(":")[0]);
        expect(after < before || (after === before && body.next_cursor < cursor)).toBe(true);
      }
      cursor = body.next_cursor;
    }
    expect(seen).toHaveLength(groups.length);
    expect(new Set(seen).size).toBe(groups.length);
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
    for (let i = 0; i < 6; i++) {
      const req = new Request("https://api.test/v1/crash-reports", { method: "POST", body: "invalid",
        headers: { "CF-Connecting-IP": ip } });
      expect((await receive(req, env)).status).toBe(i < 5 ? 415 : 429);
    }
  });

  it("stores 20 daily samples and counts further reports without R2 writes or report rows", async () => {
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put");
    try {
      for (let i = 0; i < 25; i++) {
        expect((await receive(await request(payload()), bindings())).status).toBe(i < 20 ? 201 : 202);
      }
      expect(put).toHaveBeenCalledTimes(20);
    } finally { put.mockRestore(); }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) AS count FROM crash_reports").first("count")).toBe(20);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 25, samples: 20 }] });
  });

  it("enforces the sample cap under concurrent uploads and device string rotation", async () => {
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "3" };
    const responses = await Promise.all(Array.from({ length: 12 }, async (_, index) => receive(await request({
      ...payload(), signature: index % 2 ? " PANIC:  A.RS:1: boom\u200b " : "panic: a.rs:1: boom",
      os: `invented-${index}`, gpu: `invented-${index}`, backend: `invented-${index}`,
    }), limited)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 202)).toHaveLength(9);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_groups").first("COUNT(*)")).toBe(1);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT DISTINCT os, gpu, backend FROM crash_reports").all())
      .toMatchObject({ results: [{ os: "other", gpu: "other", backend: "other" }] });
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 12, samples: 3 }] });
  });

  it("reserves a global byte budget atomically using inflated payload sizes", async () => {
    const value = payload();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const limited = { ...bindings(), CRASH_DAILY_MAX_BYTES: String(bytes * 2) };
    const responses = await Promise.all(Array.from({ length: 8 }, async () =>
      receive(await request({ ...value, report_id: payload().report_id }), limited)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 202)).toHaveLength(6);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT bytes FROM crash_days").first("bytes")).toBe(bytes * 2);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(2);
  });

  it("caps new groups concurrently but keeps counting admitted groups", async () => {
    const limited = { ...bindings(), CRASH_DAILY_MAX_GROUPS: "2", CRASH_SAMPLES_PER_GROUP: "0" };
    const responses = await Promise.all(Array.from({ length: 10 }, async (_, index) =>
      receive(await request({ ...payload(), signature: `panic: site-${index}` }), limited)));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(8);
    const group = await crashEnv.CRASH_INDEX.prepare("SELECT signature FROM crash_groups LIMIT 1").first<string>("signature");
    expect((await receive(await request({ ...payload(), signature: group! }), limited)).status).toBe(202);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT groups FROM crash_days").first("groups")).toBe(2);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT SUM(count) FROM crash_groups").first("SUM(count)")).toBe(3);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(0);
  });

  it("starts new daily sample, byte and group allowances at UTC midnight", async () => {
    const start = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "1", CRASH_DAILY_MAX_GROUPS: "1" };
    expect((await receive(await request(payload()), limited, start + DAY_MS - 1)).status).toBe(201);
    expect((await receive(await request(payload()), limited, start + DAY_MS - 1)).status).toBe(202);
    expect((await receive(await request(payload()), limited, start + DAY_MS)).status).toBe(201);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_groups").first("COUNT(*)")).toBe(2);
  });

  it("caps sampled and counting-only reports and stops all writes when full", async () => {
    const value = payload();
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "1", CRASH_DAILY_MAX_REPORTS: "2" };
    const first = await request(value);
    const ip = first.headers.get("CF-Connecting-IP")!;
    expect((await receive(first, limited)).status).toBe(201);
    expect((await receive(await request(value), limited)).status).toBe(200);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT reports FROM crash_days").first("reports")).toBe(1);
    expect((await receive(await request(payload()), limited)).status).toBe(202);
    const session = crashEnv.CRASH_INDEX.withSession("first-primary");
    const prepare = vi.spyOn(session, "prepare");
    const withSession = vi.spyOn(crashEnv.CRASH_INDEX, "withSession").mockReturnValue(session);
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put");
    const head = vi.spyOn(crashEnv.CRASH_REPORTS, "head");
    try {
      for (const rejected of [payload(), { ...payload(), signature: "another group" }, value]) {
        const req = await request(rejected);
        if (rejected === value) req.headers.set("CF-Connecting-IP", ip);
        const response = await receive(req, limited);
        expect(response.status).toBe(202);
        expect(response.headers.has("Retry-After")).toBe(false);
      }
      expect(prepare).toHaveBeenCalledTimes(3);
      for (const [sql] of prepare.mock.calls) expect(sql).toMatch(/^SELECT\b/);
      expect(put).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); withSession.mockRestore(); put.mockRestore(); head.mockRestore(); }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT reports, groups, ips FROM crash_days").first())
      .toEqual({ reports: 2, groups: 1, ips: 3 });
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 2, samples: 1 }] });
  });

  it("enforces the daily report cap atomically under concurrent uploads", async () => {
    const limited = { ...bindings(), CRASH_DAILY_MAX_REPORTS: "3" };
    const responses = await Promise.all(Array.from({ length: 12 }, async (unused, index) =>
      receive(await request({ ...payload(), signature: index % 2 ? "first group" : "second group" }), limited)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 202)).toHaveLength(9);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT reports FROM crash_days").first("reports")).toBe(3);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT SUM(count) FROM crash_groups").first("SUM(count)")).toBe(3);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_reports").first("COUNT(*)")).toBe(3);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(3);
  });

  it("silently drops a full day even when the per-IP minute limiter refuses", async () => {
    const limited = { ...bindings(), CRASH_DAILY_MAX_REPORTS: "1" };
    expect((await receive(await request(payload()), limited)).status).toBe(201);
    limited.CRASH_IP_LIMIT.limit.mockResolvedValue({ success: false });
    const response = await receive(await request(payload()), limited);
    expect(response.status).toBe(202);
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(limited.CRASH_IP_LIMIT.limit).toHaveBeenCalledTimes(1);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT reports, ips FROM crash_days").first())
      .toEqual({ reports: 1, ips: 1 });
  });

  it("resets the daily report cap exactly at UTC midnight", async () => {
    const start = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "0", CRASH_DAILY_MAX_REPORTS: "1" };
    for (const now of [start + DAY_MS - 1, start + DAY_MS - 1, start + DAY_MS]) {
      expect((await receive(await request(payload()), limited, now)).status).toBe(202);
    }
    expect((await crashEnv.CRASH_INDEX.prepare("SELECT reports, ips FROM crash_days ORDER BY day").all()).results)
      .toEqual([{ reports: 1, ips: 1 }, { reports: 1, ips: 1 }]);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT SUM(count) FROM crash_groups").first("SUM(count)")).toBe(2);
  });

  it("disables daily admission with a zero report budget without accounting writes", async () => {
    const limited = { ...bindings(), CRASH_DAILY_MAX_REPORTS: "0" };
    expect((await receive(await request(payload()), limited)).status).toBe(202);
    expect(limited.CRASH_IP_LIMIT.limit).not.toHaveBeenCalled();
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_days").first("COUNT(*)")).toBe(0);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(0);
  });

  it("limits daily attempts across install rotation and concurrent requests, then resets", async () => {
    const start = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const ip = "192.0.2.50";
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "0" };
    const responses = await Promise.all(Array.from({ length: 55 }, async () => {
      const req = await request(payload());
      req.headers.set("CF-Connecting-IP", ip);
      return receive(req, limited, start);
    }));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(50);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
    expect(responses.find((response) => response.status === 429)?.headers.get("Retry-After")).toBe("86400");
    const req = await request(payload());
    req.headers.set("CF-Connecting-IP", ip);
    expect((await receive(req, limited, start + DAY_MS)).status).toBe(202);
    const rows = await crashEnv.CRASH_INDEX.prepare("SELECT day, ip_hash, count FROM crash_ips ORDER BY day").all();
    expect(rows.results.map((row) => row.count)).toEqual([50, 1]);
    expect(rows.results[0]!.ip_hash).not.toBe(rows.results[1]!.ip_hash);
    expect(JSON.stringify(rows.results)).not.toContain(ip);
  });

  it("bounds daily IP cardinality while preserving existing IP allowances", async () => {
    const ip = "192.0.2.51", now = Date.now();
    const req = await request(payload());
    req.headers.set("CF-Connecting-IP", ip);
    expect((await receive(req, bindings(), now)).status).toBe(201);
    await crashEnv.CRASH_INDEX.prepare("UPDATE crash_days SET ips = 65536").run();
    expect((await receive(await request(payload()), bindings(), now)).status).toBe(429);
    const retry = await request(payload());
    retry.headers.set("CF-Connecting-IP", ip);
    expect((await receive(retry, bindings(), now)).status).toBe(201);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_ips").first("COUNT(*)")).toBe(1);
  });

  it("counts malformed bodies against the daily limit", async () => {
    const ip = "192.0.2.52";
    for (let index = 0; index < 51; index++) {
      const req = new Request("https://api.test/v1/crash-reports", { method: "POST", body: "invalid",
        headers: { "CF-Connecting-IP": ip } });
      expect((await receive(req, bindings())).status).toBe(index < 50 ? 415 : 429);
    }
  });

  it("keeps failed reservations within the cap and does not charge retries twice", async () => {
    const value = payload();
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "1" };
    const put = vi.spyOn(crashEnv.CRASH_REPORTS, "put").mockRejectedValueOnce(new Error("offline"));
    try { await expect(receive(await request(value), limited)).rejects.toThrow("offline"); }
    finally { put.mockRestore(); }
    const reserved = await crashEnv.CRASH_INDEX.prepare("SELECT bytes FROM crash_days").first("bytes");
    expect((await receive(await request(payload()), limited)).status).toBe(202);
    expect((await receive(await request(value), limited)).status).toBe(201);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT bytes FROM crash_days").first("bytes")).toBe(reserved);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 2, samples: 1 }] });
  });

  it("rejects unshipped versions, implausible commits and empty or oversized signatures", async () => {
    for (const change of [{ release: "9.9.9" }, { release: "custom-build" }, { commit: "local-debug" },
      { signature: " \u200b " }, { signature: "x".repeat(241) }]) {
      expect((await receive(await request({ ...payload(), ...change }), bindings())).status).toBe(422);
    }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_groups").first("COUNT(*)")).toBe(0);
    for (const release of ["1.2.3", "1.2.3-beta", "1.2.3-nightly", "v1.2.3"]) {
      expect((await receive(await request({ ...payload(), release }), bindings())).status).toBe(201);
    }
  });

  it("disables ingestion before limiter, decoding, release lookup or storage", async () => {
    for (const disabled of ["true", "", "invalid"]) {
      const limited = { ...bindings(), CRASH_INGESTION_DISABLED: disabled };
      expect((await receive(await request(payload()), limited)).status).toBe(503);
      expect(limited.CRASH_GLOBAL_LIMIT.limit).not.toHaveBeenCalled();
      expect(limited.CRASH_IP_LIMIT.limit).not.toHaveBeenCalled();
    }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_days").first("COUNT(*)")).toBe(0);
  });

  it("fails closed for invalid budgets and supports a zero-byte counting-only budget", async () => {
    for (const setting of ["CRASH_DAILY_MAX_BYTES", "CRASH_DAILY_MAX_GROUPS", "CRASH_SAMPLES_PER_GROUP", "CRASH_DAILY_MAX_REPORTS"] as const) {
      for (const value of ["", " ", "bad", "-1", "1.5", "Infinity", "9007199254740992"]) {
        expect((await receive(await request(payload()), { ...bindings(), [setting]: value })).status).toBe(503);
      }
    }
    expect((await receive(await request(payload()), { ...bindings(), CRASH_DAILY_MAX_BYTES: "0" })).status).toBe(202);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(0);
  });

  it("retains counting-only groups for 90 days and prunes old IP counters in bounded batches", async () => {
    const now = Date.now();
    const limited = { ...bindings(), CRASH_SAMPLES_PER_GROUP: "0" };
    await receive(await request(payload()), limited, now - RETENTION_MS - DAY_MS);
    await receive(await request(payload()), limited, now);
    expect(await (await owner("?groups=1")).json()).toMatchObject({ groups: [{ count: 1 }] });
    while (await expire(crashEnv, now)) { /* Drain bounded cleanup batches. */ }
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_groups").first("COUNT(*)")).toBe(1);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_days").first("COUNT(*)")).toBe(1);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_ips").first("COUNT(*)")).toBe(1);
  });

  it("returns 503 without a payload or group write when publication is unavailable", async () => {
    await (await caches.open(RELEASE_CACHE_NAME)).put(RELEASE_CACHE_KEY, Response.json({ versions: null },
      { headers: { "Cache-Control": "public, max-age=30" } }));
    expect((await receive(await request(payload()), bindings())).status).toBe(503);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_groups").first("COUNT(*)")).toBe(0);
    expect((await crashEnv.CRASH_REPORTS.list()).objects).toHaveLength(0);
  });

  it("bounds past-day IP cleanup without needing any stored reports", async () => {
    const day = Math.floor(Date.now() / DAY_MS) - 1;
    await crashEnv.CRASH_INDEX.prepare("INSERT INTO crash_days (day, salt) VALUES (?, 'fixture')").bind(day).run();
    await crashEnv.CRASH_INDEX.prepare(`WITH RECURSIVE ids(id) AS
      (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 1001)
      INSERT INTO crash_ips (day, ip_hash, count) SELECT ?, CAST(id AS TEXT), 1 FROM ids`).bind(day).run();
    expect(await expire(crashEnv)).toBe(1000);
    expect(await crashEnv.CRASH_INDEX.prepare("SELECT COUNT(*) FROM crash_ips").first("COUNT(*)")).toBe(1);
    expect(await expire(crashEnv)).toBe(1);
    expect(await expire(crashEnv)).toBe(0);
  });

});
