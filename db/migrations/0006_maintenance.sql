-- AIRS Agent — 0006: incident expiration maintenance plane.
--
-- Stage 5B. This migration does NOT change incident lifecycle rules. It adds
-- the least-privileged operational path that invokes the Stage 5 routine
-- `airs.expire_incident_state()`:
--
--   * a dedicated `airs_maintenance` role (NOSUPERUSER, NOBYPASSRLS)
--   * a non-tenant maintenance audit table
--   * two narrow SECURITY DEFINER entry points, executable ONLY by that role
--   * removal of maintenance privilege from the ordinary application role
--
-- After this migration `airs_app` — the role that serves every browser request
-- — can no longer execute the expiration routine at all.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Dedicated maintenance role
--
-- LOGIN so an external scheduler can connect directly. No password is set
-- here: the operator assigns one (or uses peer / IAM authentication) so no
-- credential ever lives in the repository. Explicitly not a superuser and
-- explicitly not BYPASSRLS — the sweep needs neither.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_maintenance') THEN
    CREATE ROLE airs_maintenance LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
                                 NOREPLICATION INHERIT;
  ELSE
    ALTER ROLE airs_maintenance NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

COMMENT ON ROLE airs_maintenance IS
  'Scheduled maintenance only. May execute airs.run_incident_expiration() and '
  'airs.record_maintenance_event(); has no privilege on any tenant table.';

GRANT USAGE ON SCHEMA airs TO airs_maintenance;

