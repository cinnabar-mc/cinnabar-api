-- Seek through stored reports in listing order without sorting the retained samples.
CREATE INDEX crash_reports_listing ON crash_reports(stored, received_at, id);

-- Restrict daily group aggregation to rows inside the retention window.
CREATE INDEX crash_groups_latest ON crash_groups(latest_at);
