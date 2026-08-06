-- Post-reconciliation verification. Every assertion below must hold before the
-- migration ledger is created and 0001-0012 are adopted. Any failure aborts the
-- reconciliation with no ledger and no adoption state.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/repair/reconcile_verify.sql
DO $$
DECLARE n int; t text;
BEGIN
  -- 1. the application role stays unprivileged -------------------------------
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='airs_app' AND rolsuper) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs_app is a superuser';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='airs_app' AND rolbypassrls) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs_app has BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='airs_maintenance' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs_maintenance is over-privileged';
  END IF;

  -- 2. forced RLS on every tenant-scoped table --------------------------------
  FOREACH t IN ARRAY ARRAY[
    'organizations','users','memberships','incidents','incident_participants',
    'resources','incident_assignments','resource_shares',
    'map_features','operating_areas','resource_locations',
    'observations','observation_shares'
  ] LOOP
    IF to_regclass('airs.' || t) IS NULL THEN
      RAISE EXCEPTION 'RECONCILE FAIL: table airs.% is missing', t;
    END IF;
    IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('airs.' || t)::regclass) THEN
      RAISE EXCEPTION 'RECONCILE FAIL: forced row-level security is not enabled on airs.%', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename=t) THEN
      RAISE EXCEPTION 'RECONCILE FAIL: no RLS policy exists on airs.%', t;
    END IF;
  END LOOP;

  -- 3. the platform tenant --------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM airs.organizations
     WHERE slug='anconison-platform'
       AND name='Anconison - AIRS Agent Platform'
       AND org_kind='platform'
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: the Anconison platform tenant is missing, renamed or not org_kind=platform';
  END IF;

  -- 4. platform_admin receives no agency operational access -------------------
  IF EXISTS (
    SELECT 1 FROM airs.role_permissions
     WHERE role_key='platform_admin'
       AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%'
            OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%')
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: platform_admin has operational permissions';
  END IF;

  -- 5. the Albany demo organizations remain agency tenants ---------------------
  IF EXISTS (
    SELECT 1 FROM airs.organizations
     WHERE slug IN ('albany-pd','albany-county') AND org_kind <> 'agency'
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: an Albany demo organization is no longer an agency tenant';
  END IF;
  SELECT count(*) INTO n FROM airs.organizations WHERE slug IN ('albany-pd','albany-county');
  RAISE NOTICE 'ok  Albany agency tenants present: %', n;

  -- 6. disclosure-sensitive fields remain protected ---------------------------
  IF NOT EXISTS (SELECT 1 FROM airs.disclosure_fields WHERE sensitive) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: no disclosure field is marked sensitive';
  END IF;
  IF EXISTS (
    SELECT 1 FROM airs.disclosure_profile_fields pf
      JOIN airs.disclosure_fields f ON f.field_key = pf.field_key
     WHERE pf.profile = 'summary' AND f.sensitive
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: the summary disclosure profile exposes a sensitive field';
  END IF;

  -- 7. partner precision cannot be widened ------------------------------------
  IF to_regclass('airs.disclosure_precisions') IS NULL THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs.disclosure_precisions is missing';
  END IF;
  -- narrow profiles must never be able to carry exact geometry, and only the
  -- command profiles may.
  IF EXISTS (
    SELECT 1 FROM airs.disclosure_precisions dp
      JOIN airs.geographic_precisions gp ON gp.policy = dp.policy
     WHERE dp.profile IN ('summary','operational','custom') AND gp.rank >= 4
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: a partner-narrowed disclosure profile is allowed exact geometry';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM airs.disclosure_precisions dp
      JOIN airs.geographic_precisions gp ON gp.policy = dp.policy
     WHERE dp.profile = 'summary' AND gp.rank = 0
  ) THEN
    RAISE EXCEPTION 'RECONCILE FAIL: the summary profile no longer withholds geography';
  END IF;

  -- 8. exact geometry is reachable only through the precision function ---------
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
                  WHERE ns.nspname='airs' AND p.proname='apply_precision') THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs.apply_precision is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
                  WHERE ns.nspname='airs' AND p.proname='observation_precision') THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs.observation_precision is missing';
  END IF;

  -- 9. revocation and incident closure remain immediate ------------------------
  FOREACH t IN ARRAY ARRAY['terminate_incident_geography','terminate_incident_observations','expire_incident_state'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
                    WHERE ns.nspname='airs' AND p.proname=t) THEN
      RAISE EXCEPTION 'RECONCILE FAIL: closure function airs.% is missing', t;
    END IF;
  END LOOP;

  -- 10. observation restricted-source protection --------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
                  WHERE ns.nspname='airs' AND p.proname='observation_profile') THEN
    RAISE EXCEPTION 'RECONCILE FAIL: airs.observation_profile is missing';
  END IF;

  RAISE NOTICE 'ok  reconciliation verification: roles, forced RLS, tenancy, disclosure, precision and closure';
END $$;
