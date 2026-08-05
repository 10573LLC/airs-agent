-- AIRS Agent — Stage 8 awareness layer: forced-RLS, ownership, disclosure and
-- geographic-precision proof for manually entered airspace observations.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/awareness_observations_rls.sql
--
-- Fixtures are created by the migration owner; every ASSERTION runs as the
-- unprivileged airs_app role under FORCE ROW LEVEL SECURITY, i.e. on exactly
-- the code path a browser request travels. Everything is rolled back, so the
-- script leaves no rows behind. Any failed assertion aborts with a nonzero
-- psql exit status.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'AWARENESS-RLS FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'AWARENESS-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE aids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON aids TO airs_app;

-- ===========================================================================
-- Fixtures
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  org_c uuid := gen_random_uuid();                        -- unrelated agency
  acct_a uuid; acct_susp uuid; user_a uuid; user_susp uuid;
  room uuid; closed_room uuid;
  obs_exact uuid; obs_withheld uuid; obs_unshared uuid; obs_expiring uuid;
  obs_expired uuid; obs_participating uuid; obs_closed uuid; obs_second uuid;
  share_live uuid; share_expiring uuid; share_room uuid;
  gap_id uuid; ev_id uuid;
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type)
       VALUES (org_c, 'test-awareness-outsider', 'Awareness Outsider Agency', 'law_enforcement');

  INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status, approved_at)
       VALUES (org_a, org_b, 'approved', now())
    ON CONFLICT (org_id, partner_org_id)
    DO UPDATE SET status = 'approved', approved_at = now();

  INSERT INTO airs.accounts (email, display_name, password_hash)
       VALUES ('awareness.reviewer@example.test', 'Awareness Reviewer', 'x')
    RETURNING id INTO acct_a;
  INSERT INTO airs.accounts (email, display_name, password_hash)
       VALUES ('awareness.suspended@example.test', 'Suspended Member', 'x')
    RETURNING id INTO acct_susp;
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
       VALUES (org_a, 'awareness.reviewer@example.test', 'Awareness Reviewer', acct_a)
    RETURNING id INTO user_a;
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
       VALUES (org_a, 'awareness.suspended@example.test', 'Suspended Member', acct_susp)
    RETURNING id INTO user_susp;
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
       VALUES (org_a, acct_a, user_a, 'airspace_supervisor', 'active', now());
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
       VALUES (org_a, acct_susp, user_susp, 'airspace_supervisor', 'suspended', now());

  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'Awareness proof room', 'critical_incident', 'active')
    RETURNING id INTO room;
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'Awareness closed room', 'critical_incident', 'active')
    RETURNING id INTO closed_room;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at)
       VALUES (room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now()),
              (closed_room, org_a, org_b, org_a, 'operational', 'accepted', 'active', false,
               now() + interval '2 days', now(), now());

  -- Exact geometry, declared exact, restricted source plane populated.
  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, description, observed_object,
        observed_at, observed_time_precision, location_kind, geom, precision_policy,
        source_type, source_detail, reporter_identity, reporter_contact,
        internal_notes, internal_case_number, source_reliability,
        information_credibility, confidence_level, urgency, classification,
        disclosure_profile, created_by_account, updated_by_account)
       VALUES (org_a, room, 'suspected_unauthorized_uas', 'Small quadcopter over the perimeter',
               'Observed hovering at low altitude near the north perimeter.', 'small white quadcopter',
               now() - interval '2 minutes', 'exact', 'manual_point',
               public.ST_SetSRID(public.ST_MakePoint(-73.75623, 42.65187), 4326), 'exact',
               'public_report', 'Caller stated they watched it for four minutes.',
               'Jane Q. Reporter', '+1-518-555-0147',
               'Cross-reference open case; caller is a known complainant.', 'APD-2026-004417',
               'usually_reliable', 'probably_true', 'moderate', 'priority',
               'participating_orgs', 'operational', acct_a, acct_a)
    RETURNING id INTO obs_exact;

  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, geom,
        precision_policy, source_type, classification, disclosure_profile,
        observed_at, created_by_account, updated_by_account)
       VALUES (org_a, room, 'flight_safety_hazard', 'Crane obstruction near approach',
               'manual_point', public.ST_SetSRID(public.ST_MakePoint(-73.71111, 42.71111), 4326),
               'withheld', 'direct_reporting_user', 'participating_orgs', 'operational',
               now() - interval '10 minutes', acct_a, acct_a)
    RETURNING id INTO obs_withheld;

  -- No incident, originating-org-only: there is no partner path to it at all.
  INSERT INTO airs.observations
       (org_id, observation_type, title, location_kind, geom, precision_policy,
        source_type, classification, observed_at, created_by_account, updated_by_account)
       VALUES (org_a, 'critical_asset_concern', 'Internal-only concern', 'manual_point',
               public.ST_SetSRID(public.ST_MakePoint(-73.80000, 42.60000), 4326), 'exact',
               'direct_reporting_user', 'originating_org_only', now() - interval '5 minutes',
               acct_a, acct_a)
    RETURNING id INTO obs_unshared;

  -- Share-expiry probe: the share itself expires, the observation does not.
  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, geom,
        precision_policy, source_type, classification, disclosure_profile,
        observed_at, created_by_account, updated_by_account)
       VALUES (org_a, room, 'other_observation', 'Share-expiry probe', 'manual_point',
               public.ST_SetSRID(public.ST_MakePoint(-73.74000, 42.64000), 4326), 'exact',
               'direct_reporting_user', 'originating_org_only', 'operational',
               now() - interval '3 minutes', acct_a, acct_a)
    RETURNING id INTO obs_expiring;

  -- Visibility window already closed: expired, and no longer partner-visible.
  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, source_type,
        classification, disclosure_profile, observed_at, visible_from, visible_until,
        created_by_account, updated_by_account)
       VALUES (org_a, room, 'other_observation', 'Visibility already ended', 'none',
               'direct_reporting_user', 'participating_orgs', 'operational',
               now() - interval '30 minutes', now() - interval '2 hours',
               now() - interval '1 minute', acct_a, acct_a)
    RETURNING id INTO obs_expired;

  -- Reachable through live incident participation alone.
  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, geom,
        precision_policy, source_type, classification, disclosure_profile,
        observed_at, created_by_account, updated_by_account)
       VALUES (org_a, room, 'manned_aircraft_activity', 'Helicopter transiting the box',
               'manual_point', public.ST_SetSRID(public.ST_MakePoint(-73.76500, 42.66500), 4326),
               'exact', 'direct_reporting_user', 'participating_orgs', 'operational',
               now() - interval '4 minutes', acct_a, acct_a)
    RETURNING id INTO obs_participating;

  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, source_type,
        classification, lifecycle_status, closed_at, closed_by_account,
        observed_at, created_by_account, updated_by_account)
       VALUES (org_a, room, 'other_observation', 'Already closed record', 'none',
               'direct_reporting_user', 'originating_org_only', 'closed', now(), acct_a,
               now() - interval '6 hours', acct_a, acct_a)
    RETURNING id INTO obs_closed;

  INSERT INTO airs.observations
       (org_id, incident_id, observation_type, title, location_kind, source_type,
        classification, observed_at, created_by_account, updated_by_account)
       VALUES (org_a, room, 'public_report', 'Second report, same aircraft', 'none',
               'public_report', 'originating_org_only', now() - interval '3 minutes',
               acct_a, acct_a)
    RETURNING id INTO obs_second;

  -- Shares: a live one narrowed to 'generalized', one about to expire, one
  -- scoped to the room that incident closure must revoke.
  INSERT INTO airs.observation_shares
       (org_id, observation_id, partner_org_id, incident_id, disclosure_profile,
        precision_policy, shared_by_account)
       VALUES (org_a, obs_exact, org_b, room, 'operational', 'generalized', acct_a)
    RETURNING id INTO share_live;
  INSERT INTO airs.observation_shares
       (org_id, observation_id, partner_org_id, incident_id, disclosure_profile,
        precision_policy, expires_at, shared_by_account)
       VALUES (org_a, obs_expiring, org_b, NULL, 'operational', 'generalized',
               now() + interval '1 second', acct_a)
    RETURNING id INTO share_expiring;
  INSERT INTO airs.observation_shares
       (org_id, observation_id, partner_org_id, incident_id, disclosure_profile,
        precision_policy, shared_by_account)
       VALUES (org_a, obs_withheld, org_b, room, 'operational', 'generalized', acct_a)
    RETURNING id INTO share_room;

  INSERT INTO airs.observation_information_gaps
       (org_id, observation_id, gap_type, detail, created_by_account)
       VALUES (org_a, obs_exact, 'operator_unknown', 'No operator located on scene.', acct_a)
    RETURNING id INTO gap_id;

  INSERT INTO airs.observation_evidence_references
       (org_id, observation_id, reference_type, display_name, reference_value,
        classification, created_by_account)
       VALUES (org_a, obs_exact, 'external_case_number', 'Records-management case',
               'APD-RMS-2026-004417', 'participating_orgs', acct_a)
    RETURNING id INTO ev_id;

  INSERT INTO airs.observation_relationships
       (org_id, observation_id, related_observation_id, relationship, created_by_account)
       VALUES (org_a, obs_exact, obs_second, 'corroborates', acct_a);

  INSERT INTO aids VALUES
    ('org_a',org_a),('org_b',org_b),('org_c',org_c),
    ('acct_a',acct_a),('acct_susp',acct_susp),
    ('room',room),('closed_room',closed_room),
    ('obs_exact',obs_exact),('obs_withheld',obs_withheld),('obs_unshared',obs_unshared),
    ('obs_expiring',obs_expiring),('obs_expired',obs_expired),
    ('obs_participating',obs_participating),('obs_closed',obs_closed),
    ('obs_second',obs_second),
    ('share_live',share_live),('share_expiring',share_expiring),('share_room',share_room),
    ('gap',gap_id),('evidence',ev_id);
