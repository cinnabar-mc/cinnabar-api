const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RETENTION_MS = 90 * DAY_MS;

export const HISTORY_RANGES = {
  "24h": { duration: DAY_MS, interval: MINUTE_MS },
  "7d": { duration: 7 * DAY_MS, interval: 10 * MINUTE_MS },
  "30d": { duration: 30 * DAY_MS, interval: 60 * MINUTE_MS },
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

export interface OnlineHistory {
  range: HistoryRange;
  interval_ms: number;
  from: number;
  to: number;
  points: { at: number; online: number; peak: number; samples: number }[];
}

/** Stores anonymous minute samples and returns bounded, averaged chart buckets. */
export class PresenceHistory {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS presence_samples (at INTEGER PRIMARY KEY, online INTEGER NOT NULL)");
  }

  /** Keeps the first observation per minute, including zero; retries cannot add weight. */
  record(now: number, online: number): void {
    const at = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    this.sql.exec("INSERT OR IGNORE INTO presence_samples (at, online) VALUES (?, ?)", at, online);
    this.sql.exec("DELETE FROM presence_samples WHERE at < ?", at - RETENTION_MS);
  }

  /** Returns measured buckets only. A missing bucket is a gap, never an inferred zero. */
  read(now: number, range: HistoryRange): OnlineHistory {
    const { duration, interval } = HISTORY_RANGES[range];
    const to = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const from = Math.floor((to - duration) / interval) * interval;
    const points = this.sql.exec<OnlineHistory["points"][number]>(`
      SELECT CAST(at / ? AS INTEGER) * ? AS at, AVG(online) AS online,
             MAX(online) AS peak, COUNT(*) AS samples
      FROM presence_samples WHERE at >= ? AND at <= ? GROUP BY 1 ORDER BY 1
    `, interval, interval, from, to).toArray();
    return { range, interval_ms: interval, from, to, points };
  }
}
