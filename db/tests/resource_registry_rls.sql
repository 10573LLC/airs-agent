-- AIRS Agent — operational resource registry forced-RLS proof.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/resource_registry_rls.sql
--
-- Fixtures are created by the owner role; every ASSERTION runs as the
-- unprivileged airs_app role under FORCE ROW LEVEL SECURITY. Everything is
-- rolled back, so the script leaves no rows behind.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'RESOURCE-RLS FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'RESOURCE-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE rids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON rids TO airs_app;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  org_c uuid := gen_random_uuid();                        -- unrelated agency
  room  uuid;
  closed_room uuid;
  ac    uuid;
  veh   uuid;
  person uuid;
  qual  uuid;
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type)
       VALUES (org_c, 'test-registry-outsider', 'Registry Outsider Agency', 'law_enforcement');

  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'Registry proof room', 'critical_incident', 'active')
    RETURNING id INTO room;
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'Registry closed room', 'critical_incident', 'active')
    RETURNING id INTO closed_room;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at)
       VALUES (room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now()),
              (closed_room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now());

  INSERT INTO airs.resources (org_id, category, display_name, callsign, readiness_status)
       VALUES (org_a, 'aircraft', 'Air-1', 'AIR1', 'available') RETURNING id INTO ac;
  INSERT INTO airs.resource_aircraft (resource_id, org_id, manufacturer, serial_number)
       VALUES (ac, org_a, 'Skydio', 'SN-SECRET-001');
  INSERT INTO airs.resources (org_id, category, display_name, readiness_status)
       VALUES (org_a, 'ground_vehicle', 'Mobile Command 3', 'available') RETURNING id INTO veh;

  INSERT INTO airs.personnel_profiles (org_id, display_name, operational_roles, availability_status)
       VALUES (org_a, 'A. Officer', ARRAY['rpic'], 'available') RETURNING id INTO person;
  INSERT INTO airs.qualifications
       (org_id, person_id, qualification_type, verification_status, status, expires_on)
       VALUES (org_a, person, 'rpic', 'verified', 'active', current_date + 30)
    RETURNING id INTO qual;

  INSERT INTO rids VALUES ('org_a', org_a), ('org_b', org_b), ('org_c', org_c),
                          ('room', room), ('closed_room', closed_room),
                          ('ac', ac), ('veh', veh), ('person', person), ('qual', qual);
END $$;

SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM rids WHERE k='org_a');
  org_b uuid := (SELECT v FROM rids WHERE k='org_b');
  org_c uuid := (SELECT v FROM rids WHERE k='org_c');
  room  uuid := (SELECT v FROM rids WHERE k='room');
  closed_room uuid := (SELECT v FROM rids WHERE k='closed_room');
  ac    uuid := (SELECT v FROM rids WHERE k='ac');
  veh   uuid := (SELECT v FROM rids WHERE k='veh');
  person uuid := (SELECT v FROM rids WHERE k='person');
  qual  uuid := (SELECT v FROM rids WHERE k='qual');
  n int;