END $$;

-- ===========================================================================
-- A. The application role itself
-- ===========================================================================
DO $$
DECLARE r pg_catalog.pg_roles%ROWTYPE; n int;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'airs_app';
  PERFORM pg_temp.ok(r.rolname IS NOT NULL, 'the application role airs_app exists');
  PERFORM pg_temp.ok(r.rolsuper IS FALSE,   'airs_app is not a superuser');
  PERFORM pg_temp.ok(r.rolbypassrls IS FALSE, 'airs_app does not have BYPASSRLS');

  SELECT count(*) INTO n FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'airs'
     AND c.relname IN ('observations','observation_annotations','observation_relationships',
                       'observation_information_gaps','observation_evidence_references',
                       'observation_shares')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  PERFORM pg_temp.ok(n = 6, 'forced row-level security is enabled on all six awareness tables');

  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'airs_app' AND table_schema = 'airs'
     AND table_name LIKE 'observation%' AND privilege_type = 'DELETE';
  PERFORM pg_temp.ok(n = 0, 'airs_app holds no DELETE grant on any awareness table');
END $$;

SET ROLE airs_app;

-- ===========================================================================
-- B. Missing context denies everything
-- ===========================================================================
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('airs.org_id', '', true);
  PERFORM set_config('airs.account_id', '', true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'missing organization context returns no observations');
  SELECT count(*) INTO n FROM airs.observation_shares;
  PERFORM pg_temp.ok(n = 0, 'missing organization context returns no observation shares');
  SELECT count(*) INTO n FROM airs.observation_information_gaps;
  PERFORM pg_temp.ok(n = 0, 'missing organization context returns no information gaps');

  PERFORM set_config('airs.org_id', 'not-a-uuid', true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'a malformed organization context returns no observations');
