-- AIRS Agent — Stage 7 common operating picture: forced-RLS + precision proof.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/map_geography_rls.sql
--
-- Fixtures are created by the owner role; every ASSERTION runs as the
-- unprivileged airs_app role under FORCE ROW LEVEL SECURITY. Everything is
-- rolled back, so the script leaves no rows behind.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'MAP-RLS FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'MAP-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE mids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON mids TO airs_app;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  org_c uuid := gen_random_uuid();                        -- unrelated agency
  room  uuid; view_room uuid; closed_room uuid;
  ac uuid; site uuid;
  feat uuid; org_feat uuid; area uuid;
  fixed_loc uuid; temp_loc uuid; stale_loc uuid;
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type)
       VALUES (org_c, 'test-map-outsider', 'Map Outsider Agency', 'law_enforcement');

  -- room with an OPERATIONAL partner, a room with a VIEW_ONLY partner, and a closed room
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'COP proof room', 'critical_incident', 'active') RETURNING id INTO room;
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'COP view-only room', 'critical_incident', 'active') RETURNING id INTO view_room;
  INSERT INTO airs.incident_rooms (org_id, name, incident_type, status)
       VALUES (org_a, 'COP closed room', 'critical_incident', 'active') RETURNING id INTO closed_room;

  INSERT INTO airs.incident_participants
       (incident_id, org_id, partner_org_id, invited_by_org_id, access_level,
        invitation_status, participation_status, requires_approval,
        invitation_expires_at, accepted_at, approved_at)
       VALUES (room, org_a, org_b, org_a, 'incident_command', 'accepted', 'active', false,
               now() + interval '2 days', now(), now()),
              (view_room, org_a, org_b, org_a, 'view_only', 'accepted', 'active', false,
               now() + interval '2 days', now(), now()),
              (closed_room, org_a, org_b, org_a, 'incident_command', 'accepted', 'active', false,
               now() + interval '2 days', now(), now());

  INSERT INTO airs.resources (org_id, category, display_name, callsign, readiness_status)
       VALUES (org_a, 'aircraft', 'COP Air-1', 'COPAIR1', 'available') RETURNING id INTO ac;
  INSERT INTO airs.resources (org_id, category, display_name, readiness_status)
       VALUES (org_a, 'launch_site', 'COP Launch North', 'available') RETURNING id INTO site;

  -- geography owned by org A
  INSERT INTO airs.map_features (org_id, incident_id, feature_type, name, geom, precision_policy)
       VALUES (org_a, room, 'staging_area', 'Staging Alpha',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.7600 42.6520,-73.7580 42.6520,-73.7580 42.6535,-73.7600 42.6535,-73.7600 42.6520))'),4326),
               'exact')
    RETURNING id INTO feat;
  INSERT INTO airs.map_features (org_id, feature_type, name, geom, precision_policy)
       VALUES (org_a, 'command_post', 'Agency HQ (no room)',
               public.ST_SetSRID(public.ST_MakePoint(-73.7565, 42.6512), 4326), 'exact')
    RETURNING id INTO org_feat;

  INSERT INTO airs.operating_areas
       (org_id, incident_id, name, area, altitude_floor_ft, altitude_ceiling_ft, status,
        approved_at, precision_policy)
       VALUES (org_a, room, 'OA Bravo',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.7700 42.6400,-73.7500 42.6400,-73.7500 42.6600,-73.7700 42.6600,-73.7700 42.6400))'),4326),
               0, 400, 'active', now(), 'exact')
    RETURNING id INTO area;

  INSERT INTO airs.resource_locations
       (org_id, resource_id, location_kind, geom, precision_policy, reported_at)
       VALUES (org_a, site, 'fixed',
               public.ST_SetSRID(public.ST_MakePoint(-73.75123456, 42.65123456), 4326),
               'exact', now())
    RETURNING id INTO fixed_loc;
  INSERT INTO airs.resource_locations
       (org_id, resource_id, incident_id, location_kind, geom, precision_policy,
        reported_at, expires_at)
       VALUES (org_a, ac, room, 'temporary',
               public.ST_SetSRID(public.ST_MakePoint(-73.75987654, 42.65987654), 4326),
               'exact', now(), now() + interval '4 hours')
    RETURNING id INTO temp_loc;

  -- a share so org B can reach the aircraft position at all
  INSERT INTO airs.resource_shares
       (org_id, resource_id, incident_id, classification, disclosure_profile)
       VALUES (org_a, ac, room, 'participating_orgs', 'incident_command');
  INSERT INTO airs.resource_shares
       (org_id, resource_id, incident_id, classification, disclosure_profile)
       VALUES (org_a, site, room, 'participating_orgs', 'operational');

  INSERT INTO mids VALUES ('org_a',org_a),('org_b',org_b),('org_c',org_c),
                          ('room',room),('view_room',view_room),('closed_room',closed_room),
                          ('ac',ac),('site',site),('feat',feat),('org_feat',org_feat),
                          ('area',area),('fixed_loc',fixed_loc),('temp_loc',temp_loc);
