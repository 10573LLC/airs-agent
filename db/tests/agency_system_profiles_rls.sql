-- AIRS Agent — Agency Systems Profile forced-RLS proof.
-- Run against a database with migrations through 0013 applied.
-- All fixtures are rolled back.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'SYSTEMS-RLS FAIL: %', label; END IF;
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
  RAISE EXCEPTION 'SYSTEMS-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

CREATE TEMP TABLE sys_ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON sys_ids TO airs_app;
DO $$
DECLARE
  org_a uuid := gen_random_uuid();
  org_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO airs.organizations (id, slug, name, agency_type)
  VALUES
    (org_a, 'systems-profile-a', 'Systems Profile Agency A', 'law_enforcement'),
    (org_b, 'systems-profile-b', 'Systems Profile Agency B', 'fire');

  INSERT INTO airs.agency_system_profiles (org_id)
  VALUES (org_a), (org_b);

  INSERT INTO airs.agency_system_ecosystems (org_id, ecosystem_id, usage_status)
  VALUES
    (org_a, 'axon', 'in_use'),
    (org_b, 'motorola_solutions', 'planned');

  INSERT INTO airs.agency_system_components (org_id, component_id, usage_status)
  VALUES
    (org_a, 'axon_fusus_real_time_operations', 'in_use'),
    (org_b, 'motorola_cape', 'planned');

  INSERT INTO sys_ids VALUES ('org_a', org_a), ('org_b', org_b);
END $$;

SET ROLE airs_app;
DO $$
DECLARE
  org_a uuid := (SELECT v FROM sys_ids WHERE k='org_a');
  org_b uuid := (SELECT v FROM sys_ids WHERE k='org_b');
  n int;
BEGIN
  PERFORM pg_temp.ok(NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
    'application role is neither superuser nor BYPASSRLS');

  PERFORM set_config('airs.org_id', '', true);
  SELECT count(*) INTO n FROM airs.agency_system_profiles;
  PERFORM pg_temp.ok(n = 0, 'no org context sees no systems profiles');
  SELECT count(*) INTO n FROM airs.agency_system_ecosystems;
  PERFORM pg_temp.ok(n = 0, 'no org context sees no ecosystems');
  SELECT count(*) INTO n FROM airs.agency_system_components;
  PERFORM pg_temp.ok(n = 0, 'no org context sees no components');

  PERFORM set_config('airs.org_id', org_a::text, true);
  SELECT count(*) INTO n FROM airs.agency_system_profiles WHERE org_id = org_a;
  PERFORM pg_temp.ok(n = 1, 'agency sees its own systems profile');
  SELECT count(*) INTO n FROM airs.agency_system_ecosystems WHERE ecosystem_id = 'axon';
  PERFORM pg_temp.ok(n = 1, 'agency sees its own confirmed ecosystem');
  SELECT count(*) INTO n FROM airs.agency_system_components WHERE component_id = 'axon_fusus_real_time_operations';
  PERFORM pg_temp.ok(n = 1, 'agency sees its own confirmed component');
  SELECT count(*) INTO n FROM airs.agency_system_profiles WHERE org_id = org_b;
  PERFORM pg_temp.ok(n = 0, 'agency cannot see another systems profile');
  SELECT count(*) INTO n FROM airs.agency_system_ecosystems WHERE org_id = org_b;
  PERFORM pg_temp.ok(n = 0, 'agency cannot see another ecosystem selection');
  SELECT count(*) INTO n FROM airs.agency_system_components WHERE org_id = org_b;
  PERFORM pg_temp.ok(n = 0, 'agency cannot see another component selection');

  UPDATE airs.agency_system_ecosystems
     SET usage_status = 'in_use' WHERE org_id = org_b;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'agency cannot update another ecosystem selection');

  DELETE FROM airs.agency_system_components WHERE org_id = org_b;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'agency cannot delete another component selection');

  PERFORM pg_temp.denied(
    format('INSERT INTO airs.agency_system_components (org_id, component_id) VALUES (%L, %L)',
      org_b, 'attempted_cross_tenant_component'),
    'agency cannot insert a component for another tenant');

  INSERT INTO airs.agency_system_components (org_id, component_id)
  VALUES (org_a, 'axon_dedrone_airspace_security');
  PERFORM pg_temp.ok(FOUND, 'agency may confirm a component for itself');
END $$;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.columns
  WHERE table_schema = 'airs'
    AND table_name IN ('agency_system_profiles','agency_system_ecosystems','agency_system_components')
    AND lower(column_name) ~ '(credential|secret|token|api.?key|authoriz|data.?access|connect)';
  PERFORM pg_temp.ok(n = 0,
    'systems profile tables store no connector credentials, authorization, connection, or data-access fields');
END $$;

RESET ROLE;
ROLLBACK;