END $$;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM set_config('airs.account_id', '', true);
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observations (org_id, observation_type, title, location_kind, source_type)
       SELECT NULL, 'other_observation', 'no tenant', 'none', 'other_source'$q$),
    'an observation cannot be created without an owning organization');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = obs) = 1,
    'the originating organization can read its own observation');
END $$;

-- ===========================================================================
-- C. Suspended and revoked memberships
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  acct_a uuid := (SELECT v FROM aids WHERE k='acct_a');
  acct_s uuid := (SELECT v FROM aids WHERE k='acct_susp');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM set_config('airs.account_id', acct_a::text, true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n > 0, 'an active member reads the organization observations');

  PERFORM set_config('airs.account_id', acct_s::text, true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'a suspended membership is denied every observation');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observations (org_id, observation_type, title, location_kind, source_type)
       VALUES ('%s','other_observation','suspended write','none','other_source')$q$, org_a),
    'a suspended membership cannot create an observation');
  PERFORM set_config('airs.account_id', '', true);
END $$;

RESET ROLE;
UPDATE airs.memberships SET status = 'revoked'
 WHERE account_id = (SELECT v FROM aids WHERE k='acct_susp');
SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  acct_s uuid := (SELECT v FROM aids WHERE k='acct_susp');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM set_config('airs.account_id', acct_s::text, true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'a revoked membership is denied every observation');
  -- Reauthentication cannot restore what revocation removed: the identity
  -- plane is re-evaluated on every statement, not cached in a session.
  PERFORM set_config('airs.account_id', '', true);
  PERFORM set_config('airs.account_id', acct_s::text, true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'presenting the revoked identity again still returns nothing');
  PERFORM set_config('airs.account_id', '', true);
