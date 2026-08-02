-- AIRS Agent — incident-room forced-RLS proof.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/incident_rls.sql
--
-- Fixtures are created by the owner role; every ASSERTION runs as the
-- unprivileged airs_app role under FORCE ROW LEVEL SECURITY. The script
-- rolls everything back and leaves no rows behind.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'INCIDENT-RLS FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'INCIDENT-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE iids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON iids TO airs_app;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  org_c uuid := gen_random_uuid();                        -- untrusted third agency
  room  uuid;
  room2 uuid;
  part  uuid;
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type)
       VALUES (org_c, 'test-untrusted-agency', 'Untrusted Test Agency', 'law_enforcement');

  INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status)
       VALUES (org_a, org_b, 'approved');

  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'RLS proof room', 'critical_incident', 'active')
    RETURNING id INTO room;
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'RLS proof room (no partners)', 'training', 'active')
    RETURNING id INTO room2;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at)
       VALUES (room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now())
    RETURNING id INTO part;

  INSERT INTO iids VALUES ('org_a', org_a), ('org_b', org_b), ('org_c', org_c),
                          ('room', room), ('room2', room2), ('part', part);
END $$;

SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM iids WHERE k='org_a');
  org_b uuid := (SELECT v FROM iids WHERE k='org_b');
  org_c uuid := (SELECT v FROM iids WHERE k='org_c');
  room  uuid := (SELECT v FROM iids WHERE k='room');
  room2 uuid := (SELECT v FROM iids WHERE k='room2');
  part  uuid := (SELECT v FROM iids WHERE k='part');
  n int;
BEGIN
  PERFORM pg_temp.ok(NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
                     'application role is neither superuser nor BYPASSRLS');

  -- no context at all -> nothing is visible
  PERFORM set_config('airs.org_id', '', true);
  SELECT count(*) INTO n FROM airs.incident_rooms;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no incident rooms');
  SELECT count(*) INTO n FROM airs.incident_participants;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no participation rows');
  SELECT count(*) INTO n FROM airs.trusted_agencies;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no trust relationships');

  -- originating organization
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id IN (room, room2);
  PERFORM pg_temp.ok(n = 2, 'originating organization sees its own rooms');
  SELECT count(*) INTO n FROM airs.incident_participants WHERE incident_id = room;
  PERFORM pg_temp.ok(n = 1, 'originating organization sees the roster');

  -- participating partner
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room;
  PERFORM pg_temp.ok(n = 1, 'active partner sees the shared room');
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room2;
  PERFORM pg_temp.ok(n = 0, 'active partner does NOT see an unshared room of the same owner');

  -- unrelated third organization
  PERFORM set_config('airs.org_id', org_c::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms;
  PERFORM pg_temp.ok(n = 0, 'unrelated organization sees no rooms');
  SELECT count(*) INTO n FROM airs.incident_participants;
  PERFORM pg_temp.ok(n = 0, 'unrelated organization sees no participation rows');
  -- RLS hides the row, so the UPDATE matches nothing rather than raising.
  UPDATE airs.incident_rooms SET name = 'stolen' WHERE id = room;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'unrelated organization cannot rename another tenant''s room');

  -- a partner may not write the room, invite anyone, or edit its own grant
  PERFORM set_config('airs.org_id', org_b::text, true);
  UPDATE airs.incident_rooms SET name = 'partner rename' WHERE id = room;
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room AND name = 'partner rename';
  PERFORM pg_temp.ok(n = 0, 'participating partner cannot rename the room');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.incident_participants (incident_id, org_id, partner_org_id,
              invited_by_org_id, invitation_expires_at)
            VALUES (%L, %L, %L, %L, now() + interval ''1 day'')', room, org_b, org_c, org_b),
    'participating partner cannot invite a further organization');
  PERFORM pg_temp.denied(
    format('UPDATE airs.incident_participants SET access_level = ''incident_command''
             WHERE id = %L', part),
    'participating partner cannot raise its own access level');
  PERFORM pg_temp.denied(
    format('UPDATE airs.incident_participants SET expires_at = now() + interval ''999 days''
             WHERE id = %L', part),
    'participating partner cannot extend its own participation');

  -- ownership is immutable even for the owner
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(
    format('UPDATE airs.incident_rooms SET org_id = %L WHERE id = %L', org_b, room),
    'incident ownership cannot be transferred');

  -- revocation ends partner visibility immediately
  UPDATE airs.incident_participants
     SET participation_status = 'revoked', revoked_at = now() WHERE id = part;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room;
  PERFORM pg_temp.ok(n = 0, 'revoked partner immediately loses room visibility');

  -- reinstated, then the room closes: closure ends visibility too
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.incident_participants
     SET participation_status = 'active', revoked_at = NULL WHERE id = part;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room;
  PERFORM pg_temp.ok(n = 1, 'reinstated partner sees the room again');
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.incident_rooms SET status = 'closed', closed_at = now() WHERE id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room;
  PERFORM pg_temp.ok(n = 0, 'closing the room ends partner visibility');
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room;
  PERFORM pg_temp.ok(n = 1, 'the originating organization still sees the closed room');
  PERFORM pg_temp.denied(
    format('UPDATE airs.incident_rooms SET status = ''active'' WHERE id = %L', room),
    'a closed room cannot be reopened');

  -- expired participation conveys nothing
  UPDATE airs.incident_rooms SET status = 'archived', archived_at = now() WHERE id = room;
  PERFORM pg_temp.denied(
    format('UPDATE airs.incident_rooms SET name = ''after archive'' WHERE id = %L', room),
    'an archived room is frozen');

  -- expiry on an open room
  UPDATE airs.incident_participants
     SET participation_status = 'active', revoked_at = NULL,
         expires_at = now() - interval '1 minute', incident_id = room2
   WHERE id = part;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.incident_rooms WHERE id = room2;
  PERFORM pg_temp.ok(n = 0, 'expired participation conveys no visibility');

  RAISE NOTICE 'incident_rls.sql: all assertions passed';
END $$;

RESET ROLE;
ROLLBACK;
