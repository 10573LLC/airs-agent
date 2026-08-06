-- AIRS Agent - existing-database adoption verification.
--
-- Executed ONLY by `npm run db:migrate:adopt` (or `-- --adopt-existing`).
-- It executes no migration SQL and changes nothing; every check raises and
-- aborts the surrounding transaction on the first failure, so adoption can
-- never record migration rows for a partially migrated or drifted database.
\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text;
  n int;
BEGIN
  -- 1. Ledger must be empty or absent -------------------------------------
  IF to_regclass('airs_migrations.applied_migrations') IS NOT NULL THEN
    SELECT count(*) INTO n FROM airs_migrations.applied_migrations;
    IF n > 0 THEN
      RAISE EXCEPTION 'ADOPT FAIL: migration ledger already contains % row(s); adoption is not required', n;
    END IF;
  END IF;

  -- 2. Target must be an existing AIRS Agent database ----------------------
  IF to_regclass('airs.organizations') IS NULL THEN
    RAISE EXCEPTION 'ADOPT FAIL: airs.organizations is absent; this is not an existing AIRS Agent database';
  END IF;

  -- 3/4. Core schemas, tables, functions, roles and RLS through 0012 -------
  FOREACH missing IN ARRAY ARRAY[
    'airs.organizations','airs.users','airs.memberships','airs.roles','airs.permissions',
    'airs.role_permissions','airs.audit_events','airs.sessions','airs.invitations',
    'airs.incidents','airs.incident_participants','airs.aircraft','airs.vehicles',
    'airs.sensors','airs.personnel','airs.incident_assignments','airs.disclosure_profiles',
    'airs.map_features','airs.operating_areas','airs.asset_locations','airs.observations'
  ] LOOP
    IF to_regclass(missing) IS NULL THEN
      RAISE EXCEPTION 'ADOPT FAIL: required table % is missing', missing;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid = missing::regclass AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'ADOPT FAIL: row-level security is not enabled on %', missing;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE (schemaname || '.' || tablename) = missing) THEN
      RAISE EXCEPTION 'ADOPT FAIL: no RLS policy exists on %', missing;
    END IF;
  END LOOP;

  FOREACH missing IN ARRAY ARRAY[
    'airs.current_org_id','airs.current_user_id','airs.has_permission',
    'airs.expire_incident_state','airs.terminate_incident_observations'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname || '.' || p.proname = missing
    ) THEN
      RAISE EXCEPTION 'ADOPT FAIL: required function % is missing', missing;
    END IF;
  END LOOP;

  FOREACH missing IN ARRAY ARRAY['airs_app','airs_maintenance'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = missing) THEN
      RAISE EXCEPTION 'ADOPT FAIL: required database role % is missing', missing;
    END IF;
  END LOOP;

  -- 5. Exact platform organization values ----------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM airs.organizations
     WHERE slug = 'anconison-platform'
       AND name = 'Anconison - AIRS Agent Platform'
       AND org_kind = 'platform'
  ) THEN
    RAISE EXCEPTION 'ADOPT FAIL: platform organization slug/name/org_kind does not match the expected state through migration 0012';
  END IF;

  -- 6. platform_admin stays out of agency operations ------------------------
  IF (SELECT count(*) FROM airs.role_permissions WHERE role_key = 'platform_admin') <> 4 THEN
    RAISE EXCEPTION 'ADOPT FAIL: platform_admin permission set has drifted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM airs.role_permissions
     WHERE role_key = 'platform_admin'
       AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%'
         OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%'
         OR permission_key LIKE 'airspace.%' OR permission_key LIKE 'personnel.%')
  ) THEN
    RAISE EXCEPTION 'ADOPT FAIL: platform_admin holds operational permissions';
  END IF;

  -- 7. Albany demo organizations remain agency tenants ----------------------
  IF NOT EXISTS (SELECT 1 FROM airs.organizations
                  WHERE name = 'Albany Police Department' AND org_kind = 'agency') THEN
    RAISE EXCEPTION 'ADOPT FAIL: Albany Police Department is not an agency tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM airs.organizations
                  WHERE name = 'Albany County' AND org_kind = 'agency') THEN
    RAISE EXCEPTION 'ADOPT FAIL: Albany County is not an agency tenant';
  END IF;

  -- 8. Role parity ----------------------------------------------------------
  IF (SELECT count(*) FROM airs.roles) <> 10
     OR (SELECT count(*) FROM airs.permissions) <> 56
     OR (SELECT count(*) FROM airs.role_permissions) <> 175 THEN
    RAISE EXCEPTION 'ADOPT FAIL: role parity mismatch (expected 10 roles / 56 permissions / 175 grants)';
  END IF;

  RAISE NOTICE 'ok  existing AIRS Agent database verified through migration 0012';
END $$;