END $$;

-- ===========================================================================
-- D. Owner plane
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  g text; pol text; prof text; fresh text; ident text; n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);

  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 8, 'the originating organization sees all eight of its observations');

  SELECT airs.observation_precision(obs) INTO pol;
  PERFORM pg_temp.ok(pol = 'exact', 'the originating organization resolves exact precision');
  SELECT public.ST_AsGeoJSON(airs.apply_precision(geom, airs.observation_precision(id)))
    INTO g FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(g LIKE '%-73.75623%' AND g LIKE '%42.65187%',
    'the originating organization receives the exact coordinates it recorded');

  SELECT airs.observation_profile(obs) INTO prof;
  PERFORM pg_temp.ok(prof = 'full', 'the originating organization holds the full disclosure profile');

  SELECT reporter_identity INTO ident FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(ident = 'Jane Q. Reporter',
    'restricted source identity is readable by the originating organization');

  SELECT airs.observation_freshness(observation_type, observed_at, visible_until)
    INTO fresh FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(fresh = 'current',
    'a two-minute-old UAS report resolves as current on the server clock');

  UPDATE airs.observations SET urgency = 'immediate' WHERE id = obs;
  PERFORM pg_temp.ok(FOUND, 'the originating organization can update its own observation');
END $$;

-- ===========================================================================
-- E. Ownership is immutable and cannot be supplied by a client
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET org_id = '%s' WHERE id = '%s'$q$, org_b, obs),
    'a browser-supplied owner value cannot move an observation to another tenant');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observations (org_id, observation_type, title, location_kind, source_type)
       VALUES ('%s','other_observation','planted','none','other_source')$q$, org_b),
    'an organization cannot create an observation owned by another organization');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET reported_at = now() - interval '1 day' WHERE id = '%s'$q$, obs),
    'the original report timestamp cannot be rewritten');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET created_by_account = NULL WHERE id = '%s'$q$, obs),
    'the original reporting account cannot be erased');
END $$;

