-- AIRS Agent — incident expiration maintenance proof (Stage 5B).
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/incident_expiration.sql
--
-- Proves, against a real cluster:
--   * only the dedicated maintenance role may invoke the routine
--   * the sweep expires exactly what is overdue and nothing else
--   * it never grants access, only removes it
--   * a second identical run changes nothing (idempotence)
--   * every run leaves a maintenance audit record
--   * audit metadata cannot carry a secret
--
-- Everything runs inside one transaction and is rolled back.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPIRATION FAIL: %', label; END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.denied(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ok  % (rejected: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'EXPIRATION FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE xids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON xids TO airs_app, airs_maintenance;

-- ---------------------------------------------------------------------------
-- Fixtures (owner role). Overdue rows AND control rows that must be untouched.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  -- one partner org per participant row: (incident_id, partner_org_id) is unique
  org_c uuid := gen_random_uuid();
  org_d uuid := gen_random_uuid();
  org_e uuid := gen_random_uuid();
  room_due uuid; room_live uuid; room_ret uuid;
  p_inv_due uuid; p_inv_future uuid; p_act_due uuid; p_act_live uuid; p_declined uuid;
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type) VALUES
    (org_c, 'exp-test-agency-c', 'Expiration Test Agency C', 'law_enforcement'),
    (org_d, 'exp-test-agency-d', 'Expiration Test Agency D', 'fire'),
    (org_e, 'exp-test-agency-e', 'Expiration Test Agency E', 'ems');

  -- Room whose scheduled window has elapsed.
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, scheduled_expires_at)
       VALUES (org_a, 'EXP overdue room', 'critical_incident', 'active', now() - interval '1 hour')
    RETURNING id INTO room_due;

  -- Room with no scheduled expiration: must stay active.
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'EXP live room', 'critical_incident', 'active')
    RETURNING id INTO room_live;

  -- Closed room whose temporary-data retention window has elapsed.
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, closed_at,
                                   temp_data_expires_at)
       VALUES (org_a, 'EXP retention room', 'training', 'closed', now() - interval '3 days',
               now() - interval '1 hour')
    RETURNING id INTO room_ret;

  -- Overdue pending invitation.
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval, invitation_expires_at,
        token_hash)
       VALUES (room_live, org_a, org_b, org_a, 'operational', 'pending', 'invited', true,
               now() - interval '10 minutes', 'exp-test-hash-1')
    RETURNING id INTO p_inv_due;

  -- Pending invitation still inside its window: must remain pending.
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval, invitation_expires_at,
        token_hash)
       VALUES (room_live, org_a, org_c, org_a, 'view_only', 'pending', 'invited', true,
               now() + interval '2 days', 'exp-test-hash-2')
    RETURNING id INTO p_inv_future;

  -- Active participation past its own expires_at.
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at, expires_at, token_hash)
       VALUES (room_live, org_a, org_d, org_a, 'operational', 'accepted', 'active', false,
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
               now() - interval '5 minutes', 'exp-test-hash-3')
    RETURNING id INTO p_act_due;

  -- Active participation with a future expiry: must remain active.
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at, expires_at, token_hash)
       VALUES (room_due, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
               now() + interval '2 days', 'exp-test-hash-4')
    RETURNING id INTO p_act_live;

  -- Already-declined row: a terminal state the sweep must not rewrite.
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval, invitation_expires_at)
       VALUES (room_live, org_a, org_e, org_a, 'view_only', 'declined', 'declined', true,
               now() - interval '3 days')
    RETURNING id INTO p_declined;

  INSERT INTO xids VALUES
    ('org_a', org_a), ('org_b', org_b), ('org_c', org_c), ('org_d', org_d), ('org_e', org_e),
    ('room_due', room_due), ('room_live', room_live), ('room_ret', room_ret),
    ('p_inv_due', p_inv_due), ('p_inv_future', p_inv_future),
    ('p_act_due', p_act_due), ('p_act_live', p_act_live), ('p_declined', p_declined);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Authorization — the application role must not be able to run maintenance.
-- ---------------------------------------------------------------------------
SET ROLE airs_app;

SELECT pg_temp.ok(NOT has_function_privilege('airs_app', 'airs.expire_incident_state()', 'EXECUTE'),
                  'airs_app has no EXECUTE on airs.expire_incident_state()');
SELECT pg_temp.ok(NOT has_function_privilege('airs_app', 'airs.run_incident_expiration(uuid)', 'EXECUTE'),
                  'airs_app has no EXECUTE on airs.run_incident_expiration()');
SELECT pg_temp.ok(NOT has_function_privilege('airs_app',
                    'airs.record_maintenance_event(uuid,text,text,jsonb,int)', 'EXECUTE'),
                  'airs_app has no EXECUTE on airs.record_maintenance_event()');
SELECT pg_temp.ok(NOT has_table_privilege('airs_app', 'airs.maintenance_events', 'SELECT'),
                  'airs_app cannot read the maintenance audit trail');