END $$;

SET ROLE airs_app;

-- ===========================================================================
-- A. Owner plane
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM mids WHERE k='org_a');
  room  uuid := (SELECT v FROM mids WHERE k='room');
  n int; g text; pol text;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);

  SELECT count(*) INTO n FROM airs.map_features;
  PERFORM pg_temp.ok(n = 2, 'owner sees both of its map features');

  SELECT count(*) INTO n FROM airs.operating_areas;
  PERFORM pg_temp.ok(n = 1, 'owner sees its operating area');

  SELECT count(*) INTO n FROM airs.resource_locations;
  PERFORM pg_temp.ok(n = 2, 'owner sees both of its recorded positions');

  SELECT airs.resolve_precision('exact', airs.incident_geo_profile(room), true) INTO pol;
  PERFORM pg_temp.ok(pol = 'exact', 'owner precision resolves to exact');

  SELECT airs.incident_geo_profile(room) INTO pol;
  PERFORM pg_temp.ok(pol = 'full', 'room owner geography profile is full');

  SELECT public.ST_AsGeoJSON(airs.apply_precision(geom, 'exact')) INTO g
    FROM airs.resource_locations WHERE location_kind = 'fixed';
  PERFORM pg_temp.ok(g LIKE '%-73.75123456%', 'owner receives the unrounded coordinate');

  PERFORM pg_temp.ok(public.ST_SRID(geom) = 4326, 'stored geometry is SRID 4326')
    FROM airs.map_features LIMIT 1;
END $$;

-- ===========================================================================
-- B. Precision arithmetic (default deny, narrower always wins)
-- ===========================================================================
DO $$
DECLARE p text; g public.geometry;
BEGIN
  PERFORM pg_temp.ok(airs.resolve_precision('exact','summary',false) = 'withheld',
                     'summary profile withholds geography however precise the declaration');
  PERFORM pg_temp.ok(airs.resolve_precision('exact','operational',false) = 'area_only',
                     'operational profile is capped at general area');
  PERFORM pg_temp.ok(airs.resolve_precision('exact','aviation',false) = 'approximate',
                     'aviation profile is capped at ~100 m');
  PERFORM pg_temp.ok(airs.resolve_precision('exact','incident_command',false) = 'exact',
                     'incident-command profile may receive exact geography');
  PERFORM pg_temp.ok(airs.resolve_precision('generalized','incident_command',false) = 'generalized',
                     'a narrow owner declaration is never widened by the profile');
  PERFORM pg_temp.ok(airs.resolve_precision('withheld','full',false) = 'withheld',
                     'an owner may withhold geography from a full-authorized reader');
  PERFORM pg_temp.ok(airs.resolve_precision('not_a_policy','full',false) = 'withheld',
                     'an unknown precision policy fails closed');
  PERFORM pg_temp.ok(airs.resolve_precision('exact','not_a_profile',false) = 'withheld',
                     'an unknown disclosure profile fails closed');

  PERFORM pg_temp.ok(airs.apply_precision(
    public.ST_SetSRID(public.ST_MakePoint(-73.75123456,42.65123456),4326), 'withheld') IS NULL,
    'withheld yields no geometry at all');

  SELECT airs.apply_precision(
    public.ST_SetSRID(public.ST_MakePoint(-73.75123456,42.65123456),4326), 'approximate') INTO g;
  PERFORM pg_temp.ok(abs(public.ST_X(g) - (-73.751)) < 1e-9,
                     'approximate rounds longitude to ~100 m');
  PERFORM pg_temp.ok(abs(public.ST_Y(g) - 42.651) < 1e-9,
                     'approximate rounds latitude to ~100 m');

  SELECT airs.apply_precision(
    public.ST_SetSRID(public.ST_MakePoint(-73.75123456,42.65123456),4326), 'generalized') INTO g;
  PERFORM pg_temp.ok(abs(public.ST_X(g) - (-73.75)) < 1e-9, 'generalized rounds to ~1 km');

  SELECT airs.apply_precision(
    public.ST_SetSRID(public.ST_MakePoint(-73.75123456,42.65123456),4326), 'area_only') INTO g;
  PERFORM pg_temp.ok(public.ST_GeometryType(g) = 'ST_Polygon',
                     'area_only never returns a point');
  PERFORM pg_temp.ok(public.ST_Area(g) > 0.001, 'area_only returns a deliberately coarse extent');