-- ===========================================================================
-- F. Partner plane — read
-- ===========================================================================
DO $$
DECLARE
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  wh    uuid := (SELECT v FROM aids WHERE k='obs_withheld');
  un    uuid := (SELECT v FROM aids WHERE k='obs_unshared');
  ex    uuid := (SELECT v FROM aids WHERE k='obs_expired');
  pol text; g text; n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);

  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = obs) = 1,
    'an explicitly shared observation is visible to the authorized partner');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = un) = 0,
    'an unshared observation is invisible to the partner even by known id');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = ex) = 0,
    'an observation whose visibility window has closed is invisible to the partner');

  SELECT airs.observation_precision(obs) INTO pol;
  PERFORM pg_temp.ok(pol = 'area_only',
    'the partner precision is the profile ceiling, not the declared exact policy');
  SELECT public.ST_AsGeoJSON(airs.apply_precision(geom, airs.observation_precision(id)))
    INTO g FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(g NOT LIKE '%-73.75623%' AND g NOT LIKE '%42.65187%',
    'the reduced-precision partner geometry contains no exact coordinate value');
  PERFORM pg_temp.ok(g LIKE '%Polygon%',
    'the partner receives an envelope rather than the reported point');

  SELECT airs.observation_precision(wh) INTO pol;
  PERFORM pg_temp.ok(pol = 'withheld', 'a withheld observation resolves as withheld for the partner');
  SELECT public.ST_AsGeoJSON(airs.apply_precision(geom, airs.observation_precision(id)))
    INTO g FROM airs.observations WHERE id = wh;
  PERFORM pg_temp.ok(g IS NULL, 'a withheld observation returns no geometry at all');

  SELECT count(*) INTO n FROM airs.observation_information_gaps;
  PERFORM pg_temp.ok(n = 0, 'information gaps never leave the originating organization');

  SELECT count(*) INTO n FROM airs.observation_annotations;
  PERFORM pg_temp.ok(n = 0, 'internal annotations never leave the originating organization');

  SELECT count(*) INTO n FROM airs.observation_evidence_references;
  PERFORM pg_temp.ok(n = 1,
    'the partner learns that a shared evidence reference exists');
END $$;

-- ===========================================================================
-- G. Partner plane — write attempts all fail
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  org_c uuid := (SELECT v FROM aids WHERE k='org_c');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  room  uuid := (SELECT v FROM aids WHERE k='room');
  gap   uuid := (SELECT v FROM aids WHERE k='gap');
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);

  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = obs) = 1,
    'the partner can still read the observation it is about to fail to modify');

  UPDATE airs.observations SET title = 'hijacked' WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot modify an originating-agency observation');

  UPDATE airs.observations SET verification_status = 'confirmed' WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot change verification status');

  UPDATE airs.observations SET source_reliability = 'highly_reliable' WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot alter source reliability');

  UPDATE airs.observations SET information_credibility = 'confirmed', confidence_level = 'very_high'
   WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot alter credibility or reviewer confidence');

  UPDATE airs.observations
     SET geom = public.ST_SetSRID(public.ST_MakePoint(-73.0, 42.0), 4326) WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot edit foreign geometry');

  UPDATE airs.observations SET precision_policy = 'exact' WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot increase geographic precision');

  UPDATE airs.observations SET disclosure_profile = 'full' WHERE id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot widen the disclosure profile');

  UPDATE airs.observation_shares SET disclosure_profile = 'full', precision_policy = 'exact'
   WHERE observation_id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot rewrite the share that governs its own access');

  UPDATE airs.observation_information_gaps SET status = 'resolved', resolved_at = now()
   WHERE id = gap;
  PERFORM pg_temp.ok(NOT FOUND, 'a partner cannot alter another agency information gap');

  -- Onward sharing: refused at the database, not merely in the service layer.
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_shares
         (org_id, observation_id, partner_org_id, incident_id)
       VALUES ('%s','%s','%s','%s')$q$, org_b, obs, org_c, room),
    'a receiving organization cannot share an observation onward');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_annotations
         (org_id, observation_id, annotation_type, body)
       VALUES ('%s','%s','review_note','partner note')$q$, org_b, obs),
    'a partner cannot append an annotation to a foreign observation');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_relationships
         (org_id, observation_id, related_observation_id, relationship)
       VALUES ('%s','%s','%s','supports')$q$, org_b, obs,
       (SELECT v FROM aids WHERE k='obs_second')),
    'a partner cannot attach a relationship to a foreign observation');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_evidence_references
         (org_id, observation_id, reference_type, display_name)
       VALUES ('%s','%s','document','partner evidence')$q$, org_b, obs),
    'a partner cannot attach evidence to a foreign observation');
END $$;

