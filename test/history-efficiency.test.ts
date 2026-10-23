import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PresenceHistory } from "../src/presence-history";
import { HISTORY_KEY, MINUTE_MS, loadHistory, snapshotHistory } from "../src/history-snapshot";
import { hub } from "./helpers";

let now: number;
beforeEach(async () => {
  now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  await env.API_CACHE.delete(HISTORY_KEY);
  await runInDurableObject(hub(), (_, state) => {
    state.storage.sql.exec("DELETE FROM presence_samples");
    state.storage.sql.exec("DELETE FROM presence_publication");
  });
});
afterEach(() => vi.restoreAllMocks());

it("bootstraps a month once and reads only one new observation after hibernation", async () => {
  await runInDurableObject(hub(), async (_, state) => {
    const sql = state.storage.sql;
    sql.exec(`WITH RECURSIVE samples(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM samples WHERE i < 43199
    ) INSERT INTO presence_samples (at, online) SELECT ? - i * 60000, 7 FROM samples`, now);
    const history = new PresenceHistory(sql, env.API_CACHE);
    const exec = vi.spyOn(sql, "exec");
    try {
      await history.publish(now);
      const bootstrapReads = exec.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value.rowsRead : 0), 0);
      expect(bootstrapReads).toBeLessThanOrEqual(43_202);
      expect(bootstrapReads).toBeGreaterThanOrEqual(43_200);
      const restored = new PresenceHistory(sql, env.API_CACHE);
      restored.record(now + MINUTE_MS, 9);
      exec.mockClear();
      await restored.publish(now + MINUTE_MS);
      expect(exec.mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value.rowsRead : 0), 0)).toBeLessThanOrEqual(2);
      const result = snapshotHistory(await loadHistory(env.API_CACHE), "24h", now + MINUTE_MS);
      expect(result.points.at(-1)).toEqual({ at: now + MINUTE_MS, online: 9, peak: 9, samples: 1 });
      expect(result.points.length).toBeLessThanOrEqual(1441);
    } finally { exec.mockRestore(); }
  });
});

it("serves every public range without touching the Hub even when session storage is unavailable", async () => {
  await runInDurableObject(hub(), async (_, state) => {
    const history = new PresenceHistory(state.storage.sql, env.API_CACHE);
    history.record(now, 3);
    await history.publish(now);
  });
  const get = vi.spyOn(env.HUB, "get").mockImplementation(() => { throw new Error("session storage unavailable"); });
  const origin = `https://${crypto.randomUUID()}.api.test`;
  for (const range of ["24h", "7d", "30d"]) {
    const response = await exports.default.fetch(`${origin}/v1/presence/history?range=${range}&unused=one`, {
      headers: { Authorization: "Bearer unrelated" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ range, points: [{ online: 3, peak: 3, samples: 1 }] });
  }
  expect(get).not.toHaveBeenCalled();
});

it("catches up unpublished minutes after an R2 failure without duplicating samples", async () => {
  await runInDurableObject(hub(), async (_, state) => {
    const history = new PresenceHistory(state.storage.sql, env.API_CACHE);
    history.record(now, 3);
    const put = vi.spyOn(env.API_CACHE, "put").mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(history.publish(now)).rejects.toThrow("R2 unavailable");
    put.mockRestore();
    const restored = new PresenceHistory(state.storage.sql, env.API_CACHE);
    restored.record(now + MINUTE_MS, 5);
    restored.record(now + MINUTE_MS, 999);
    await restored.publish(now + MINUTE_MS);
    const result = snapshotHistory(await loadHistory(env.API_CACHE), "24h", now + MINUTE_MS);
    expect(result.points).toEqual([
      { at: now, online: 3, peak: 3, samples: 1 },
      { at: now + MINUTE_MS, online: 5, peak: 5, samples: 1 },
    ]);
  });
});

it("retains publication backoff across hibernation during a prolonged R2 outage", async () => {
  await runInDurableObject(hub(), async (_, state) => {
    const put = vi.spyOn(env.API_CACHE, "put").mockRejectedValue(new Error("R2 unavailable"));
    try {
      for (let minute = 0; minute < 7; minute++) {
        const restored = new PresenceHistory(state.storage.sql, env.API_CACHE);
        restored.record(now + minute * MINUTE_MS, minute);
        await restored.publish(now + minute * MINUTE_MS).catch(() => {});
      }
      expect(put).toHaveBeenCalledTimes(3);
    } finally { put.mockRestore(); }
  });
});

it("serializes overlapping publications and keeps the newest checkpoint", async () => {
  await runInDurableObject(hub(), async (_, state) => {
    const history = new PresenceHistory(state.storage.sql, env.API_CACHE);
    const original = env.API_CACHE.put.bind(env.API_CACHE);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const put = vi.spyOn(env.API_CACHE, "put").mockImplementationOnce(async (...args) => {
      enter();
      await blocked;
      return original(...args);
    });
    try {
      history.record(now, 3);
      const first = history.publish(now);
      await entered;
      history.record(now + MINUTE_MS, 5);
      const second = history.publish(now + MINUTE_MS);
      release();
      await Promise.all([first, second]);
      expect((await loadHistory(env.API_CACHE))?.through).toBe(now + MINUTE_MS);
      expect(snapshotHistory(await loadHistory(env.API_CACHE), "24h", now + MINUTE_MS).points.map((point) => point.online)).toEqual([3, 5]);
    } finally { release(); put.mockRestore(); }
  });
});

it("rebuilds malformed snapshots from retained observations", async () => {
  await env.API_CACHE.put(HISTORY_KEY, '{"version":1,"through":0,"buckets":{}}');
  expect(await loadHistory(env.API_CACHE)).toBeNull();
  await runInDurableObject(hub(), async (_, state) => {
    const history = new PresenceHistory(state.storage.sql, env.API_CACHE);
    history.record(now, 4);
    await history.publish(now);
  });
  expect(snapshotHistory(await loadHistory(env.API_CACHE), "24h", now).points.at(-1)?.online).toBe(4);
});
