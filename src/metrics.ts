type Event = "admission_refused" | "authentication_failed" | "overload_closed" | "lookup"
  | "history_rows_read" | "history_rows_written" | "history_publish_failed" | "cache_failed";

/** Records only fixed labels and counts; telemetry failures never affect application behavior. */
export function count(metrics: AnalyticsEngineDataset | undefined, event: Event, value = 1): void {
  if (value === 0) return;
  try { metrics?.writeDataPoint({ blobs: [event], doubles: [value] }); } catch { /* Drop unavailable telemetry. */ }
}