-- ===========================================================================
-- H. Unrelated organization sees nothing
-- ===========================================================================
DO $$
DECLARE
  org_c uuid := (SELECT v FROM aids WHERE k='org_c');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_c::text, true);
  SELECT count(*) INTO n FROM airs.observations;
  PERFORM pg_temp.ok(n = 0, 'an unrelated organization sees no observations at all');
  SELECT count(*) INTO n FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(n = 0, 'a known observation id does not bypass row-level security');
  SELECT count(*) INTO n FROM airs.observation_shares;
  PERFORM pg_temp.ok(n = 0, 'an unrelated organization sees no observation shares');
  SELECT count(*) INTO n FROM airs.observation_evidence_references;
  PERFORM pg_temp.ok(n = 0, 'an unrelated organization sees no evidence references');
  PERFORM pg_temp.ok(airs.has_observation_access(obs) IS FALSE,
    'the access helper denies an unrelated organization');
  PERFORM pg_temp.ok(airs.observation_profile(obs) = 'summary',
    'the disclosure helper defaults an unrelated organization to summary');
END $$;

-- ===========================================================================
-- I. Evidence-reference constraints
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  INSERT INTO airs.observation_evidence_references
       (org_id, observation_id, reference_type, display_name, reference_value)
       VALUES (org_a, obs, 'document', 'HTTPS reference', 'https://records.example.gov/case/4417');
  PERFORM pg_temp.ok(FOUND, 'an https evidence locator is accepted');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_evidence_references
         (org_id, observation_id, reference_type, display_name, reference_value)
       VALUES ('%s','%s','document','local file','file:///var/evidence/clip.mp4')$q$, org_a, obs),
    'a file: evidence reference is rejected');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observation_evidence_references
         (org_id, observation_id, reference_type, display_name, reference_value)
       VALUES ('%s','%s','document','insecure','http://records.example.gov/case/4417')$q$, org_a, obs),
    'a non-HTTPS external evidence URL is rejected');
END $$;

-- ===========================================================================
-- J. Verification and lifecycle rules
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  acct  uuid := (SELECT v FROM aids WHERE k='acct_a');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_second');
  closed uuid := (SELECT v FROM aids WHERE k='obs_closed');
  status text; body text; note_body text; n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);

  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET verification_status = 'confirmed' WHERE id = '%s'$q$, obs),
    'a verification decision without a recorded verifier is rejected');

  UPDATE airs.observations
     SET verification_status = 'confirmed', verified_at = now(), verified_by_account = acct,
         reviewed_at = now(), reviewed_by_account = acct
   WHERE id = obs;
  SELECT verification_status INTO status FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(status = 'confirmed', 'an authorized verifier can confirm an observation');

  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET verification_status = 'not_a_status' WHERE id = '%s'$q$, obs),
    'an invalid verification value is rejected');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET source_reliability = 'extremely_reliable' WHERE id = '%s'$q$, obs),
    'an invalid controlled reliability value is rejected');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET information_credibility = 'certain' WHERE id = '%s'$q$, obs),
    'an invalid controlled credibility value is rejected');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET confidence_level = 'absolute' WHERE id = '%s'$q$, obs),
    'an invalid controlled confidence value is rejected');

  -- The original report content survives review untouched.
  SELECT title INTO body FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(body = 'Second report, same aircraft',
    'the original report content is preserved through verification');

  -- Closure is auditable: who and when are mandatory and retained.
  SELECT count(*) INTO n FROM airs.observations
   WHERE id = closed AND closed_at IS NOT NULL AND closed_by_account IS NOT NULL;
  PERFORM pg_temp.ok(n = 1, 'a closed observation records who closed it and when');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observations SET closed_at = NULL WHERE id = '%s'$q$, closed),
    'closure bookkeeping cannot be erased from a closed observation');

  -- Annotations are append-only evidence of the review trail.
  INSERT INTO airs.observation_annotations
       (org_id, observation_id, annotation_type, body, author_account)
       VALUES (org_a, obs, 'reviewer_assessment', 'Confirmed against the second report.', acct);
  -- Append-only is enforced twice: no UPDATE policy grants a row to rewrite,
  -- and the trigger refuses even if one ever did.
  UPDATE airs.observation_annotations SET body = 'rewritten' WHERE observation_id = obs;
  PERFORM pg_temp.ok(NOT FOUND, 'no row-level policy exposes an annotation for rewriting');
  SELECT a.body INTO note_body FROM airs.observation_annotations a WHERE a.observation_id = obs;
  PERFORM pg_temp.ok(note_body = 'Confirmed against the second report.',
    'the reviewer annotation text is unchanged');
  PERFORM pg_temp.denied(format(
    $q$DELETE FROM airs.observation_annotations WHERE observation_id = '%s'$q$, obs),
    'a reviewer annotation cannot be deleted');
