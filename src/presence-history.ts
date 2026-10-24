import { advanceHistory, historyStart, loadHistory, DAY_MS, HISTORY_KEY, MINUTE_MS, type HistorySnapshot, type PresenceSample } from "./history-snapshot";
import { count } from "./metrics";

const RETENTION_MS = 90 * DAY_MS;
const RETRY_MAX_MS = 60 * MINUTE_MS;
const MAX_FAILURES = Math.ceil(Math.log2(RETRY_MAX_MS / MINUTE_MS)) + 1;

/** Stores minute observations and incrementally publishes charts independently of public request traffic. */
export class PresenceHistory {
  private snapshot: HistorySnapshot | null | undefined;
  private publication: Promise<void> = Promise.resolve();

  constructor(private readonly sql: SqlStorage, private readonly bucket: R2Bucket, private readonly metrics?: AnalyticsEngineDataset) {
    sql.exec("CREATE TABLE IF NOT EXISTS presence_samples (at INTEGER PRIMARY KEY, online INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS presence_publication (id INTEGER PRIMARY KEY, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL)");
  }

  /** Keeps the first observation per minute, including zero; retries cannot add weight. */
  record(now: number, online: number): void {
    const at = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const insert = this.sql.exec("INSERT OR IGNORE INTO presence_samples (at, online) VALUES (?, ?)", at, online);
    const cleanup = this.sql.exec("DELETE FROM presence_samples WHERE at < ?", at - RETENTION_MS);
    count(this.metrics, "history_rows_written", insert.rowsWritten + cleanup.rowsWritten);
  }

  /** Serializes overlapping cron deliveries so an older publication cannot overwrite a newer checkpoint. */
  publish(now: number): Promise<void> {
    const publication = this.publication.then(() => this.update(now));
    this.publication = publication.catch(() => {});
    return publication;
  }

  /** Reads only new samples after a durable R2 checkpoint, including missed minutes after a failed upload. */
  private async update(now: number): Promise<void> {
    const retry = this.sql.exec<{ failures: number; retry_at: number }>("SELECT failures, retry_at FROM presence_publication WHERE id = 1").toArray()[0];
    if (retry && retry.retry_at > now) return;
    try {
      this.snapshot ??= await loadHistory(this.bucket);
      const through = Math.floor(now / MINUTE_MS) * MINUTE_MS;
      if (this.snapshot && this.snapshot.through >= through) return;
      const cursor = this.sql.exec<PresenceSample>(
        "SELECT at, online FROM presence_samples WHERE at > ? AND at <= ? ORDER BY at",
        Math.max(this.snapshot?.through ?? -Infinity, historyStart(through) - 1), through,
      );
      const samples = cursor.toArray();
      count(this.metrics, "history_rows_read", cursor.rowsRead);
      const next = advanceHistory(this.snapshot ?? null, samples, through);
      await this.bucket.put(HISTORY_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
      this.snapshot = next;
      if (retry) this.sql.exec("DELETE FROM presence_publication WHERE id = 1");
    } catch (error) {
      const failures = Math.min((retry?.failures ?? 0) + 1, MAX_FAILURES);
      this.sql.exec("INSERT OR REPLACE INTO presence_publication (id, failures, retry_at) VALUES (1, ?, ?)",
        failures, now + Math.min(RETRY_MAX_MS, MINUTE_MS * 2 ** (failures - 1)));
      throw error;
    }
  }
}
