-- AIRS Agent — field-level disclosure proof (Stage 6 closure).
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/disclosure_projection.sql
--
-- Proves the second access decision: given a row RLS has already released,
-- which FIELDS may leave the originating organization. Fixtures are created by
-- the owner role; every assertion runs as the unprivileged airs_app role under
-- FORCE ROW LEVEL SECURITY. Everything is rolled back.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'DISCLOSURE FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'DISCLOSURE FAIL: % — statement was NOT rejected', label;
END $$;

-- --- 1. vocabulary parity with src/lib/resources/disclosure.ts ----------------
DO $$
DECLARE f int; pf int; s int;
BEGIN
  SELECT count(*) INTO f FROM airs.disclosure_fields;
  SELECT count(*) INTO pf FROM airs.disclosure_profile_fields;
  SELECT count(*) INTO s FROM airs.disclosure_fields WHERE sensitive;
  PERFORM pg_temp.ok(f = 60, format('field vocabulary is 60 keys (actual %s)', f));
  PERFORM pg_temp.ok(pf = 242, format('profile grid is 242 rows (actual %s)', pf));
  PERFORM pg_temp.ok(s = 12, format('12 keys are marked sensitive (actual %s)', s));

  SELECT count(*) INTO f FROM airs.disclosure_profile_fields WHERE profile = 'summary';
  PERFORM pg_temp.ok(f = 9, 'summary profile exposes exactly 9 keys');
  SELECT count(*) INTO f FROM airs.disclosure_profile_fields WHERE profile = 'operational';
  PERFORM pg_temp.ok(f = 33, 'operational profile exposes 33 keys');
  SELECT count(*) INTO f FROM airs.disclosure_profile_fields WHERE profile = 'aviation';
  PERFORM pg_temp.ok(f = 44, 'aviation profile exposes 44 keys');
  SELECT count(*) INTO f FROM airs.disclosure_profile_fields WHERE profile = 'incident_command';
  PERFORM pg_temp.ok(f = 48, 'incident command profile exposes 48 keys');
END $$;

-- --- 2. sensitive fields are absent from every partner profile ---------------
DO $$
DECLARE n int; k text;
BEGIN
  SELECT count(*) INTO n
    FROM airs.disclosure_profile_fields pf
    JOIN airs.disclosure_fields f USING (field_key)
   WHERE f.sensitive AND pf.profile <> 'full';
  PERFORM pg_temp.ok(n = 0, 'no sensitive field appears in any profile other than full');

  FOREACH k IN ARRAY ARRAY['serialNumber','faaRegistration','remoteId','restrictedNotes',
                           'maintenanceStatus','personDutyContact','personEmployeeIdentifier',
                           'qualificationRestrictions'] LOOP
    PERFORM pg_temp.ok(
      airs.disclosure_allows('incident_command', NULL, k) IS FALSE,
      format('%s is withheld even at incident command level', k));
    PERFORM pg_temp.ok(
      airs.disclosure_allows('custom', ARRAY[k], k) IS FALSE,
      format('%s cannot be smuggled in through a custom profile', k));
  END LOOP;

  -- Cumulative widening, never narrowing, and never a wildcard.
  PERFORM pg_temp.ok(airs.disclosure_allows('summary', NULL, 'displayName'),
                     'summary discloses the display name');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows('summary', NULL, 'description'),
                     'summary withholds the description');
  PERFORM pg_temp.ok(airs.disclosure_allows('operational', NULL, 'description'),
                     'operational adds the description');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows('operational', NULL, 'model'),
                     'operational withholds the aircraft model');
  PERFORM pg_temp.ok(airs.disclosure_allows('aviation', NULL, 'model'),
                     'aviation adds the aircraft model');
  PERFORM pg_temp.ok(airs.disclosure_allows('aviation', NULL, 'displayName'),
                     'aviation still includes everything summary disclosed');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows('aviation', NULL, 'locationDescription'),
                     'aviation withholds the launch-site location description');
  PERFORM pg_temp.ok(airs.disclosure_allows('incident_command', NULL, 'locationDescription'),
                     'incident command adds the launch-site location description');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows(NULL, NULL, 'description'),
                     'an absent profile falls back to summary, not to open');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows('operational', NULL, 'noSuchField'),
                     'an unknown field key is never disclosable');

  -- custom = summary floor + explicitly approved non-sensitive keys
  PERFORM pg_temp.ok(airs.disclosure_allows('custom', ARRAY['model'], 'model'),
                     'custom profile discloses an approved field');
  PERFORM pg_temp.ok(airs.disclosure_allows('custom', ARRAY['model'], 'displayName'),
                     'custom profile keeps the summary floor');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows('custom', ARRAY['model'], 'description'),
                     'custom profile discloses nothing it did not name');