END $$;

-- ===========================================================================
-- C. Freshness is computed by the database clock
-- ===========================================================================
DO $$
BEGIN
  PERFORM pg_temp.ok(airs.location_freshness(now(), NULL) = 'fresh', 'a new report is fresh');
  PERFORM pg_temp.ok(airs.location_freshness(now() - interval '10 minutes', NULL) = 'recent',
                     'a 10 minute old report is recent');
  PERFORM pg_temp.ok(airs.location_freshness(now() - interval '30 minutes', NULL) = 'aging',
                     'a 30 minute old report is aging');
  PERFORM pg_temp.ok(airs.location_freshness(now() - interval '3 hours', NULL) = 'stale',
                     'a 3 hour old report is stale');
  PERFORM pg_temp.ok(
    airs.location_freshness(now() - interval '3 hours', now() - interval '1 hour') = 'expired',
    'a report past its validity window is expired');
  PERFORM pg_temp.ok(airs.location_freshness(NULL, NULL) = 'unknown',
                     'a missing report time is unknown, never fresh');
END $$;

-- ===========================================================================
-- D. Partner plane — row access
-- ===========================================================================
DO $$
DECLARE
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  org_c uuid := (SELECT v FROM mids WHERE k='org_c');
  room  uuid := (SELECT v FROM mids WHERE k='room');
  view_room uuid := (SELECT v FROM mids WHERE k='view_room');
  org_feat uuid := (SELECT v FROM mids WHERE k='org_feat');
  n int; pol text;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);

  SELECT count(*) INTO n FROM airs.map_features WHERE id = org_feat;
  PERFORM pg_temp.ok(n = 0, 'an organization-level feature in no room is invisible to a partner');

  SELECT count(*) INTO n FROM airs.map_features;
  PERFORM pg_temp.ok(n = 1, 'a live participant reaches only the feature placed in its room');

  SELECT count(*) INTO n FROM airs.operating_areas;
  PERFORM pg_temp.ok(n = 1, 'a live participant reaches the operating area of its room');

  SELECT airs.incident_geo_profile(room) INTO pol;
  PERFORM pg_temp.ok(pol = 'incident_command',
                     'incident-command access level maps to the incident-command profile');
  SELECT airs.incident_geo_profile(view_room) INTO pol;
  PERFORM pg_temp.ok(pol = 'summary', 'view-only access level maps to the summary profile');

  PERFORM set_config('airs.org_id', org_c::text, true);
  SELECT count(*) INTO n FROM airs.map_features;
  PERFORM pg_temp.ok(n = 0, 'an unrelated agency reaches no map feature');
  SELECT count(*) INTO n FROM airs.operating_areas;
  PERFORM pg_temp.ok(n = 0, 'an unrelated agency reaches no operating area');
  SELECT count(*) INTO n FROM airs.resource_locations;
  PERFORM pg_temp.ok(n = 0, 'an unrelated agency reaches no position');
  SELECT airs.incident_geo_profile(room) INTO pol;
  PERFORM pg_temp.ok(pol = 'summary', 'a non-participant gets the summary (withheld) profile');
END $$;

-- ===========================================================================
-- E. Partner plane — released geography is actually reduced
-- ===========================================================================
DO $$
DECLARE
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  ac  uuid := (SELECT v FROM mids WHERE k='ac');
  site uuid := (SELECT v FROM mids WHERE k='site');
  g text; pol text;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);

  -- aircraft: shared with the incident_command profile -> exact
  SELECT airs.resolve_precision(l.precision_policy,
           (SELECT d.profile FROM airs.effective_disclosure(l.resource_id) d LIMIT 1),
           l.org_id = org_b)
    INTO pol FROM airs.resource_locations l WHERE l.resource_id = ac;
  PERFORM pg_temp.ok(pol = 'exact',
                     'an incident-command share releases the exact aircraft position');

  -- launch site: shared with the operational profile -> area only
  SELECT airs.resolve_precision(l.precision_policy,
           (SELECT d.profile FROM airs.effective_disclosure(l.resource_id) d LIMIT 1),
           l.org_id = org_b)
    INTO pol FROM airs.resource_locations l WHERE l.resource_id = site;
  PERFORM pg_temp.ok(pol = 'area_only',
                     'an operational share releases the launch site as an area only');

  SELECT public.ST_AsGeoJSON(airs.apply_precision(l.geom, 'area_only')) INTO g
    FROM airs.resource_locations l WHERE l.resource_id = site;
  PERFORM pg_temp.ok(g NOT LIKE '%42.65123456%',
                     'the partner payload contains no unrounded launch-site coordinate');
  PERFORM pg_temp.ok(g LIKE '%Polygon%', 'the launch site is released as an extent, not a point');