-- ---------------------------------------------------------------------------
-- 2. Maintenance audit trail
--
-- Deliberately separate from airs.audit_events: that table is tenant-scoped
-- (org_id NOT NULL) and a maintenance run belongs to no tenant. Keeping the
-- planes apart means the maintenance role needs no privilege whatsoever on
-- the tenant audit log, and tenant reads can never surface operator activity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS airs.maintenance_events (
  id            bigserial PRIMARY KEY,
  execution_id  uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('maintenance.expiration_started',
                                                'maintenance.expiration_completed',
                                                'maintenance.expiration_failed')),
  outcome       text NOT NULL CHECK (outcome IN ('ok','skipped','error')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms   int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_events_time_idx
  ON airs.maintenance_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_events_execution_idx
  ON airs.maintenance_events (execution_id);

ALTER TABLE airs.maintenance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.maintenance_events FORCE ROW LEVEL SECURITY;

-- Table privileges are the gate: only airs_maintenance and the definer owner
-- hold any. The policies exist so FORCE RLS does not block those two.
DROP POLICY IF EXISTS maintenance_events_write ON airs.maintenance_events;
CREATE POLICY maintenance_events_write ON airs.maintenance_events FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS maintenance_events_read ON airs.maintenance_events;
CREATE POLICY maintenance_events_read ON airs.maintenance_events FOR SELECT USING (true);
-- No UPDATE or DELETE policy: maintenance history is append-only.

GRANT SELECT, INSERT ON airs.maintenance_events TO airs_maintenance;
GRANT USAGE, SELECT ON SEQUENCE airs.maintenance_events_id_seq TO airs_maintenance;
-- airs_app is granted nothing here, so the app cannot read or write this table.

-- ---------------------------------------------------------------------------
-- 3. Detail sanitiser
--
-- Defence in depth against a caller passing something sensitive into audit
-- metadata. Static key list, no dynamic SQL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.strip_sensitive_detail(p_detail jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = airs, pg_catalog AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(k, v)
       FROM jsonb_each(coalesce(p_detail, '{}'::jsonb)) AS e(k, v)
      WHERE lower(k) NOT IN ('password','secret','token','token_hash','authorization',
                             'apikey','api_key','credential','session','cookie',
                             'database_url','dsn','narrative')),
    '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- 4. Maintenance event recorder
--
-- Called by the runner outside the sweep transaction so a failure can still be
-- recorded after a rollback. Validates every input; no dynamic SQL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.record_maintenance_event(
  p_execution_id uuid,
  p_action       text,
  p_outcome      text,
  p_detail       jsonb DEFAULT '{}'::jsonb,
  p_duration_ms  int   DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE new_id bigint;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'execution_id is required';
  END IF;
  IF p_action NOT IN ('maintenance.expiration_started',
                      'maintenance.expiration_completed',
                      'maintenance.expiration_failed') THEN
    RAISE EXCEPTION 'unknown maintenance action';
  END IF;
  IF p_outcome NOT IN ('ok','skipped','error') THEN
    RAISE EXCEPTION 'unknown maintenance outcome';
  END IF;

  INSERT INTO airs.maintenance_events (execution_id, action, outcome, detail, duration_ms)
       VALUES (p_execution_id, p_action, p_outcome,
               airs.strip_sensitive_detail(p_detail),
               greatest(coalesce(p_duration_ms, 0), 0))
    RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION airs.record_maintenance_event(uuid, text, text, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.record_maintenance_event(uuid, text, text, jsonb, int)
  TO airs_maintenance;

-- ---------------------------------------------------------------------------
-- 5. Production maintenance entry point
--
-- One transaction: take a narrowly scoped transaction-level advisory lock,
-- run the unchanged Stage 5 sweep, record the completion event. A second
-- concurrent runner fails the lock and returns skipped_locked = true instead
-- of repeating the state transitions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.run_incident_expiration(p_execution_id uuid)
RETURNS TABLE (execution_id uuid, ran boolean, skipped_locked boolean,
               expired_invitations int, expired_participations int,
               expired_rooms int, purged_rooms int,
               started_at timestamptz, completed_at timestamptz, duration_ms int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  t1 timestamptz;
  sweep record;
  ms int;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'execution_id is required';
  END IF;

  IF NOT pg_try_advisory_xact_lock(8421701) THEN
    t1 := clock_timestamp();
    ms := (extract(epoch FROM (t1 - t0)) * 1000)::int;
    PERFORM airs.record_maintenance_event(
      p_execution_id, 'maintenance.expiration_completed', 'skipped',
      jsonb_build_object('reason', 'another_run_in_progress'), ms);
    RETURN QUERY SELECT p_execution_id, false, true, 0, 0, 0, 0, t0, t1, ms;
    RETURN;
  END IF;

  SELECT * INTO sweep FROM airs.expire_incident_state();

  t1 := clock_timestamp();
  ms := (extract(epoch FROM (t1 - t0)) * 1000)::int;

  PERFORM airs.record_maintenance_event(
    p_execution_id, 'maintenance.expiration_completed', 'ok',
    jsonb_build_object('expired_invitations',   sweep.expired_invitations,
                       'expired_participations', sweep.expired_participations,
                       'expired_rooms',          sweep.expired_rooms,
                       'purged_rooms',           sweep.purged_rooms), ms);

  RETURN QUERY SELECT p_execution_id, true, false,
                      sweep.expired_invitations, sweep.expired_participations,
                      sweep.expired_rooms, sweep.purged_rooms, t0, t1, ms;
END $$;

REVOKE ALL ON FUNCTION airs.run_incident_expiration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.run_incident_expiration(uuid) TO airs_maintenance;

-- ---------------------------------------------------------------------------
-- 6. Read-only status view for a System Auditor surface
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.maintenance_expiration_status()
RETURNS TABLE (last_success_at timestamptz, last_success_duration_ms int,
               last_success_detail jsonb, last_failure_at timestamptz,
               last_failure_detail jsonb, runs_last_24h int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  SELECT
    (SELECT occurred_at FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_completed' AND outcome = 'ok'
      ORDER BY occurred_at DESC LIMIT 1),
    (SELECT duration_ms FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_completed' AND outcome = 'ok'
      ORDER BY occurred_at DESC LIMIT 1),
    (SELECT detail FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_completed' AND outcome = 'ok'
      ORDER BY occurred_at DESC LIMIT 1),
    (SELECT occurred_at FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_failed'
      ORDER BY occurred_at DESC LIMIT 1),
    (SELECT detail FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_failed'
      ORDER BY occurred_at DESC LIMIT 1),
    (SELECT count(*)::int FROM airs.maintenance_events
      WHERE action = 'maintenance.expiration_started'
        AND occurred_at > now() - interval '24 hours')
$$;

REVOKE ALL ON FUNCTION airs.maintenance_expiration_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.maintenance_expiration_status() TO airs_maintenance;

-- ---------------------------------------------------------------------------
-- 7. Remove maintenance privilege from the application role
--
-- Stage 5 granted airs_app EXECUTE on the sweep. Ordinary application traffic
-- must not be able to trigger cross-tenant state changes, so that grant is
-- withdrawn here. The sweep is now reachable only through airs_maintenance.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION airs.expire_incident_state() FROM airs_app;
REVOKE ALL ON FUNCTION airs.expire_incident_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.expire_incident_state() TO airs_maintenance;

COMMIT;
