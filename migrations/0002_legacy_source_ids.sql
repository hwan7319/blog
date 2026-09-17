-- Google Sheets generated duplicate VisitID and LogID values after row deletion.
-- Preserve their original source values separately while keeping legacy_* identifiers unique.
ALTER TABLE visits ADD COLUMN legacy_source_id TEXT;
ALTER TABLE audit_logs ADD COLUMN legacy_source_id TEXT;
CREATE INDEX visits_by_legacy_source_id ON visits(legacy_source_id);
CREATE INDEX audit_logs_by_legacy_source_id ON audit_logs(legacy_source_id);