END $$;

-- ===========================================================================
-- K. Freshness is a clock outcome, not a lifecycle outcome
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  ex    uuid := (SELECT v FROM aids WHERE k='obs_expired');
  life text; fresh text;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT lifecycle_status,
         airs.observation_freshness(observation_type, observed_at, visible_until)
    INTO life, fresh FROM airs.observations WHERE id = ex;
  PERFORM pg_temp.ok(life = 'open', 'the probe observation is still lifecycle-open');
  PERFORM pg_temp.ok(fresh = 'expired',
    'an observation past its visibility window does not appear current merely because it is open');

  PERFORM pg_temp.ok(
    airs.observation_freshness('unidentified_aircraft', now() - interval '3 minutes', NULL) = 'current',
    'a three-minute-old unidentified-aircraft report is current');
  PERFORM pg_temp.ok(
    airs.observation_freshness('unidentified_aircraft', now() - interval '10 minutes', NULL) = 'recent',
    'a ten-minute-old unidentified-aircraft report is recent');
  PERFORM pg_temp.ok(
    airs.observation_freshness('unidentified_aircraft', now() - interval '30 minutes', NULL) = 'aging',
    'a thirty-minute-old unidentified-aircraft report is aging');
  PERFORM pg_temp.ok(
    airs.observation_freshness('unidentified_aircraft', now() - interval '5 hours', NULL) = 'stale',
    'a five-hour-old unidentified-aircraft report is stale');
  PERFORM pg_temp.ok(
    airs.observation_freshness('unidentified_aircraft', NULL, NULL) = 'unknown',
    'an unknown observed time resolves as unknown, never as current');
END $$;

-- ===========================================================================
-- L. Incident scoping
-- ===========================================================================
DO $$
DECLARE
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  part uuid := (SELECT v FROM aids WHERE k='obs_participating');
  n int;
BEGIN
  -- A partner reaches a participating_orgs observation through live incident
  -- participation alone; that is an incident-scoped grant, not a tenant grant.
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id = part;
  PERFORM pg_temp.ok(n = 1, 'incident participation grants access to a participating-orgs observation');
END $$;

RESET ROLE;
UPDATE airs.incident_rooms SET status = 'closed', closed_at = now()
 WHERE id = (SELECT v FROM aids WHERE k='closed_room');
SET ROLE airs_app;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  closed_room uuid := (SELECT v FROM aids WHERE k='closed_room');
  probe uuid;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.observations
         (org_id, incident_id, observation_type, title, location_kind, source_type)
       VALUES ('%s','%s','other_observation','too late','none','other_source')$q$,
    org_a, closed_room),
    'a closed incident room rejects a new incident-scoped observation');

  -- A share scoped to a room that is already closed conveys nothing, because
  -- the entitlement is re-evaluated against live incident access on every read.
  SELECT v INTO probe FROM aids WHERE k='obs_unshared';
  UPDATE airs.observations SET classification = 'participating_orgs' WHERE id = probe;
  INSERT INTO airs.observation_shares
       (org_id, observation_id, partner_org_id, incident_id, disclosure_profile,
        precision_policy)
       VALUES (org_a, probe, org_b, closed_room, 'operational', 'generalized');

  PERFORM set_config('airs.org_id', org_b::text, true);
  PERFORM pg_temp.ok(airs.has_incident_access(closed_room) IS FALSE,
    'a closed incident room grants a former participant no incident access');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.observations WHERE id = probe) = 0,
    'a share scoped to a closed incident room conveys no access');
