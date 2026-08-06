-- AIRS Agent - persistent migration ledger.
--
-- This file is NOT an application migration: it is the bootstrap object the
-- migration runner ensures before it inspects or applies anything, and the
-- first thing a fresh Docker database creates. It is owned by the migration /
-- database owner role and lives outside the `airs` tenant schema so migration
-- state can never be reached, written or replayed through application traffic.
--
-- Access model (enforced below):
--   airs_app          - no USAGE on the schema, no privilege on the table.
--   airs_maintenance  - no privilege at all (never writes migration state).
--   owner / migrator  - full control.

CREATE SCHEMA IF NOT EXISTS airs_migrations;

REVOKE ALL ON SCHEMA airs_migrations FROM PUBLIC;

CREATE TABLE IF NOT EXISTS airs_migrations.applied_migrations (
  version           text        PRIMARY KEY,
  filename          text        NOT NULL UNIQUE,
  checksum          text        NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  duration_ms       integer     NOT NULL DEFAULT 0,
  runner_version    text        NULL,
  app_release       text        NULL,
  adopted           boolean     NOT NULL DEFAULT false,
  CONSTRAINT applied_migrations_checksum_format CHECK (checksum ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE airs_migrations.applied_migrations IS
  'One row per successfully applied (or explicitly adopted) migration. Rows are immutable.';

-- Applied rows are immutable: no UPDATE, no DELETE, for anybody but a
-- superuser deliberately disabling the trigger.
CREATE OR REPLACE FUNCTION airs_migrations.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AIRS_LEDGER_IMMUTABLE: applied migration rows cannot be % (version %)',
    lower(TG_OP), COALESCE(OLD.version, NEW.version)
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS applied_migrations_immutable ON airs_migrations.applied_migrations;
CREATE TRIGGER applied_migrations_immutable
  BEFORE UPDATE OR DELETE ON airs_migrations.applied_migrations
  FOR EACH ROW EXECUTE FUNCTION airs_migrations.reject_mutation();

-- Raises when a migration is already recorded, so a runner that lost the race
-- for the advisory lock aborts its transaction instead of replaying SQL.
CREATE OR REPLACE FUNCTION airs_migrations.assert_pending(_version text, _checksum text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE existing text;
BEGIN
  SELECT checksum INTO existing
    FROM airs_migrations.applied_migrations WHERE version = _version;
  IF existing IS NULL THEN
    RETURN;
  END IF;
  IF existing IS DISTINCT FROM _checksum THEN
    RAISE EXCEPTION 'AIRS_MIGRATION_CHECKSUM_MISMATCH: migration % was applied with a different checksum', _version
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'AIRS_MIGRATION_ALREADY_APPLIED: migration % is already recorded', _version
    USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION airs_migrations.record_applied(
  _version text, _filename text, _checksum text,
  _duration_ms integer, _runner_version text DEFAULT NULL,
  _app_release text DEFAULT NULL, _adopted boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO airs_migrations.applied_migrations
    (version, filename, checksum, duration_ms, runner_version, app_release, adopted)
  VALUES (_version, _filename, _checksum, _duration_ms, _runner_version, _app_release, _adopted);
$$;

-- Hard denial for the application and maintenance planes.
REVOKE ALL ON ALL TABLES IN SCHEMA airs_migrations FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA airs_migrations FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_app') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA airs_migrations FROM airs_app';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA airs_migrations FROM airs_app';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA airs_migrations FROM airs_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_maintenance') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA airs_migrations FROM airs_maintenance';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA airs_migrations FROM airs_maintenance';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA airs_migrations FROM airs_maintenance';
  END IF;
END $$;