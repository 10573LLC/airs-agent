-- AIRS Agent — time-based expiration proof.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/expiration.sql
--
-- Proves that airs.expire_incident_state():
--   * expires overdue invitations and participations,
--   * closes rooms whose scheduled window elapsed and revokes their partners,
--   * marks temporary operational data as expired past its retention window,
--   * writes an audit row for every change it makes,
--   * never grants access and never touches rows that are not yet due,
--   * is idempotent on a second immediate run.
--
-- Everything is rolled back; no rows are left behind.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'EXPIRATION FAIL: %', label; END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

BEGIN;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  due_room    uuid;   -- scheduled window already elapsed
  future_room uuid;   -- scheduled window still open
  retain_room uuid;   -- closed, retention window elapsed
  due_inv     uuid;   -- pending invitation past its expiry
  live_inv    uuid;   -- pending invitation still valid
  due_part    uuid;   -- active participation past expires_at
  live_part   uuid;   -- active participation with no expiry
  due_partner uuid;   -- partner attached to the room that must auto-close
  audit_before int;
  audit_after  int;
  r record;
  r2 record;
  n int;
BEGIN
  INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status)
       VALUES (org_a, org_b, 'approved')
  ON CONFLICT DO NOTHING;

  -- Rooms -------------------------------------------------------------------
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, scheduled_expires_at)
       VALUES (org_a, 'Expiry proof — due', 'critical_incident', 'active', now() - interval '1 minute')
    RETURNING id INTO due_room;

  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, scheduled_expires_at)
       VALUES (org_a, 'Expiry proof — future', 'critical_incident', 'active', now() + interval '2 days')
    RETURNING id INTO future_room;

  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, closed_at, temp_data_expires_at)
       VALUES (org_a, 'Expiry proof — retention', 'training', 'closed', now() - interval '3 days',
               now() - interval '1 hour')
    RETURNING id INTO retain_room;

  -- Participants ------------------------------------------------------------
  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, invitation_expires_at)
       VALUES (future_room, org_a, org_b, org_a, 'view_only', 'pending', 'invited',
               now() - interval '1 minute')
    RETURNING id INTO due_inv;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, invitation_expires_at)
       VALUES (retain_room, org_a, org_b, org_a, 'view_only', 'pending', 'invited',
               now() + interval '2 days')
    RETURNING id INTO live_inv;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, accepted_at, approved_at, expires_at)
       VALUES (future_room, org_a, org_b, org_a, 'operational', 'accepted', 'active',
               now(), now(), now() - interval '1 minute')
    RETURNING id INTO due_part;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, accepted_at, approved_at)
       VALUES (retain_room, org_a, org_b, org_a, 'operational', 'accepted', 'active',
               now(), now())
    RETURNING id INTO live_part;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, accepted_at, approved_at)
       VALUES (due_room, org_a, org_b, org_a, 'operational', 'accepted', 'active',
               now(), now())
    RETURNING id INTO due_partner;

  SELECT count(*)::int INTO audit_before FROM airs.audit_events;

  -- Sweep -------------------------------------------------------------------
  SELECT * INTO r FROM airs.expire_incident_state();

  PERFORM pg_temp.ok(r.expired_invitations >= 1, 'sweep reports at least one expired invitation');
  PERFORM pg_temp.ok(r.expired_participations >= 1, 'sweep reports at least one expired participation');
  PERFORM pg_temp.ok(r.expired_rooms >= 1, 'sweep reports at least one expired room');
  PERFORM pg_temp.ok(r.purged_rooms >= 1, 'sweep reports at least one retention-expired room');

  -- Invitations -------------------------------------------------------------
  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = due_inv AND invitation_status = 'expired' AND participation_status = 'expired';
  PERFORM pg_temp.ok(n = 1, 'overdue invitation is expired');

  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = due_inv AND token_hash IS NULL;
  PERFORM pg_temp.ok(n = 1, 'expired invitation token is destroyed');

  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = live_inv AND invitation_status = 'pending';
  PERFORM pg_temp.ok(n = 1, 'invitation that is not yet due is untouched');

  -- Participations ----------------------------------------------------------
  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = due_part AND participation_status = 'expired' AND revoked_at IS NOT NULL;
  PERFORM pg_temp.ok(n = 1, 'overdue participation is expired and stamped');

  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = live_part AND participation_status = 'active';
  PERFORM pg_temp.ok(n = 1, 'participation without an expiry stays active');

  -- Rooms -------------------------------------------------------------------
  SELECT count(*)::int INTO n FROM airs.incident_rooms
   WHERE id = due_room AND status = 'closed' AND closed_at IS NOT NULL
     AND closure_reason IS NOT NULL;
  PERFORM pg_temp.ok(n = 1, 'room past its scheduled window closes itself with a reason');

  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id = due_partner AND participation_status = 'revoked' AND token_hash IS NULL;
  PERFORM pg_temp.ok(n = 1, 'auto-closing a room revokes its partners and destroys tokens');

  SELECT count(*)::int INTO n FROM airs.incident_rooms
   WHERE id = future_room AND status = 'active';
  PERFORM pg_temp.ok(n = 1, 'room whose window is still open is untouched');

  SELECT count(*)::int INTO n FROM airs.incident_rooms
   WHERE id = retain_room AND data_expired_at IS NOT NULL;
  PERFORM pg_temp.ok(n = 1, 'temporary data past the retention window is marked expired');

  -- Access is only ever removed --------------------------------------------
  SELECT count(*)::int INTO n FROM airs.incident_participants
   WHERE id IN (due_inv, due_part, due_partner)
     AND participation_status IN ('active', 'restricted', 'invited', 'pending_approval');
  PERFORM pg_temp.ok(n = 0, 'the sweep never restores or grants access');

  -- Audit -------------------------------------------------------------------
  SELECT count(*)::int INTO audit_after FROM airs.audit_events;
  PERFORM pg_temp.ok(audit_after > audit_before, 'the sweep writes audit rows');

  SELECT count(*)::int INTO n FROM airs.audit_events
   WHERE resource_id = due_room AND action = 'incident.closed'
     AND detail->>'cause' = 'scheduled_expiration';
  PERFORM pg_temp.ok(n = 1, 'scheduled closure is audited with its cause');

  SELECT count(*)::int INTO n FROM airs.audit_events
   WHERE action = 'incident.invitation_expired' AND detail->>'participant_id' = due_inv::text;
  PERFORM pg_temp.ok(n = 1, 'invitation expiry is audited');

  SELECT count(*)::int INTO n FROM airs.audit_events
   WHERE action = 'incident.participation_expired' AND detail->>'participant_id' = due_part::text;
  PERFORM pg_temp.ok(n = 1, 'participation expiry is audited');

  SELECT count(*)::int INTO n FROM airs.audit_events
   WHERE resource_id = retain_room AND action = 'incident.temp_data_expired';
  PERFORM pg_temp.ok(n = 1, 'temporary-data expiry is audited');

  SELECT count(*)::int INTO n FROM airs.audit_events
   WHERE resource_id IN (due_room, retain_room) AND actor_user_id IS NOT NULL
     AND detail->>'cause' IN ('schedule', 'scheduled_expiration', 'retention_window');
  PERFORM pg_temp.ok(n = 0, 'scheduled audit rows carry no impersonated actor');

  -- Idempotence -------------------------------------------------------------
  SELECT * INTO r2 FROM airs.expire_incident_state();
  PERFORM pg_temp.ok(
    r2.expired_invitations = 0 AND r2.expired_participations = 0
      AND r2.expired_rooms = 0 AND r2.purged_rooms = 0,
    'a second immediate sweep is a no-op (idempotent)');

  -- Advisory lock used by every runner --------------------------------------
  PERFORM pg_temp.ok(pg_try_advisory_xact_lock(8421701), 'runner advisory lock is obtainable');

  RAISE NOTICE 'expiration.sql: all assertions passed';
END $$;

ROLLBACK;