END $$;

-- ===========================================================================
-- M. Share expiry, revocation and incident closure end access immediately
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  expiring uuid := (SELECT v FROM aids WHERE k='obs_expiring');
  sh uuid := (SELECT v FROM aids WHERE k='share_expiring');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id = expiring;
  PERFORM pg_temp.ok(n = 1, 'a live time-limited share is visible before it expires');

  -- Move the expiry into the past. Nothing else changes: no sweep runs, no
  -- status column is rewritten. Access must end on the read path alone.
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.observation_shares SET expires_at = now() - interval '1 minute' WHERE id = sh;

  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id = expiring;
  PERFORM pg_temp.ok(n = 0, 'a lapsed share removes partner access with no sweep having run');
  PERFORM pg_temp.ok((SELECT status FROM airs.observation_shares WHERE id = sh) = 'active',
    'access ended on the read path even though the share row still reads active');
END $$;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  share uuid := (SELECT v FROM aids WHERE k='share_live');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.observation_shares SET status = 'revoked', revoked_at = now() WHERE id = share;
  -- The observation is still classified participating_orgs in a live room, so
  -- revoking the explicit share must not be mistaken for total removal; narrow
  -- the classification and prove the partner then has nothing.
  UPDATE airs.observations SET classification = 'originating_org_only' WHERE id = obs;

  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(n = 0, 'revoking a share removes partner access immediately');
  PERFORM pg_temp.ok(airs.has_observation_access(obs) IS FALSE,
    'the access helper agrees the revoked share grants nothing');

  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.observation_shares SET status = 'active', revoked_at = NULL WHERE id = '%s'$q$,
    share),
    'a revoked observation share cannot be restored');
END $$;

DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  room  uuid := (SELECT v FROM aids WHERE k='room');
  r record;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT * INTO r FROM airs.terminate_incident_observations(room);
  PERFORM pg_temp.ok(r.shares_revoked >= 1,
    'incident closure revokes every share scoped to the room');
  PERFORM pg_temp.ok(r.observations_closed >= 1,
    'incident closure closes every still-open observation filed into the room');
END $$;

RESET ROLE;
UPDATE airs.incident_rooms SET status = 'closed', closed_at = now()
 WHERE id = (SELECT v FROM aids WHERE k='room');
SET ROLE airs_app;

DO $$
DECLARE
  org_b uuid := (SELECT v FROM aids WHERE k='org_b');
  part  uuid := (SELECT v FROM aids WHERE k='obs_participating');
  wh    uuid := (SELECT v FROM aids WHERE k='obs_withheld');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id IN (part, wh);
  PERFORM pg_temp.ok(n = 0, 'closing the incident removes every temporary partner entitlement');
  PERFORM pg_temp.ok(airs.has_observation_access(part) IS FALSE,
    'the access helper denies the partner after incident closure');

  -- Reauthenticating (a fresh identity context) restores nothing.
  PERFORM set_config('airs.account_id', '', true);
  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.observations WHERE id IN (part, wh);
  PERFORM pg_temp.ok(n = 0, 'reauthentication does not restore access removed by closure');
END $$;

-- ===========================================================================
-- N. The owner record itself survives everything above
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM aids WHERE k='org_a');
  obs   uuid := (SELECT v FROM aids WHERE k='obs_exact');
  t text; d text; ident text; life text;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT title, description, reporter_identity, lifecycle_status
    INTO t, d, ident, life FROM airs.observations WHERE id = obs;
  PERFORM pg_temp.ok(t = 'Small quadcopter over the perimeter',
    'the original report title is unchanged after every partner attempt');
  PERFORM pg_temp.ok(d LIKE 'Observed hovering%',
    'the original report narrative is unchanged after every partner attempt');
  PERFORM pg_temp.ok(ident = 'Jane Q. Reporter',
    'the restricted reporter identity is unchanged and still owner-only');
  PERFORM pg_temp.ok(life = 'closed',
    'the observation was closed by incident closure, not deleted');
END $$;

RESET ROLE;
ROLLBACK;
