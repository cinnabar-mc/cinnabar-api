-- Count all admitted reports, including reports without a payload sample.
ALTER TABLE crash_days ADD COLUMN reports INTEGER NOT NULL DEFAULT 0;
UPDATE crash_days SET reports = COALESCE(
  (SELECT SUM(count) FROM crash_groups WHERE crash_groups.day = crash_days.day), 0);

-- Update the daily total in the same transaction as the existing group reservation.
DROP TRIGGER crash_group_created;
CREATE TRIGGER crash_group_created AFTER INSERT ON crash_groups BEGIN
  UPDATE crash_days SET groups = groups + 1, reports = reports + NEW.count WHERE day = NEW.day;
END;
CREATE TRIGGER crash_group_counted AFTER UPDATE OF count ON crash_groups BEGIN
  UPDATE crash_days SET reports = reports + NEW.count - OLD.count WHERE day = NEW.day;
END;
