-- One index row per report. Retries reuse the same random report id.
CREATE TABLE crash_reports (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  gpu TEXT NOT NULL,
  backend TEXT NOT NULL,
  stored INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX crash_reports_retention ON crash_reports(received_at);
CREATE INDEX crash_reports_groups ON crash_reports(stored, signature, version, os, gpu, backend);
