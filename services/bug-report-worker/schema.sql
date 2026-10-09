PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bug_reports (
  report_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  received_day TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_reports_expiry ON bug_reports(expires_at, report_id);
CREATE INDEX IF NOT EXISTS bug_reports_day ON bug_reports(received_day, report_id);

CREATE TABLE IF NOT EXISTS bug_report_daily_salts (
  day TEXT PRIMARY KEY,
  salt BLOB NOT NULL CHECK (length(salt) = 32),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_report_daily_salts_age ON bug_report_daily_salts(created_at);

CREATE TABLE IF NOT EXISTS bug_report_source_counts (
  source_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 20),
  PRIMARY KEY (source_hash, window_start)
);
CREATE INDEX IF NOT EXISTS bug_report_source_counts_age ON bug_report_source_counts(window_start);

CREATE TABLE IF NOT EXISTS bug_report_request_counts (
  day TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_report_request_count_age ON bug_report_request_counts(created_at, day);

CREATE TABLE IF NOT EXISTS bug_report_admissions (
  admission_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  day TEXT NOT NULL,
  admitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_report_admissions_age ON bug_report_admissions(admitted_at, admission_id);

CREATE TRIGGER IF NOT EXISTS bug_report_admission_guard
BEFORE INSERT ON bug_report_admissions
WHEN COALESCE((SELECT attempts FROM bug_report_source_counts WHERE source_hash = NEW.source_hash AND window_start = NEW.window_start), 0) >= 20
  OR COALESCE((SELECT attempts FROM bug_report_request_counts WHERE day = NEW.day), 0) >= 2000
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS bug_report_admission_count
AFTER INSERT ON bug_report_admissions
BEGIN
  INSERT INTO bug_report_source_counts(source_hash, window_start, attempts) VALUES (NEW.source_hash, NEW.window_start, 1)
  ON CONFLICT(source_hash, window_start) DO UPDATE SET attempts = attempts + 1;
  INSERT INTO bug_report_request_counts(day, attempts, created_at) VALUES (NEW.day, 1, NEW.admitted_at)
  ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1, created_at = NEW.admitted_at;
END;

CREATE TRIGGER IF NOT EXISTS bug_report_new_daily_guard
BEFORE INSERT ON bug_reports
WHEN NOT EXISTS (SELECT 1 FROM bug_reports WHERE report_id = NEW.report_id)
  AND (SELECT COUNT(*) FROM bug_reports WHERE received_day = NEW.received_day) >= 200
BEGIN
  SELECT RAISE(IGNORE);
END;