SELECT pg_temp.ok(NOT has_table_privilege('airs_app', 'airs.maintenance_events', 'INSERT'),
                  'airs_app cannot write the maintenance audit trail');
SELECT pg_temp.denied('SELECT airs.expire_incident_state()',
                      'airs_app calling the sweep is rejected');
SELECT pg_temp.denied('SELECT airs.run_incident_expiration(gen_random_uuid())',
                      'airs_app calling the maintenance entry point is rejected');
SELECT pg_temp.denied('SELECT * FROM airs.maintenance_events',
                      'airs_app selecting maintenance events is rejected');
RESET ROLE;

SELECT pg_temp.ok(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole,
                  'airs_maintenance is not superuser and cannot bypass RLS')
  FROM pg_roles WHERE rolname = 'airs_maintenance';
SELECT pg_temp.ok(count(*) = 0, 'airs_maintenance holds no privilege on any tenant table')
  FROM information_schema.role_table_grants
 WHERE grantee = 'airs_maintenance' AND table_schema = 'airs'
   AND table_name <> 'maintenance_events';
SELECT pg_temp.ok(has_function_privilege('airs_maintenance', 'airs.run_incident_expiration(uuid)', 'EXECUTE'),
                  'airs_maintenance may execute the maintenance entry point');

-- ---------------------------------------------------------------------------
-- 2. First sweep, executed as the maintenance role.
-- ---------------------------------------------------------------------------
SET ROLE airs_maintenance;

CREATE TEMP TABLE run1 AS
  SELECT * FROM airs.run_incident_expiration('aaaaaaaa-0000-4000-8000-000000000001');

SELECT pg_temp.ok((SELECT ran FROM run1), 'first run executed');
SELECT pg_temp.ok(NOT (SELECT skipped_locked FROM run1), 'first run was not lock-skipped');
SELECT pg_temp.ok((SELECT duration_ms FROM run1) >= 0, 'first run reports a duration');
SELECT pg_temp.ok((SELECT expired_invitations FROM run1) >= 1, 'overdue invitations counted');
SELECT pg_temp.ok((SELECT expired_participations FROM run1) >= 1, 'overdue participations counted');
SELECT pg_temp.ok((SELECT expired_rooms FROM run1) >= 1, 'elapsed rooms counted');
SELECT pg_temp.ok((SELECT purged_rooms FROM run1) >= 1, 'retention-elapsed rooms counted');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM airs.maintenance_events
                           WHERE execution_id = 'aaaaaaaa-0000-4000-8000-000000000001'
                             AND action = 'maintenance.expiration_completed' AND outcome = 'ok'),
                  'first run recorded a maintenance completion event');

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3. Effects — exactly the overdue rows, and only in the removing direction.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ok(invitation_status = 'expired' AND participation_status = 'expired'
                  AND token_hash IS NULL, 'overdue invitation expired and token cleared')
  FROM airs.incident_participants WHERE id = (SELECT v FROM xids WHERE k='p_inv_due');

SELECT pg_temp.ok(invitation_status = 'pending' AND participation_status = 'invited',
                  'in-window invitation untouched')
  FROM airs.incident_participants WHERE id = (SELECT v FROM xids WHERE k='p_inv_future');

SELECT pg_temp.ok(participation_status = 'expired' AND token_hash IS NULL
                  AND revoked_at IS NOT NULL, 'overdue participation expired and token cleared')
  FROM airs.incident_participants WHERE id = (SELECT v FROM xids WHERE k='p_act_due');

SELECT pg_temp.ok(participation_status = 'revoked',
                  'participant of the elapsed room lost access with the room')
  FROM airs.incident_participants WHERE id = (SELECT v FROM xids WHERE k='p_act_live');

SELECT pg_temp.ok(invitation_status = 'declined' AND participation_status = 'declined',
                  'terminal declined row not rewritten')
  FROM airs.incident_participants WHERE id = (SELECT v FROM xids WHERE k='p_declined');

SELECT pg_temp.ok(status = 'closed' AND closed_at IS NOT NULL AND closure_reason IS NOT NULL
                  AND temp_data_expires_at IS NOT NULL, 'elapsed room closed with retention set')
  FROM airs.incident_rooms WHERE id = (SELECT v FROM xids WHERE k='room_due');

SELECT pg_temp.ok(status = 'active' AND closed_at IS NULL, 'room without a window stays active')
  FROM airs.incident_rooms WHERE id = (SELECT v FROM xids WHERE k='room_live');

SELECT pg_temp.ok(data_expired_at IS NOT NULL, 'retention-elapsed room marked')
  FROM airs.incident_rooms WHERE id = (SELECT v FROM xids WHERE k='room_ret');

