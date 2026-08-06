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

  -- 3. Required tables ------------------------------------------------------
  -- Existence and RLS are SEPARATE invariants. This list is existence only.
  -- airs.roles, airs.permissions and airs.role_permissions are intentionally
  -- GLOBAL RBAC catalog tables: migration 0001 creates them outside its
  -- ENABLE/FORCE ROW LEVEL SECURITY loop and grants
  --   GRANT SELECT ON airs.roles, airs.permissions, airs.role_permissions TO airs_app;
  -- so they are globally readable reference data and MUST NOT be required to
  -- carry RLS or a policy. Other canonical reference tables
  -- (disclosure_fields, disclosure_precisions, disclosure_profile_fields,
  -- geographic_precisions, observation_freshness_thresholds,
  -- resource_category_statuses) are likewise non-RLS; their existence is
  -- covered by the canonical-object verification that runs before this file.
  FOREACH missing IN ARRAY ARRAY[
    -- tenant/identity tables (also RLS-verified in section 4)
    'airs.organizations','airs.users','airs.user_roles','airs.accounts','airs.memberships',
    'airs.sessions','airs.invitations','airs.audit_events','airs.retention_policies',
    'airs.incidents','airs.incident_shares','airs.aircraft','airs.airspace_operations',
    'airs.maintenance_events','airs.trusted_agencies','airs.incident_rooms',
    'airs.incident_participants','airs.resources','airs.resource_aircraft',
    'airs.resource_vehicles','airs.resource_docks','airs.resource_launch_sites',
    'airs.resource_sensors','airs.personnel_profiles','airs.qualifications','airs.shifts',
    'airs.resource_shares','airs.incident_assignments',
    'airs.map_features','airs.operating_areas','airs.resource_locations',
    'airs.observations','airs.observation_annotations','airs.observation_relationships',
    'airs.observation_information_gaps','airs.observation_evidence_references',
    'airs.observation_shares',
    -- global RBAC catalogs: existence required, RLS deliberately NOT required
    'airs.roles','airs.permissions','airs.role_permissions'
  ] LOOP
    IF to_regclass(missing) IS NULL THEN
      RAISE EXCEPTION 'ADOPT FAIL: required table % is missing', missing;
    END IF;
  END LOOP;

  -- 4. Tenant/identity tables that MUST carry forced RLS with a policy -------
  -- Exactly the tables migrations 0001-0010 pass through their
  -- ENABLE + FORCE ROW LEVEL SECURITY loops. No blanket "every airs.* table
  -- needs RLS" rule may be introduced here.
  FOREACH missing IN ARRAY ARRAY[
    'airs.organizations','airs.users','airs.user_roles','airs.accounts','airs.memberships',
    'airs.sessions','airs.invitations','airs.audit_events','airs.retention_policies',
    'airs.incidents','airs.incident_shares','airs.aircraft','airs.airspace_operations',
    'airs.maintenance_events','airs.trusted_agencies','airs.incident_rooms',
    'airs.incident_participants','airs.resources','airs.resource_aircraft',
    'airs.resource_vehicles','airs.resource_docks','airs.resource_launch_sites',
    'airs.resource_sensors','airs.personnel_profiles','airs.qualifications','airs.shifts',
    'airs.resource_shares','airs.incident_assignments',
    'airs.map_features','airs.operating_areas','airs.resource_locations',
    'airs.observations','airs.observation_annotations','airs.observation_relationships',
    'airs.observation_information_gaps','airs.observation_evidence_references',
    'airs.observation_shares'
  ] LOOP
    IF to_regclass(missing) IS NULL THEN
      RAISE EXCEPTION 'ADOPT FAIL: required table % is missing', missing;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid = missing::regclass AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'ADOPT FAIL: row-level security is not enabled on %', missing;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid = missing::regclass AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'ADOPT FAIL: row-level security is not FORCED on %', missing;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE (schemaname || '.' || tablename) = missing) THEN
      RAISE EXCEPTION 'ADOPT FAIL: no RLS policy exists on %', missing;
    END IF;
  END LOOP;

  FOREACH missing IN ARRAY ARRAY[
    -- NOTE: airs.has_permission is deliberately absent from this list. Permission
    -- evaluation lives in the TypeScript RBAC model plus RLS predicates over the
    -- session GUCs; see SUPERSEDED_OBJECTS in scripts/lib/canonical-schema.mjs.
    'airs.current_org_id','airs.current_user_id','airs.current_account_id','airs.ctx',
    'airs.disclosure_allows','airs.effective_disclosure','airs.apply_precision',
    'airs.expire_incident_state','airs.terminate_incident_geography',
    'airs.terminate_incident_observations'
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

  -- 7. Albany demo organizations, when present, remain agency tenants -------
  -- They come from db/seed/demo_orgs.sql, NOT from migrations 0001-0012, so a
  -- legitimately migrated database may not contain them. Their absence is not
  -- a defect; being anything other than an agency tenant is.
  IF EXISTS (SELECT 1 FROM airs.organizations
              WHERE name = 'Albany Police Department' AND org_kind <> 'agency') THEN
    RAISE EXCEPTION 'ADOPT FAIL: Albany Police Department is not an agency tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM airs.organizations
              WHERE name = 'Albany County' AND org_kind <> 'agency') THEN
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