END $$;

-- ===========================================================================
-- F. Partner writes are denied on every geographic table
-- ===========================================================================
DO $$
DECLARE
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  room  uuid := (SELECT v FROM mids WHERE k='room');
  ac    uuid := (SELECT v FROM mids WHERE k='ac');
  v_feat  uuid := (SELECT v FROM mids WHERE k='feat');
  v_area  uuid := (SELECT v FROM mids WHERE k='area');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.map_features (org_id, incident_id, feature_type, name, geom)
       VALUES ('%s','%s','hazard','Partner hazard',
               public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326))$q$,
    (SELECT v FROM mids WHERE k='org_a'), room),
    'a partner cannot create a feature owned by the room owner');

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.operating_areas (org_id, incident_id, name, area)
       VALUES ('%s','%s','Partner OA',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.76 42.64,-73.75 42.64,-73.75 42.65,-73.76 42.65,-73.76 42.64))'),4326))$q$,
    (SELECT v FROM mids WHERE k='org_a'), room),
    'a partner cannot define an operating v_area in a room it does not own');

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.resource_locations (org_id, resource_id, location_kind, geom)
       VALUES ('%s','%s','temporary', public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326))$q$,
    (SELECT v FROM mids WHERE k='org_a'), ac),
    'a partner cannot report a position for a resource it does not own');

  UPDATE airs.map_features SET name = 'Renamed by partner' WHERE id = v_feat;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'a partner update of a readable feature affects no row');

  UPDATE airs.operating_areas SET precision_policy = 'exact' WHERE id = v_area;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'a partner cannot widen the precision of a readable operating v_area');

  DELETE FROM airs.map_features WHERE id = v_feat;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'a partner cannot delete a readable feature');
END $$;

-- ===========================================================================
-- G. Ownership and lifecycle guards (owner role, still under forced RLS)
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM mids WHERE k='org_a');
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  room  uuid := (SELECT v FROM mids WHERE k='room');
  v_feat  uuid := (SELECT v FROM mids WHERE k='feat');
  v_area  uuid := (SELECT v FROM mids WHERE k='area');
  ac    uuid := (SELECT v FROM mids WHERE k='ac');
  site  uuid := (SELECT v FROM mids WHERE k='site');
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);

  PERFORM pg_temp.denied(format($q$UPDATE airs.map_features SET org_id='%s' WHERE id='%s'$q$,
                                org_b, v_feat),
                         'map feature ownership is immutable');
  PERFORM pg_temp.denied(format($q$UPDATE airs.operating_areas SET incident_id=gen_random_uuid()
                                    WHERE id='%s'$q$, v_area),
                         'an operating v_area cannot be moved to another room');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.operating_areas (org_id, incident_id, name, v_area, status)
       VALUES ('%s','%s','Unapproved but approved-state',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.76 42.64,-73.75 42.64,-73.75 42.65,-73.76 42.65,-73.76 42.64))'),4326),
               'approved')$q$, org_a, room),
    'an approved operating v_area must record its approval');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.operating_areas (org_id, incident_id, name, v_area,
                                         altitude_floor_ft, altitude_ceiling_ft, approved_at, status)
       VALUES ('%s','%s','Inverted block',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.76 42.64,-73.75 42.64,-73.75 42.65,-73.76 42.65,-73.76 42.64))'),4326),
               800, 400, now(), 'approved')$q$, org_a, room),
    'an altitude ceiling below the floor is rejected');
  PERFORM pg_temp.denied(format(
    $q$UPDATE airs.resource_locations
          SET geom = public.ST_SetSRID(public.ST_MakePoint(0,0),4326)
        WHERE resource_id='%s'$q$, site),
    'a recorded position is immutable evidence');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.resource_locations (org_id, resource_id, location_kind, geom)
       VALUES ('%s','%s','fixed', public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326))$q$,
    org_a, site),
    'a resource cannot hold two live fixed locations');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.resource_locations (org_id, resource_id, location_kind, geom, expires_at)
       VALUES ('%s','%s','fixed', public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326),
               now() + interval '1 hour')$q$, org_a, ac),
    'a fixed site cannot carry an expiry clock');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.map_features (org_id, feature_type, name, geom)
       VALUES ('%s','not_a_type','Bad type',
               public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326))$q$, org_a),
    'an unknown feature type is rejected');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.map_features (org_id, feature_type, name, geom, precision_policy)
       VALUES ('%s','hazard','Bad precision',
               public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326),'super_exact')$q$, org_a),
    'an unknown precision policy cannot be stored');
