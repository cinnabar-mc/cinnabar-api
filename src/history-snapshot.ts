export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const HISTORY_RANGES = {
  "24h": { duration: DAY_MS, interval: MINUTE_MS },
  "7d": { duration: 7 * DAY_MS, interval: 10 * MINUTE_MS },
  "30d": { duration: 30 * DAY_MS, interval: 60 * MINUTE_MS },
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
export const DEFAULT_HISTORY_RANGE: HistoryRange = "24h";
const ranges = Object.keys(HISTORY_RANGES) as HistoryRange[];
export const HISTORY_KEY = "presence/history-v1.json";
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export interface OnlineHistory {
  range: HistoryRange;
  interval_ms: number;
  from: number;
  to: number;
  points: { at: number; online: number; peak: number; samples: number }[];
}

interface Bucket { at: number; total: number; peak: number; samples: number }
export interface HistorySnapshot {
  version: 1;
  through: number;
  buckets: Record<HistoryRange, Bucket[]>;
}
export type PresenceSample = { at: number; online: number };

/** Returns the oldest bucket boundary needed to preserve every supported chart window. */
export function historyStart(now: number): number {
  return Math.min(...ranges.map((range) => {
    const { duration, interval } = HISTORY_RANGES[range];
    return Math.floor((now - duration) / interval) * interval;
  }));
}

/** Adds only unpublished minute samples, preserving exact sums, peaks, gaps and partial buckets. */
export function advanceHistory(previous: HistorySnapshot | null, samples: readonly PresenceSample[], now: number): HistorySnapshot {
  const through = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const buckets = Object.fromEntries(ranges.map((range) => {
    const { duration, interval } = HISTORY_RANGES[range];
    const from = Math.floor((through - duration) / interval) * interval;
    const points = (previous?.buckets[range] ?? []).filter((point) => point.at >= from).map((point) => ({ ...point }));
    for (const sample of samples) {
      if (sample.at < from || sample.at > through || sample.at <= (previous?.through ?? -Infinity)) continue;
      const at = Math.floor(sample.at / interval) * interval;
      let point = points.at(-1);
      if (!point || point.at !== at) {
        point = { at, total: 0, peak: 0, samples: 0 };
        points.push(point);
      }
      point.total += sample.online;
      point.peak = Math.max(point.peak, sample.online);
      point.samples++;
    }
    return [range, points];
  })) as HistorySnapshot["buckets"];
  return { version: 1, through, buckets };
}

/** Projects a published snapshot without querying SQL or inventing observations during an outage. */
export function snapshotHistory(snapshot: HistorySnapshot | null, range: HistoryRange, now: number): OnlineHistory {
  const { duration, interval } = HISTORY_RANGES[range];
  const to = Math.min(Math.floor(now / MINUTE_MS) * MINUTE_MS, snapshot?.through ?? Infinity);
  const from = Math.floor((to - duration) / interval) * interval;
  const points = (snapshot?.buckets[range] ?? []).filter((point) => point.at >= from && point.at <= to)
    .map(({ at, total, peak, samples }) => ({ at, online: total / samples, peak, samples }));
  return { range, interval_ms: interval, from, to, points };
}

/** Loads a bounded, validated checkpoint; missing or malformed checkpoints are rebuilt by the publisher. */
export async function loadHistory(bucket: R2Bucket): Promise<HistorySnapshot | null> {
  const object = await bucket.get(HISTORY_KEY);
  if (!object) return null;
  if (object.size > MAX_SNAPSHOT_BYTES) { await object.body.cancel(); return null; }
  const value: unknown = await object.json().catch(() => null);
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<HistorySnapshot>;
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.through) || snapshot.through! % MINUTE_MS !== 0 || !snapshot.buckets) return null;
  for (const range of ranges) {
    const points = snapshot.buckets[range];
    const { duration, interval } = HISTORY_RANGES[range];
    if (!Array.isArray(points) || points.length > Math.ceil(duration / interval) + 1) return null;
    let previous = -Infinity;
    for (const point of points) {
      if (!point || ![point.at, point.total, point.peak, point.samples].every(Number.isSafeInteger)
        || point.at % interval !== 0 || point.at <= previous || point.at > snapshot.through!
        || point.samples < 1 || point.samples > interval / MINUTE_MS || point.peak < 0
        || point.total < point.peak || point.total > point.peak * point.samples) return null;
      previous = point.at;
    }
  }
  return snapshot as HistorySnapshot;
}
