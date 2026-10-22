-- Daily counters reserve capacity before R2 writes. Failed uploads keep their reservations.
CREATE TABLE crash_days (
  day INTEGER PRIMARY KEY,
  salt TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  groups INTEGER NOT NULL DEFAULT 0,
  ips INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE crash_ips (
  day INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, ip_hash)
) WITHOUT ROWID;
CREATE TABLE crash_groups (
  day INTEGER NOT NULL,
  signature TEXT NOT NULL,
  version TEXT NOT NULL,
  cursor_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  latest_at INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, signature, version)
) WITHOUT ROWID;
ALTER TABLE crash_reports ADD COLUMN sample_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crash_reports ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 524288;
-- Preserve older reservations conservatively; their exact payload size is not in the old index.
UPDATE crash_reports SET sample_day = CAST(received_at / 86400000 AS INTEGER);
INSERT INTO crash_groups (day, signature, version, cursor_id, count, latest_at, samples)
  SELECT sample_day, signature, version, MIN(id), COUNT(*), MAX(received_at), COUNT(*)
  FROM crash_reports GROUP BY sample_day, signature, version;
INSERT INTO crash_days (day, salt, bytes, groups)
  SELECT day, lower(hex(randomblob(16))), samples * 524288, groups FROM
    (SELECT day, SUM(samples) AS samples, COUNT(*) AS groups FROM crash_groups GROUP BY day);
CREATE TRIGGER crash_ip_created AFTER INSERT ON crash_ips BEGIN
  UPDATE crash_days SET ips = ips + 1 WHERE day = NEW.day;
END;
CREATE TRIGGER crash_group_created AFTER INSERT ON crash_groups BEGIN
  UPDATE crash_days SET groups = groups + 1 WHERE day = NEW.day;
END;
CREATE TRIGGER crash_sample_created AFTER INSERT ON crash_reports BEGIN
  UPDATE crash_groups SET samples = samples + 1
    WHERE day = NEW.sample_day AND signature = NEW.signature AND version = NEW.version;
  UPDATE crash_days SET bytes = bytes + NEW.payload_bytes WHERE day = NEW.sample_day;
END;
