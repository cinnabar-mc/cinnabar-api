import type { Hub } from "./hub";
import type { HistoryRange, OnlineHistory } from "./presence-history";

/** Returns the shared presence and release hub. Sharding also needs global lookups and release fan-out. */
export function hubFor(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("global"), { locationHint: "weur" });
}

/** How long an isolate reuses the online count, so website traffic never reaches the hub per visitor. */
export const ONLINE_COUNT_TTL_MS = 30_000;

/** This isolate's latest count; concurrent requests share one hub call, and a failed call is not kept. */
let onlineCount: { at: number; value: Promise<number> } | undefined;

/** Returns the hub's online count, reused by this isolate for the time to live. */
export function cachedOnlineCount(env: Env): Promise<number> {
  const now = Date.now();
  const age = onlineCount ? now - onlineCount.at : -1;
  if (!onlineCount || age < 0 || age >= ONLINE_COUNT_TTL_MS) {
    const entry = { at: now, value: hubFor(env).onlineCount() };
    entry.value.catch(() => { if (onlineCount === entry) onlineCount = undefined; });
    onlineCount = entry;
  }
  return onlineCount.value;
}

const historyCache = new Map<HistoryRange, { at: number; value: Promise<OnlineHistory> }>();

/** Shares each range's read for one minute, including concurrent visitor requests. */
export function cachedOnlineHistory(env: Env, range: HistoryRange): Promise<OnlineHistory> {
  const now = Date.now();
  let entry = historyCache.get(range);
  if (!entry || now < entry.at || now - entry.at >= 60_000) {
    const next = { at: now, value: hubFor(env).onlineHistory(range) };
    next.value.catch(() => { if (historyCache.get(range) === next) historyCache.delete(range); });
    historyCache.set(range, next);
    entry = next;
  }
  return entry.value;
}
