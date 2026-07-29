-- Executable tenant-isolation proof. Run against a database that has had
-- db/migrations/* and db/seed/demo_orgs.sql applied:
--   psql "$DATABASE_URL" -f db/tests/rls_isolation.sql
-- Expected: apd_incidents=1, apd_can_see_county_users=0, apd_orgs_visible=1,
--           county_sees_after_share=2, county_updated_apd_rows=0,
--           county_sees_after_revoke=1

INSERT INTO airs.users (id, org_id, email_address, display_name) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','ic@albanypd.gov','APD IC'),
 ('bbbbbbbb-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','ops@albanycounty.gov','County Ops')
ON CONFLICT DO NOTHING;
INSERT INTO airs.incidents (id, org_id, title, created_by) VALUES
 ('cccccccc-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','APD Pursuit','aaaaaaaa-0000-4000-8000-000000000001'),
 ('dddddddd-0000-4000-8000-000000000004','22222222-2222-4222-8222-222222222222','County Flood','bbbbbbbb-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

BEGIN;
SET LOCAL ROLE airs_app;
SET LOCAL airs.org_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL airs.user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT 'apd_incidents' AS check, count(*) FROM airs.incidents;
SELECT 'apd_can_see_county_users' AS check, count(*) FROM airs.users
  WHERE org_id='22222222-2222-4222-8222-222222222222';
SELECT 'apd_orgs_visible' AS check, count(*) FROM airs.organizations;
INSERT INTO airs.incident_shares (org_id, incident_id, partner_org_id, scope, granted_by)
VALUES ('11111111-1111-4111-8111-111111111111','cccccccc-0000-4000-8000-000000000003',
        '22222222-2222-4222-8222-222222222222','read','aaaaaaaa-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;
COMMIT;

BEGIN;
SET LOCAL ROLE airs_app;
SET LOCAL airs.org_id = '22222222-2222-4222-8222-222222222222';
SET LOCAL airs.user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
SELECT 'county_sees_after_share' AS check, count(*) FROM airs.incidents;
UPDATE airs.incidents SET title='hijack' WHERE org_id='11111111-1111-4111-8111-111111111111';
SELECT 'county_updated_apd_rows' AS check, count(*) FROM airs.incidents WHERE title='hijack';
COMMIT;

BEGIN;
SET LOCAL ROLE airs_app;
SET LOCAL airs.org_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL airs.user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
UPDATE airs.incident_shares SET revoked_at = now()
  WHERE incident_id='cccccccc-0000-4000-8000-000000000003';
COMMIT;

BEGIN;
SET LOCAL ROLE airs_app;
SET LOCAL airs.org_id = '22222222-2222-4222-8222-222222222222';
SET LOCAL airs.user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
SELECT 'county_sees_after_revoke' AS check, count(*) FROM airs.incidents;
COMMIT;