END $$;

BEGIN;

CREATE TEMP TABLE dids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON dids TO airs_app;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  room uuid; ac uuid; ac2 uuid; person uuid; asg uuid;
BEGIN
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'Disclosure proof room', 'critical_incident', 'active')
    RETURNING id INTO room;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at)
       VALUES (room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now());

  INSERT INTO airs.resources (org_id, category, display_name, callsign, readiness_status,
                              restricted_notes)
       VALUES (org_a, 'aircraft', 'Air-1', 'AIR1', 'available', 'internal tasking note')
    RETURNING id INTO ac;
  INSERT INTO airs.resource_aircraft (resource_id, org_id, manufacturer, model,
                                      serial_number, faa_registration)
       VALUES (ac, org_a, 'Skydio', 'X10', 'SN-SECRET-001', 'FA-SECRET');

  INSERT INTO airs.resources (org_id, category, display_name, readiness_status)
       VALUES (org_a, 'ground_vehicle', 'Mobile Command 3', 'available')
    RETURNING id INTO ac2;

  INSERT INTO airs.personnel_profiles (org_id, display_name, operational_roles,
                                       availability_status, duty_contact)
       VALUES (org_a, 'A. Officer', ARRAY['rpic'], 'available', '555-0100')
    RETURNING id INTO person;
  INSERT INTO airs.qualifications
       (org_id, person_id, qualification_type, verification_status, status,
        effective_date, expires_on)
       VALUES (org_a, person, 'rpic', 'verified', 'active', current_date - 10, current_date + 30);

  INSERT INTO airs.incident_assignments
       (incident_id, org_id, assignment_type, person_id, assigned_role, status,
        disclosure_profile)
       VALUES (room, org_a, 'person', person, 'rpic', 'assigned', 'aviation')
    RETURNING id INTO asg;

  INSERT INTO dids VALUES ('org_a', org_a), ('org_b', org_b), ('room', room),
                          ('ac', ac), ('ac2', ac2), ('person', person), ('asg', asg);
END $$;

SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM dids WHERE k='org_a');
  org_b uuid := (SELECT v FROM dids WHERE k='org_b');
  room  uuid := (SELECT v FROM dids WHERE k='room');
  ac    uuid := (SELECT v FROM dids WHERE k='ac');
  ac2   uuid := (SELECT v FROM dids WHERE k='ac2');
  asg   uuid := (SELECT v FROM dids WHERE k='asg');
  prof  text;
  named boolean;
  n int;
  quals text[];
