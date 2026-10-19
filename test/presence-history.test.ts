import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { Hub } from "../src/hub";
import { PresenceHistory, type OnlineHistory } from "../src/presence-history";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const open: Client[] = [];
beforeEach(async () => {
  installFakeIssuer();
  await runInDurableObject(hub(), (_, state) => state.storage.sql.exec("DELETE FROM presence_samples").toArray());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((client) => (client.close(), client.closed)));
});

it("persists the first minute observation across hibernation, including zero and gaps", async () => {
  await runInDurableObject(hub(), (_, state) => {
    const history = new PresenceHistory(state.storage.sql);
    const now = 200 * DAY;
    history.record(now, 0);
    history.record(now + 1, 999);
    history.record(now + 2 * MINUTE, 7);
    expect(new PresenceHistory(state.storage.sql).read(now + 2 * MINUTE, "24h").points).toEqual([
      { at: now, online: 0, peak: 0, samples: 1 },
      { at: now + 2 * MINUTE, online: 7, peak: 7, samples: 1 },
    ]);
    history.record(now + 90 * DAY, 3);
    expect(state.storage.sql.exec("SELECT at FROM presence_samples WHERE at = ?", now).toArray()).toHaveLength(1);
    history.record(now + 90 * DAY + MINUTE, 4);
    expect(state.storage.sql.exec("SELECT at FROM presence_samples WHERE at = ?", now).toArray()).toHaveLength(0);
  });
});

it("averages observed minutes and retains peaks without filling missing buckets", async () => {
  await runInDurableObject(hub(), (_, state) => {
    const history = new PresenceHistory(state.storage.sql);
    const now = 200 * DAY;
    history.record(now - 8 * DAY, 999);
    history.record(now, 0);
    history.record(now + MINUTE, 10);
    history.record(now + 20 * MINUTE, 3);
    const result = history.read(now + 20 * MINUTE, "7d");
    expect(result.interval_ms).toBe(10 * MINUTE);
    expect(result.points).toEqual([
      { at: now, online: 5, peak: 10, samples: 2 },
      { at: now + 20 * MINUTE, online: 3, peak: 3, samples: 1 },
    ]);
    expect(history.read(now + 20 * MINUTE, "30d").points.at(-1)).toEqual({
      at: now, online: 13 / 3, peak: 10, samples: 3,
    });
  });
});

it("cron collects unique, visible, fresh accounts without a website request", async () => {
  for (const options of [{ xuid: "101" }, { xuid: "101" }, { xuid: "102", visible: false }]) {
    open.push((await login(options)).client);
  }
  const now = Math.ceil(Date.now() / MINUTE) * MINUTE;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await worker.scheduled(createScheduledController({ scheduledTime: now - DAY }), env);
  await runInDurableObject(hub(), (instance: Hub, state) => {
    expect(new Hub(state, env).onlineHistory("24h").points).toEqual([
      { at: now, online: 1, peak: 1, samples: 1 },
    ]);
    // The same clock drives freshness and the recorded timestamp.
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * MINUTE);
    instance.recordOnlineCount();
    expect(instance.onlineHistory("24h").points.at(-1)?.online).toBe(0);
  });
});

it("serves bounded public history and rejects unsupported ranges", async () => {
  for (const range of ["24h", "7d", "30d"]) {
    const response = await exports.default.fetch(`https://api.test/v1/presence/history?range=${range}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = await response.json() as OnlineHistory;
    expect(body.range).toBe(range);
    expect(body.points.length).toBeLessThanOrEqual(1441);
  }
  for (const range of ["__proto__", "constructor", "1y", ""]) {
    const response = await exports.default.fetch(`https://api.test/v1/presence/history?range=${range}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  }
  const response = await exports.default.fetch("https://api.test/v1/presence/history");
  expect((await response.json() as OnlineHistory).range).toBe("24h");
});
