-- AIRS Agent - platform tenant display-name proof (migration 0012).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/platform_org_name.sql
\set ON_ERROR_STOP on
DO $$
DECLARE r record;
BEGIN
  SELECT count(*) AS n INTO r FROM airs.organizations WHERE slug = 'anconison-platform';
  IF r.n <> 1 THEN
    RAISE EXCEPTION 'NAME FAIL: expected exactly one anconison-platform organization, found %', r.n;
  END IF;

  SELECT * INTO r FROM airs.organizations WHERE slug = 'anconison-platform';
  IF r.name <> 'Anconison - AIRS Agent Platform' THEN
    RAISE EXCEPTION 'NAME FAIL: platform display name is %', r.name;
  END IF;
  IF r.name ~ '[^\x20-\x7E]' THEN
    RAISE EXCEPTION 'NAME FAIL: platform display name contains non-ASCII characters';
  END IF;
  IF r.org_kind <> 'platform' THEN
    RAISE EXCEPTION 'NAME FAIL: org_kind is %', r.org_kind;
  END IF;
  IF r.id <> '00000000-0000-4000-8000-00000000a123'::uuid THEN
    RAISE EXCEPTION 'NAME FAIL: platform organization id changed';
  END IF;
  RAISE NOTICE 'ok  platform tenant name/slug/org_kind/id intact';

  PERFORM 1 FROM airs.organizations
    WHERE id = '11111111-1111-4111-8111-111111111111'
      AND name = 'Albany Police Department' AND org_kind = 'agency';
  IF NOT FOUND THEN RAISE EXCEPTION 'NAME FAIL: Albany Police Department altered'; END IF;
  PERFORM 1 FROM airs.organizations
    WHERE id = '22222222-2222-4222-8222-222222222222'
      AND name = 'Albany County' AND org_kind = 'agency';
  IF NOT FOUND THEN RAISE EXCEPTION 'NAME FAIL: Albany County altered'; END IF;
  RAISE NOTICE 'ok  Albany agency tenants unchanged';

  IF (SELECT count(*) FROM airs.role_permissions WHERE role_key = 'platform_admin') <> 4 THEN
    RAISE EXCEPTION 'NAME FAIL: platform_admin permission set changed';
  END IF;
  IF EXISTS (SELECT 1 FROM airs.role_permissions WHERE role_key = 'platform_admin'
               AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%'
                 OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%'
                 OR permission_key LIKE 'airspace.%' OR permission_key LIKE 'personnel.%')) THEN
    RAISE EXCEPTION 'NAME FAIL: platform_admin gained operational permissions';
  END IF;
  RAISE NOTICE 'ok  platform_admin permissions unchanged (4, none operational)';
END $$;