BEGIN
  PERFORM pg_temp.ok(NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
                     'disclosure assertions run without superuser or BYPASSRLS');

  -- 3. reference data is readable but not writable by the application ---------
  SELECT count(*) INTO n FROM airs.disclosure_fields;
  PERFORM pg_temp.ok(n = 60, 'application role can read the field vocabulary');
  PERFORM pg_temp.denied(
    'INSERT INTO airs.disclosure_fields (field_key, source) VALUES (''forged'',''resource'')',
    'application role cannot invent a disclosable field');
  PERFORM pg_temp.denied(
    'INSERT INTO airs.disclosure_profile_fields (profile, field_key) '
    'VALUES (''summary'',''serialNumber'')',
    'application role cannot widen a profile');

  -- 4. default deny on the share itself ---------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  INSERT INTO airs.resource_shares (resource_id, org_id, incident_id, classification)
       VALUES (ac, org_a, room, 'participating_orgs');
  SELECT disclosure_profile INTO prof FROM airs.resource_shares
   WHERE resource_id = ac AND incident_id = room;
  PERFORM pg_temp.ok(prof = 'summary', 'a share with no stated profile defaults to summary');

  -- 5. the database refuses an unsafe custom key list -------------------------
  PERFORM pg_temp.denied(
    format('UPDATE airs.resource_shares SET disclosure_profile = ''custom'', '
           'custom_field_keys = ARRAY[''serialNumber''] WHERE resource_id = %L', ac),
    'a custom profile cannot name a sensitive field');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resource_shares SET disclosure_profile = ''custom'', '
           'custom_field_keys = ARRAY[''nonsense''] WHERE resource_id = %L', ac),
    'a custom profile cannot name an unknown field');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resource_shares SET custom_field_keys = ARRAY[''model''] '
           'WHERE resource_id = %L', ac),
    'field keys are rejected unless the profile is custom');
  PERFORM pg_temp.denied(
    format('UPDATE airs.resource_shares SET disclosure_profile = ''wide_open'' '
           'WHERE resource_id = %L', ac),
    'an unknown profile name is rejected by the check constraint');

  -- 6. effective disclosure per reader ----------------------------------------
  SELECT profile INTO prof FROM airs.effective_disclosure(ac);
  PERFORM pg_temp.ok(prof = 'full', 'the originating organization always resolves to full');

  UPDATE airs.resource_shares SET disclosure_profile = 'aviation'
   WHERE resource_id = ac AND incident_id = room;

  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT profile, named_recipient INTO prof, named FROM airs.effective_disclosure(ac);
  PERFORM pg_temp.ok(prof = 'aviation', 'the partner resolves to the profile the owner set');
  PERFORM pg_temp.ok(named IS NOT TRUE, 'a participating-orgs share is not a named recipient');
  PERFORM pg_temp.ok(airs.disclosure_allows(prof, NULL, 'model'),
                     'partner may see the aircraft model under aviation');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows(prof, NULL, 'serialNumber'),
                     'partner may not see the serial number under aviation');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows(prof, NULL, 'restrictedNotes'),
                     'partner may not see restricted notes under aviation');

  -- 7. narrowing takes effect immediately -------------------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET disclosure_profile = 'summary'
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT profile INTO prof FROM airs.effective_disclosure(ac);
  PERFORM pg_temp.ok(prof = 'summary', 'narrowing the profile applies to the next read');
  PERFORM pg_temp.ok(NOT airs.disclosure_allows(prof, NULL, 'model'),
                     'a field disclosed a moment ago is withheld after narrowing');

  -- 8. named recipients are the only path to the full record ------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares
     SET classification = 'named_recipients', named_recipient_org_ids = ARRAY[org_b],
         disclosure_profile = 'full'
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT profile, named_recipient INTO prof, named FROM airs.effective_disclosure(ac);
  PERFORM pg_temp.ok(prof = 'full' AND named, 'an explicitly named recipient resolves to full');

  -- 9. revocation and closure end disclosure entirely -------------------------
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET revoked_at = now()
   WHERE resource_id = ac AND incident_id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.effective_disclosure(ac);
  PERFORM pg_temp.ok(n = 0, 'a revoked share resolves to no disclosure at all');
  SELECT count(*) INTO n FROM airs.resources WHERE id = ac;
  PERFORM pg_temp.ok(n = 0, 'row-level security still hides the revoked resource');

  -- 10. personnel qualification currency only, never the record ---------------
  PERFORM set_config('airs.org_id', org_b::text, true);
  quals := airs.assignment_current_qualifications(asg);
  PERFORM pg_temp.ok(quals @> ARRAY['rpic'],
                     'partner sees that an assigned person holds a current RPIC qualification');
  SELECT count(*) INTO n FROM airs.qualifications;
  PERFORM pg_temp.ok(n = 0, 'partner still cannot read a single qualification row');
  SELECT count(*) INTO n FROM airs.personnel_profiles;
  PERFORM pg_temp.ok(n = 0, 'partner still cannot read a single personnel profile');

  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.qualifications SET expires_on = current_date - 1;
  PERFORM set_config('airs.org_id', org_b::text, true);
  quals := airs.assignment_current_qualifications(asg);
  PERFORM pg_temp.ok(COALESCE(array_length(quals, 1), 0) = 0,
                     'an expired qualification stops being current with no sweep job');

  -- 11. closing the room ends field disclosure, not just row access ----------
  PERFORM set_config('airs.org_id', org_a::text, true);
  INSERT INTO airs.resource_shares (resource_id, org_id, incident_id, classification,
                                    disclosure_profile)
       VALUES (ac2, org_a, room, 'participating_orgs', 'operational');
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT profile INTO prof FROM airs.effective_disclosure(ac2);
  PERFORM pg_temp.ok(prof = 'operational', 'a live share on an open room discloses its profile');

  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.incident_rooms SET status = 'closed' WHERE id = room;
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.effective_disclosure(ac2);
  PERFORM pg_temp.ok(n = 0, 'closing the room ends field disclosure, not just row access');

  RAISE NOTICE 'disclosure projection proof complete';
END $$;

RESET ROLE;
ROLLBACK;