END $$;

-- ===========================================================================
-- H. Reference data cannot be widened by the application role
-- ===========================================================================
DO $$
BEGIN
  PERFORM pg_temp.denied(
    $q$UPDATE airs.disclosure_precisions SET policy='exact' WHERE profile='summary'$q$,
    'the application role cannot widen a profile precision ceiling');
  PERFORM pg_temp.denied(
    $q$INSERT INTO airs.geographic_precisions (policy, grid_deg, rank, label)
       VALUES ('ultra', NULL, 9, 'Ultra')$q$,
    'the application role cannot invent a precision policy');
END $$;

-- ===========================================================================
-- I. Closure ends geography as well as access
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM mids WHERE k='org_a');
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  room  uuid := (SELECT v FROM mids WHERE k='room');
  closed_room uuid := (SELECT v FROM mids WHERE k='closed_room');
  r record; n int;
BEGIN
  PERFORM set_config('airs.org_id', org_b::text, true);
  PERFORM pg_temp.denied(format($q$SELECT airs.terminate_incident_geography('%s')$q$, room),
                         'a partner cannot terminate the geography of a room it does not own');

  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT * INTO r FROM airs.terminate_incident_geography(room);
  PERFORM pg_temp.ok(r.areas_completed = 1, 'closure completes the live operating area');
  PERFORM pg_temp.ok(r.features_archived = 1, 'closure archives the incident map feature');
  PERFORM pg_temp.ok(r.positions_expired = 1, 'closure supersedes the temporary position');

  SELECT count(*) INTO n FROM airs.operating_areas
   WHERE incident_id = room AND status NOT IN ('completed','cancelled');
  PERFORM pg_temp.ok(n = 0, 'no live operating area survives closure');

  SELECT count(*) INTO n FROM airs.resource_locations
   WHERE incident_id = room AND superseded_at IS NULL;
  PERFORM pg_temp.ok(n = 0, 'no current incident position survives closure');

  -- the org-level feature is untouched: closure ends INCIDENT geography only
  SELECT count(*) INTO n FROM airs.map_features WHERE incident_id IS NULL AND status = 'active';
  PERFORM pg_temp.ok(n = 1, 'closure does not touch organization-level geography');

  -- running it again is a no-op
  SELECT * INTO r FROM airs.terminate_incident_geography(room);
  PERFORM pg_temp.ok(r.areas_completed = 0 AND r.features_archived = 0
                     AND r.positions_expired = 0, 'terminating twice changes nothing');

  -- a closed room refuses new geography
  UPDATE airs.incident_rooms SET status = 'closed', closed_at = now(),
         closure_reason = 'map proof' WHERE id = closed_room;
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.operating_areas (org_id, incident_id, name, area)
       VALUES ('%s','%s','Too late',
               public.ST_SetSRID(public.ST_GeomFromText(
                 'POLYGON((-73.76 42.64,-73.75 42.64,-73.75 42.65,-73.76 42.65,-73.76 42.64))'),4326))$q$,
    org_a, closed_room),
    'a closed room cannot accept a new operating area');
  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.map_features (org_id, incident_id, feature_type, name, geom)
       VALUES ('%s','%s','hazard','Too late',
               public.ST_SetSRID(public.ST_MakePoint(-73.75,42.65),4326))$q$,
    org_a, closed_room),
    'a closed room cannot accept a new map feature');
END $$;

-- ===========================================================================
-- J. Revoking the share ends the position, not just the record
-- ===========================================================================
DO $$
DECLARE
  org_a uuid := (SELECT v FROM mids WHERE k='org_a');
  org_b uuid := (SELECT v FROM mids WHERE k='org_b');
  ac    uuid := (SELECT v FROM mids WHERE k='ac');
  n int;
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);
  UPDATE airs.resource_shares SET revoked_at = now(), revocation_reason = 'proof'
   WHERE resource_id = ac AND revoked_at IS NULL;

  PERFORM set_config('airs.org_id', org_b::text, true);
  SELECT count(*) INTO n FROM airs.resource_locations WHERE resource_id = ac;
  PERFORM pg_temp.ok(n = 0, 'revoking the share removes the position row entirely');
END $$;

RESET ROLE;
ROLLBACK;
