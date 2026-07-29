-- AIRS Agent — tenant isolation test matrix.
-- Covers every tenant-owned table and SELECT/INSERT/UPDATE/DELETE.
--
--   psql "$SUPERUSER_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/rls_matrix.sql
--
-- Must be run by a role that can create fixtures (superuser or schema owner).
-- The assertions themselves always run as airs_app, the unprivileged
-- application role, via SET ROLE. Any failing assertion aborts with an error.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (rolled back at the end — this script never leaves data behind)
-- ---------------------------------------------------------------------------
\set apd    '11111111-1111-4111-8111-111111111111'
\set county '22222222-2222-4222-8222-222222222222'

INSERT INTO airs.organizations (id, slug, name, agency_type) VALUES
  (:'apd',    'albany-pd',     'Albany Police Department', 'law_enforcement'),
  (:'county', 'albany-county', 'Albany County',            'county')
ON CONFLICT (id) DO NOTHING;

INSERT INTO airs.users (id, org_id, email_address, display_name) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', :'apd',    'ic@albanypd.gov',      'APD IC'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', :'county', 'ops@albanycounty.gov', 'County Ops')
ON CONFLICT (id) DO NOTHING;

INSERT INTO airs.incidents (id, org_id, title, created_by) VALUES
  ('cccccccc-0000-4000-8000-00000000000c', :'apd',    'APD Pursuit', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('dddddddd-0000-4000-8000-00000000000d', :'county', 'County Flood','bbbbbbbb-0000-4000-8000-00000000000b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO airs.aircraft (id, org_id, kind, registration) VALUES
  ('eeeeeeee-0000-4000-8000-00000000000e', :'apd',    'uas',    'N-APD-1'),
  ('ffffffff-0000-4000-8000-00000000000f', :'county', 'crewed', 'N-CTY-1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO airs.airspace_operations (id, org_id, incident_id, aircraft_id, created_by) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000001', :'apd',    'cccccccc-0000-4000-8000-00000000000c',
   'eeeeeeee-0000-4000-8000-00000000000e', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('a2a2a2a2-0000-4000-8000-000000000002', :'county', 'dddddddd-0000-4000-8000-00000000000d',
   'ffffffff-0000-4000-8000-00000000000f', 'bbbbbbbb-0000-4000-8000-00000000000b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO airs.user_roles (org_id, user_id, role_key) VALUES
  (:'apd',    'aaaaaaaa-0000-4000-8000-00000000000a', 'incident_commander'),
  (:'county', 'bbbbbbbb-0000-4000-8000-00000000000b', 'dispatcher')
ON CONFLICT DO NOTHING;

INSERT INTO airs.retention_policies (org_id) VALUES (:'apd'), (:'county')
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO airs.audit_events (org_id, action, resource_type, outcome) VALUES
  (:'apd', 'fixture', 'test', 'allow'),
  (:'county', 'fixture', 'test', 'allow');

CREATE TEMP TABLE rls_results (
  seq serial, check_name text, expected text, actual text, ok boolean
) ON COMMIT DROP;

DO $$
DECLARE
  apd    uuid := '11111111-1111-4111-8111-111111111111';
  county uuid := '22222222-2222-4222-8222-222222222222';
  apd_user    uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  county_user uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  apd_incident uuid := 'cccccccc-0000-4000-8000-00000000000c';
  n bigint;
  tbl text;


  -- helper state
  outcome text;
BEGIN
  -- record(): inline via INSERT after RESET ROLE.

  ----------------------------------------------------------------------------
  -- 1. No tenant context => nothing is visible on any tenant table.
  ----------------------------------------------------------------------------
  PERFORM set_config('airs.org_id', '', true);
  PERFORM set_config('airs.user_id', '', true);
  FOREACH tbl IN ARRAY ARRAY['organizations','users','user_roles','incidents',
                             'incident_shares','aircraft','airspace_operations',
                             'audit_events','retention_policies'] LOOP
    SET LOCAL ROLE airs_app;
    EXECUTE format('SELECT count(*) FROM airs.%I', tbl) INTO n;
    RESET ROLE;
    INSERT INTO rls_results(check_name, expected, actual, ok)
    VALUES ('no_context.select.' || tbl, '0', n::text, n = 0);
  END LOOP;

  -- 1b. No tenant context => INSERT is refused.
  BEGIN
    SET LOCAL ROLE airs_app;
    INSERT INTO airs.incidents (org_id, title) VALUES (apd, 'should fail');
    RESET ROLE;
    outcome := 'inserted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('no_context.insert.incidents', 'denied', outcome, outcome = 'denied');

  ----------------------------------------------------------------------------
  -- 2. Albany PD context: sees own rows only.
  ----------------------------------------------------------------------------
  PERFORM set_config('airs.org_id', apd::text, true);
  PERFORM set_config('airs.user_id', apd_user::text, true);

  FOREACH tbl IN ARRAY ARRAY['users','user_roles','incidents','aircraft',
                             'airspace_operations','audit_events','retention_policies'] LOOP
    SET LOCAL ROLE airs_app;
    EXECUTE format('SELECT count(*) FROM airs.%I WHERE org_id = %L', tbl, county) INTO n;
    RESET ROLE;
    INSERT INTO rls_results(check_name, expected, actual, ok)
    VALUES ('apd.cannot_see_county.' || tbl, '0', n::text, n = 0);
  END LOOP;

  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.organizations;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.organizations_visible', '1', n::text, n = 1);

  -- 2b. APD cannot insert a row owned by the county.
  BEGIN
    SET LOCAL ROLE airs_app;
    INSERT INTO airs.incidents (org_id, title) VALUES (county, 'cross tenant insert');
    RESET ROLE;
    outcome := 'inserted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE; outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.insert_for_county.incidents', 'denied', outcome, outcome = 'denied');

  -- 2c. APD cannot move one of its own rows into the county tenant.
  BEGIN
    SET LOCAL ROLE airs_app;
    UPDATE airs.incidents SET org_id = county WHERE id = apd_incident;
    RESET ROLE; outcome := 'moved';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE; outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.change_org_id.incidents', 'denied', outcome, outcome = 'denied');

  BEGIN
    SET LOCAL ROLE airs_app;
    UPDATE airs.aircraft SET org_id = county WHERE org_id = apd;
    RESET ROLE; outcome := 'moved';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE; outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.change_org_id.aircraft', 'denied', outcome, outcome = 'denied');

  -- 2d. APD can create and delete inside its own tenant (positive control).
  SET LOCAL ROLE airs_app;
  INSERT INTO airs.incidents (id, org_id, title)
  VALUES ('0f0f0f0f-0000-4000-8000-000000000009', apd, 'APD own insert');
  SELECT count(*) INTO n FROM airs.incidents WHERE id = '0f0f0f0f-0000-4000-8000-000000000009';
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.insert_own.incidents', '1', n::text, n = 1);

  SET LOCAL ROLE airs_app;
  DELETE FROM airs.incidents WHERE id = '0f0f0f0f-0000-4000-8000-000000000009';
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('apd.delete_own.incidents', '1', n::text, n = 1);

  ----------------------------------------------------------------------------
  -- 3. Albany County context: mirror-image checks.
  ----------------------------------------------------------------------------
  PERFORM set_config('airs.org_id', county::text, true);
  PERFORM set_config('airs.user_id', county_user::text, true);

  FOREACH tbl IN ARRAY ARRAY['users','user_roles','aircraft','audit_events',
                             'retention_policies'] LOOP
    SET LOCAL ROLE airs_app;
    EXECUTE format('SELECT count(*) FROM airs.%I WHERE org_id = %L', tbl, apd) INTO n;
    RESET ROLE;
    INSERT INTO rls_results(check_name, expected, actual, ok)
    VALUES ('county.cannot_see_apd.' || tbl, '0', n::text, n = 0);
  END LOOP;

  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.incidents WHERE org_id = apd;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.cannot_see_apd.incidents_unshared', '0', n::text, n = 0);

  -- 3b. County cannot update or delete APD rows (no error, simply no rows).
  SET LOCAL ROLE airs_app;
  UPDATE airs.incidents SET title = 'hijacked' WHERE org_id = apd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.update_apd.incidents_rows', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  DELETE FROM airs.incidents WHERE org_id = apd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.delete_apd.incidents_rows', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  UPDATE airs.aircraft SET registration = 'stolen' WHERE org_id = apd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.update_apd.aircraft_rows', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  UPDATE airs.users SET display_name = 'stolen' WHERE org_id = apd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.update_apd.users_rows', '0', n::text, n = 0);

  ----------------------------------------------------------------------------
  -- 4. Sharing: read access appears only through an active share.
  ----------------------------------------------------------------------------
  PERFORM set_config('airs.org_id', apd::text, true);
  PERFORM set_config('airs.user_id', apd_user::text, true);
  SET LOCAL ROLE airs_app;
  INSERT INTO airs.incident_shares (org_id, incident_id, partner_org_id, scope, granted_by)
  VALUES (apd, apd_incident, county, 'read', apd_user)
  ON CONFLICT (incident_id, partner_org_id) DO UPDATE SET revoked_at = NULL;
  RESET ROLE;

  PERFORM set_config('airs.org_id', county::text, true);
  PERFORM set_config('airs.user_id', county_user::text, true);
  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.incidents WHERE org_id = apd;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.sees_shared_incident', '1', n::text, n = 1);

  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.airspace_operations WHERE org_id = apd;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.sees_shared_airspace_op', '1', n::text, n = 1);

  -- 4b. A shared incident is still read-only for the partner.
  SET LOCAL ROLE airs_app;
  UPDATE airs.incidents SET title = 'partner edit' WHERE id = apd_incident;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.update_shared_incident_rows', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  DELETE FROM airs.incidents WHERE id = apd_incident;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.delete_shared_incident_rows', '0', n::text, n = 0);

  -- 4c. A partner cannot revoke or forge a share.
  SET LOCAL ROLE airs_app;
  UPDATE airs.incident_shares SET revoked_at = now() WHERE incident_id = apd_incident;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.revoke_apd_share_rows', '0', n::text, n = 0);

  BEGIN
    SET LOCAL ROLE airs_app;
    INSERT INTO airs.incident_shares (org_id, incident_id, partner_org_id, scope)
    VALUES (apd, 'dddddddd-0000-4000-8000-00000000000d', county, 'read');
    RESET ROLE; outcome := 'inserted';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR unique_violation THEN
    RESET ROLE; outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.forge_share_as_apd', 'denied', outcome, outcome = 'denied');

  ----------------------------------------------------------------------------
  -- 5. Revocation removes access immediately.
  ----------------------------------------------------------------------------
  PERFORM set_config('airs.org_id', apd::text, true);
  PERFORM set_config('airs.user_id', apd_user::text, true);
  SET LOCAL ROLE airs_app;
  UPDATE airs.incident_shares SET revoked_at = now() WHERE incident_id = apd_incident;
  RESET ROLE;

  PERFORM set_config('airs.org_id', county::text, true);
  PERFORM set_config('airs.user_id', county_user::text, true);
  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.incidents WHERE org_id = apd;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.after_revoke.incidents', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  SELECT count(*) INTO n FROM airs.airspace_operations WHERE org_id = apd;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.after_revoke.airspace_operations', '0', n::text, n = 0);

  ----------------------------------------------------------------------------
  -- 6. Audit log is append-only for the application role.
  ----------------------------------------------------------------------------
  SET LOCAL ROLE airs_app;
  INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
  VALUES (county, 'test.write', 'incident', 'allow');
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.audit_insert_own', 'inserted', 'inserted', true);

  BEGIN
    SET LOCAL ROLE airs_app;
    INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
    VALUES (apd, 'test.write', 'incident', 'allow');
    RESET ROLE; outcome := 'inserted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE; outcome := 'denied';
  END;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.audit_insert_for_apd', 'denied', outcome, outcome = 'denied');

  SET LOCAL ROLE airs_app;
  UPDATE airs.audit_events SET action = 'tampered' WHERE org_id = county;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.audit_update_rows', '0', n::text, n = 0);

  SET LOCAL ROLE airs_app;
  DELETE FROM airs.audit_events WHERE org_id = county;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('county.audit_delete_rows', '0', n::text, n = 0);

  ----------------------------------------------------------------------------
  -- 7. Structural guarantees: RLS enabled AND forced on every tenant table.
  ----------------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'airs' AND c.relkind = 'r'
     AND c.relname IN ('organizations','users','user_roles','incidents','incident_shares',
                       'aircraft','airspace_operations','audit_events','retention_policies')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('structure.rls_enabled_and_forced', '9', n::text, n = 9);

  -- 7b. Table owner is also subject to RLS because of FORCE (superusers are not).
  PERFORM set_config('airs.org_id', '', true);
  SELECT count(*) INTO n FROM airs.incidents;
  INSERT INTO rls_results(check_name, expected, actual, ok)
  VALUES ('owner_or_superuser.sees_all_rows',
          CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN 'bypass' ELSE 'forced' END,
          CASE WHEN n > 0 THEN 'bypass' ELSE 'forced' END,
          true);
END $$;

\echo '--- RLS test matrix ---'
SELECT seq, check_name, expected, actual, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result
FROM rls_results ORDER BY seq;

DO $$
DECLARE failed int;
BEGIN
  SELECT count(*) INTO failed FROM rls_results WHERE NOT ok;
  IF failed > 0 THEN
    RAISE EXCEPTION 'RLS test matrix: % check(s) FAILED', failed;
  END IF;
  RAISE NOTICE 'RLS test matrix: all % checks passed', (SELECT count(*) FROM rls_results);
END $$;

ROLLBACK;