BEGIN
  PERFORM pg_temp.ok(NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
                     'application role is neither superuser nor BYPASSRLS');

  -- 1. default deny: no context, nothing visible ------------------------------
  PERFORM set_config('airs.org_id', '', true);
  SELECT count(*) INTO n FROM airs.resources;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no resources');
  SELECT count(*) INTO n FROM airs.personnel_profiles;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no personnel');
  SELECT count(*) INTO n FROM airs.qualifications;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no qualifications');
  SELECT count(*) INTO n FROM airs.shifts;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no shifts');
  SELECT count(*) INTO n FROM airs.resource_shares;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no resource shares');
  SELECT count(*) INTO n FROM airs.incident_assignments;
  PERFORM pg_temp.ok(n = 0, 'no organization context sees no assignments');

  -- 2. owner visibility --------------------------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id IN (ac, veh);
  PERFORM pg_temp.ok(n = 2, 'owning organization sees its own resources');
  SELECT count(*) INTO n FROM airs.resource_aircraft WHERE resource_id = ac;
  PERFORM pg_temp.ok(n = 1, 'owning organization sees the aircraft detail row');
  SELECT count(*) INTO n FROM airs.personnel_profiles WHERE id = person;
  PERFORM pg_temp.ok(n = 1, 'owning organization sees its personnel profile');

  -- 3. before any share, partners and outsiders see nothing --------------------
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE org_id = org_a;
  PERFORM pg_temp.ok(n = 0, 'participating partner sees no unshared resource');
  SELECT count(*) INTO n FROM airs.personnel_profiles WHERE org_id = org_a;
  PERFORM pg_temp.ok(n = 0, 'participating partner never sees another agency personnel');
  SELECT count(*) INTO n FROM airs.qualifications WHERE org_id = org_a;
  PERFORM pg_temp.ok(n = 0, 'participating partner never sees another agency qualifications');
  SELECT count(*) INTO n FROM airs.shifts WHERE org_id = org_a;
  PERFORM pg_temp.ok(n = 0, 'participating partner never sees another agency shifts');

  PERFORM set_config('airs.org_id', org_c::text, true);
  SELECT count(*) INTO n FROM airs.resources;
  PERFORM pg_temp.ok(n = 0, 'unrelated organization sees no resources at all');

  -- 4. a partner cannot create records inside another tenant -------------------
  PERFORM set_config('airs.org_id', org_b::text, true);
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.resources (org_id, category, display_name) VALUES (%L, %L, %L)',
           org_a, 'aircraft', 'Forged aircraft'),
    'partner cannot register a resource owned by another agency');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.personnel_profiles (org_id, display_name) VALUES (%L, %L)',
           org_a, 'Forged person'),
    'partner cannot create a personnel profile in another agency');

  -- RLS hides the row, so an UPDATE matches nothing instead of raising.
  UPDATE airs.resources SET display_name = 'stolen' WHERE id = ac;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'partner cannot rename another agency resource');
  UPDATE airs.resources SET readiness_status = 'out_of_service' WHERE id = ac;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'partner cannot change another agency readiness state');

  -- 5. sharing into a live incident grants read, never write -------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  INSERT INTO airs.resource_shares (resource_id, org_id, incident_id, classification)
       VALUES (ac, org_a, room, 'participating_orgs');

  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 1, 'partner sees a resource shared into an incident it participates in');
  SELECT count(*) INTO n FROM airs.resources WHERE id = veh;
  PERFORM pg_temp.ok(n = 0, 'partner still cannot see an unshared resource of the same owner');
  SELECT count(*) INTO n FROM airs.resource_aircraft WHERE resource_id = ac;
  PERFORM pg_temp.ok(n = 1, 'detail row follows the parent share, never exceeds it');
  UPDATE airs.resources SET display_name = 'partner edit' WHERE id = ac;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'a shared resource is read-only for the partner');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.resource_shares (resource_id, org_id, incident_id) VALUES (%L,%L,%L)',
           ac, org_b, room),
    'partner cannot re-share a resource it does not own');

  PERFORM set_config('airs.org_id', org_c::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'a non-participant sees nothing from the share');

  -- 6. originating_org_only never leaves the owner -----------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET classification = 'originating_org_only'
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'originating_org_only is never visible to a partner');

  -- 7. named_recipients honours the recipient list -----------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares
     SET classification = 'named_recipients', named_recipient_org_ids = ARRAY[org_c]
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'named_recipients excludes an unlisted participant');
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares
     SET classification = 'participating_orgs', named_recipient_org_ids = '{}'
   WHERE resource_id = ac AND incident_id = room;

  -- 8. revocation ends access immediately --------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET revoked_at = now(), revocation_reason = 'test'
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'revoking a share removes partner visibility immediately');
  SELECT count(*) INTO n FROM airs.resource_aircraft WHERE resource_id = ac;
  PERFORM pg_temp.ok(n = 0, 'revocation also removes the detail row');

  -- 9. a revoked share is final; expiry ends access on its own -----------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(
    format('UPDATE airs.resource_shares SET revoked_at = NULL WHERE resource_id = %L
              AND incident_id = %L', ac, room),
    'a revoked share can never be un-revoked');

  -- a second resource proves the time-based path independently
  INSERT INTO airs.resource_shares (resource_id, org_id, incident_id, classification, expires_at)
       VALUES (veh, org_a, room, 'participating_orgs', now() - interval '1 minute');
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = veh;
  PERFORM pg_temp.ok(n = 0, 'an expired share confers no visibility');
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET expires_at = now() + interval '1 hour'
   WHERE resource_id = veh AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = veh;
  PERFORM pg_temp.ok(n = 1, 'extending the expiry window restores the live share');

  -- 10. assignment rules --------------------------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  INSERT INTO airs.incident_assignments
       (incident_id, org_id, assignment_type, resource_id, status)
       VALUES (room, org_a, 'resource', ac, 'assigned');
  SELECT count(*) INTO n FROM airs.incident_assignments WHERE incident_id = room;
  PERFORM pg_temp.ok(n = 1, 'owner can assign its own resource to its own room');

  PERFORM pg_temp.denied(
    format('INSERT INTO airs.incident_assignments
              (incident_id, org_id, assignment_type, resource_id, status)
            VALUES (%L,%L,%L,%L,%L)', room, org_a, 'resource', ac, 'assigned'),
    'the same resource cannot hold two live assignments in one room');

  PERFORM set_config('airs.org_id', org_b::text, true);
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.incident_assignments
              (incident_id, org_id, assignment_type, resource_id, status)
            VALUES (%L,%L,%L,%L,%L)', room, org_b, 'resource', ac, 'assigned'),
    'a partner cannot assign a resource it does not own');
  UPDATE airs.incident_assignments SET status = 'cancelled' WHERE incident_id = room;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'a partner cannot release another agency assignment');

  -- 11. ownership and identity are immutable ------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(
    format('UPDATE airs.resources SET org_id = %L WHERE id = %L', org_b, ac),
    'resource ownership cannot be transferred');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resources SET readiness_status = %L WHERE id = %L', 'not_a_status', ac),
    'an invalid readiness state is rejected');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resources SET readiness_status = %L WHERE id = %L', 'charging', ac),
    'a readiness state from another category is rejected');

  -- 12. retirement keeps the record and its history -----------------------------
  UPDATE airs.resources
     SET lifecycle_status = 'retired', readiness_status = 'retired', retired_at = now()
   WHERE id = ac;
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac AND lifecycle_status = 'retired';
  PERFORM pg_temp.ok(n = 1, 'a retired resource is preserved, not deleted');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resources SET readiness_status = %L WHERE id = %L', 'available', ac),
    'a retired resource cannot be returned to service by a status change alone');

  -- 13. qualifications: expiry and revocation are enforced on read --------------
  SELECT count(*) INTO n FROM airs.qualifications q
   WHERE q.id = qual AND airs.qualification_is_current(q.*);
  PERFORM pg_temp.ok(n = 1, 'a verified, unexpired qualification is current');
  UPDATE airs.qualifications SET expires_on = current_date - 1 WHERE id = qual;
  SELECT count(*) INTO n FROM airs.qualifications q
   WHERE q.id = qual AND airs.qualification_is_current(q.*);
  PERFORM pg_temp.ok(n = 0, 'an expired qualification is never current');
  UPDATE airs.qualifications SET expires_on = current_date + 30, revoked_at = now(),
                                 status = 'revoked' WHERE id = qual;
  SELECT count(*) INTO n FROM airs.qualifications q
   WHERE q.id = qual AND airs.qualification_is_current(q.*);
  PERFORM pg_temp.ok(n = 0, 'a revoked qualification is never current');

  -- 14. shifts: no overlapping duty for one person ------------------------------
  INSERT INTO airs.shifts (org_id, person_id, operational_role, starts_at, ends_at)
       VALUES (org_a, person, 'rpic', now(), now() + interval '8 hours');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.shifts (org_id, person_id, operational_role, starts_at, ends_at)
            VALUES (%L,%L,%L, now() + interval ''1 hour'', now() + interval ''9 hours'')',
           org_a, person, 'rpic'),
    'overlapping shifts for one person are rejected');

  -- 15. closing the room terminates all resource access -------------------------
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = veh;
  PERFORM pg_temp.ok(n = 1, 'partner access is live immediately before closure');
