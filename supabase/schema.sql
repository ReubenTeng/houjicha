-- Fresh backend-only schema. No SQLite import or existing-data migration.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('orchestration'), 913837);
CREATE SCHEMA IF NOT EXISTS orchestration;
REVOKE ALL ON SCHEMA orchestration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS orchestration.groups (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration.commands (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration.authorization_bindings (
  authorization_id text PRIMARY KEY,
  group_id text NOT NULL,
  user_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration.events (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text UNIQUE NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_recipients_idx ON orchestration.events USING gin ((body->'recipients'));

REVOKE ALL ON ALL TABLES IN SCHEMA orchestration FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA orchestration FROM PUBLIC;
ALTER TABLE orchestration.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.authorization_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.events ENABLE ROW LEVEL SECURITY;
COMMIT;