-- No escalation: the sweep may never move anything into an access-granting state.
SELECT pg_temp.ok(count(*) = 0, 'sweep granted no new access')
  FROM airs.incident_participants
 WHERE id IN (SELECT v FROM xids WHERE k LIKE 'p_%')
   AND participation_status IN ('active','restricted','incident_command')
   AND id <> (SELECT v FROM xids WHERE k='p_inv_future');
SELECT pg_temp.ok(count(*) = 0, 'sweep created no incident room')
  FROM airs.incident_rooms WHERE org_id = (SELECT v FROM xids WHERE k='org_a')
   AND id NOT IN (SELECT v FROM xids WHERE k LIKE 'room_%') AND name LIKE 'EXP %';

-- Tenant audit coverage for each change.
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM airs.audit_events
                           WHERE action = 'incident.invitation_expired'
                             AND resource_id::text = (SELECT v::text FROM xids WHERE k='room_live')),
                  'invitation expiry audited in the tenant log');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM airs.audit_events
                           WHERE action = 'incident.closed'
                             AND resource_id::text = (SELECT v::text FROM xids WHERE k='room_due')
                             AND detail->>'cause' = 'scheduled_expiration'),
                  'scheduled closure audited in the tenant log');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM airs.audit_events
                           WHERE action = 'incident.temp_data_expired'
                             AND resource_id::text = (SELECT v::text FROM xids WHERE k='room_ret')),
                  'retention expiry audited in the tenant log');

-- ---------------------------------------------------------------------------
-- 4. Idempotence — a second identical run must change nothing.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE snap AS
  SELECT id, status, closed_at, data_expired_at, version FROM airs.incident_rooms;
CREATE TEMP TABLE snap_p AS
  SELECT id, invitation_status, participation_status, revoked_at FROM airs.incident_participants;
CREATE TEMP TABLE snap_a AS SELECT count(*) AS n FROM airs.audit_events;

SET ROLE airs_maintenance;
CREATE TEMP TABLE run2 AS
  SELECT * FROM airs.run_incident_expiration('aaaaaaaa-0000-4000-8000-000000000002');
RESET ROLE;

SELECT pg_temp.ok((SELECT expired_invitations + expired_participations + expired_rooms
                        + purged_rooms FROM run2) = 0, 'second run changed nothing');
SELECT pg_temp.ok(count(*) = 0, 'no incident room differs after the second run')
  FROM (SELECT id, status, closed_at, data_expired_at, version FROM airs.incident_rooms
        EXCEPT SELECT id, status, closed_at, data_expired_at, version FROM snap) d;
SELECT pg_temp.ok(count(*) = 0, 'no participant differs after the second run')
  FROM (SELECT id, invitation_status, participation_status, revoked_at
          FROM airs.incident_participants
        EXCEPT SELECT id, invitation_status, participation_status, revoked_at FROM snap_p) d;
SELECT pg_temp.ok((SELECT count(*) FROM airs.audit_events) = (SELECT n FROM snap_a),
                  'second run wrote no duplicate tenant audit rows');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM airs.maintenance_events
                           WHERE execution_id = 'aaaaaaaa-0000-4000-8000-000000000002'
                             AND action = 'maintenance.expiration_completed'),
                  'second run is still recorded as a maintenance execution');

-- ---------------------------------------------------------------------------
-- 5. Maintenance audit trail integrity.
-- ---------------------------------------------------------------------------
SET ROLE airs_maintenance;

SELECT pg_temp.ok(airs.record_maintenance_event(
         'aaaaaaaa-0000-4000-8000-000000000003', 'maintenance.expiration_failed', 'error',
         jsonb_build_object('error_class','database','secret','hunter2',
                            'authorization','Bearer abc','runner','cli')) > 0,
       'failure events can be recorded');
SELECT pg_temp.ok(detail ? 'error_class' AND detail ? 'runner'
                  AND NOT (detail ? 'secret') AND NOT (detail ? 'authorization'),
                  'sensitive keys are stripped from maintenance metadata')
  FROM airs.maintenance_events WHERE execution_id = 'aaaaaaaa-0000-4000-8000-000000000003';

SELECT pg_temp.denied($$SELECT airs.record_maintenance_event(
         'aaaaaaaa-0000-4000-8000-000000000004', 'maintenance.something_else', 'ok')$$,
       'unknown maintenance action rejected');
SELECT pg_temp.denied($$SELECT airs.record_maintenance_event(
         'aaaaaaaa-0000-4000-8000-000000000004', 'maintenance.expiration_completed', 'fine')$$,
       'unknown maintenance outcome rejected');
SELECT pg_temp.denied($$UPDATE airs.maintenance_events SET outcome = 'ok'$$,
       'maintenance audit rows cannot be updated');
SELECT pg_temp.denied($$DELETE FROM airs.maintenance_events$$,
       'maintenance audit rows cannot be deleted');

SELECT pg_temp.ok(last_success_at IS NOT NULL AND last_failure_at IS NOT NULL,
                  'status view reports last success and last failure')
  FROM airs.maintenance_expiration_status();

RESET ROLE;

ROLLBACK;