END $$;

RESET ROLE;

-- Closure runs as the owner (the application performs it through its own
-- authorization chain); the assertions afterwards run as airs_app again.
DO $$
DECLARE
  room uuid := (SELECT v FROM rids WHERE k='room');
BEGIN
  UPDATE airs.incident_rooms SET status = 'closed', closed_at = now() WHERE id = room;
  PERFORM airs.terminate_incident_resource_access(room);
END $$;

SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM rids WHERE k='org_a');
  org_b uuid := (SELECT v FROM rids WHERE k='org_b');
  room  uuid := (SELECT v FROM rids WHERE k='room');
  ac    uuid := (SELECT v FROM rids WHERE k='ac');
  veh   uuid := (SELECT v FROM rids WHERE k='veh');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resources WHERE id = veh;
  PERFORM pg_temp.ok(n = 0, 'closing the room ends partner visibility of shared resources');
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'no resource of the owner remains visible after closure');

  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT count(*) INTO n FROM airs.resource_shares
   WHERE incident_id = room AND revoked_at IS NULL;
  PERFORM pg_temp.ok(n = 0, 'closure revokes every share made into the room');
  SELECT count(*) INTO n FROM airs.incident_assignments
   WHERE incident_id = room AND status IN ('proposed','assigned','deploying','active');
  PERFORM pg_temp.ok(n = 0, 'closure releases every live assignment in the room');
  SELECT count(*) INTO n FROM airs.resources WHERE id IN (ac, veh);
  PERFORM pg_temp.ok(n = 2, 'the owning agency still holds its resources after closure');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.resource_shares (resource_id, org_id, incident_id) VALUES (%L,%L,%L)',
           ac, org_a, room),
    'no new share can be created into a closed room');

  RAISE NOTICE 'resource registry RLS proof complete';
END $$;

RESET ROLE;
ROLLBACK;
