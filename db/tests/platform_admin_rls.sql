-- AIRS Agent — platform administration plane proof.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/platform_admin_rls.sql
--
-- Proves that the platform plane is genuinely separate from the agency plane:
-- the platform organization exists, holds only platform_admin principals, the
-- role carries no operational permission, the bootstrap routine is not
-- reachable from the application role, the invitation it issues expires and is
-- single-use, and a platform administrator sees no agency-owned rows.
-- Everything is rolled back: the script leaves no rows behind.

\set ON_ERROR_STOP on
\timing off

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'PLATFORM FAIL: %', label;
  END IF;
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
  RAISE EXCEPTION 'PLATFORM FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

-- 1. Plane inventory -----------------------------------------------------------
DO $$
DECLARE plat uuid;
BEGIN
  SELECT id INTO plat FROM airs.organizations WHERE org_kind = 'platform';
  PERFORM pg_temp.ok(plat IS NOT NULL, 'a platform organization exists');
  PERFORM pg_temp.ok(
    (SELECT slug FROM airs.organizations WHERE id = plat) = 'anconison-platform',
    'the platform organization is the Anconison platform tenant');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.organizations WHERE org_kind = 'platform') = 1,
    'exactly one platform organization may exist');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.organizations
      WHERE id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')
        AND org_kind = 'agency') = 2,
    'both Albany demonstration tenants still exist and remain agency tenants');
END $$;

-- 2. Role model ------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.ok((SELECT name FROM airs.roles WHERE key = 'platform_admin')
                     = 'Platform Administrator',
    'the Platform Administrator role is seeded');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.role_permissions WHERE role_key = 'platform_admin') = 4,
    'platform_admin holds exactly four platform permissions');
  PERFORM pg_temp.ok(NOT EXISTS (
      SELECT 1 FROM airs.role_permissions
       WHERE role_key = 'platform_admin'
         AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%'
           OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%'
           OR permission_key LIKE 'airspace.%' OR permission_key LIKE 'personnel.%')),
    'platform_admin holds no agency operational permission');
END $$;

-- 3. Plane separation guard --------------------------------------------------------
DO $$
DECLARE plat uuid; acct uuid; usr uuid;
BEGIN
  SELECT id INTO plat FROM airs.organizations WHERE org_kind = 'platform';

  INSERT INTO airs.accounts (email, display_name, password_hash)
    VALUES ('platform.probe@example.test','Platform Probe','pbkdf2$sha256$210000$x$y')
    RETURNING id INTO acct;
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (plat,'platform.probe@example.test','Platform Probe',acct) RETURNING id INTO usr;
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
    VALUES (plat, acct, usr, 'platform_admin', 'active', now());
  PERFORM pg_temp.ok(true, 'platform_admin membership is accepted in the platform organization');

  -- An agency user record for the same probe, used by the guard checks below.
  INSERT INTO airs.users (org_id, email_address, display_name)
    VALUES ('11111111-1111-4111-8111-111111111111','platform.probe@example.test','Platform Probe');
END $$;

DO $$
DECLARE plat uuid; acct uuid; usr uuid;
BEGIN
  SELECT id INTO plat FROM airs.organizations WHERE org_kind = 'platform';
  SELECT id INTO acct FROM airs.accounts WHERE email = 'platform.probe@example.test';
  SELECT id INTO usr FROM airs.users
    WHERE org_id = '11111111-1111-4111-8111-111111111111'
      AND email_address = 'platform.probe@example.test';

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status)
       VALUES ('11111111-1111-4111-8111-111111111111', %L, %L, 'platform_admin', 'active')$q$,
    acct, usr),
    'platform_admin cannot be granted inside an agency organization');

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
       VALUES ('11111111-1111-4111-8111-111111111111','probe2@example.test','platform_admin',
               'hash-platform-agency', now() + interval '1 day')$q$),
    'a platform_admin invitation cannot be issued by an agency organization');

  PERFORM pg_temp.denied(format(
    $q$INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
       VALUES (%L,'probe3@example.test','agency_admin','hash-agency-platform',
               now() + interval '1 day')$q$, plat),
    'an agency role cannot be invited into the platform organization');
END $$;

-- 4. Bootstrap routine -------------------------------------------------------------
DO $$
DECLARE plat uuid; r record; r2 record;
BEGIN
  SELECT id INTO plat FROM airs.organizations WHERE org_kind = 'platform';

  PERFORM pg_temp.ok(
    NOT has_function_privilege('airs_app', 'airs.bootstrap_platform_invitation(text,text,int)', 'EXECUTE'),
    'the application role cannot mint platform administrators');
  PERFORM pg_temp.ok(
    NOT has_function_privilege('airs_app', 'airs.platform_identity_report(text)', 'EXECUTE'),
    'the application role cannot run the identity report');

  PERFORM pg_temp.denied(
    $q$SELECT airs.bootstrap_platform_invitation('not-an-email', repeat('a',64), 3600)$q$,
    'the bootstrap routine rejects a malformed address');
  PERFORM pg_temp.denied(
    $q$SELECT airs.bootstrap_platform_invitation('probe@example.test', 'not-a-hash', 3600)$q$,
    'the bootstrap routine rejects anything that is not a SHA-256 digest');

  SELECT * INTO r FROM airs.bootstrap_platform_invitation(
    'platform.bootstrap@example.test', repeat('b',64), 3600);
  PERFORM pg_temp.ok(r.org_id = plat, 'the bootstrap invitation belongs to the platform tenant');
  PERFORM pg_temp.ok(r.expires_at > now(), 'the bootstrap invitation expires in the future');
  PERFORM pg_temp.ok(
    (SELECT role_key FROM airs.invitations WHERE id = r.invitation_id) = 'platform_admin',
    'the bootstrap invitation carries the platform_admin role');
  PERFORM pg_temp.ok(
    (SELECT status FROM airs.invitations WHERE id = r.invitation_id) = 'pending',
    'the bootstrap invitation is pending');

  -- Re-running must supersede, never duplicate.
  SELECT * INTO r2 FROM airs.bootstrap_platform_invitation(
    'platform.bootstrap@example.test', repeat('c',64), 3600);
  PERFORM pg_temp.ok(r2.superseded = 1, 'a second run revokes the earlier pending invitation');
  PERFORM pg_temp.ok(
    (SELECT status FROM airs.invitations WHERE id = r.invitation_id) = 'revoked',
    'the earlier bootstrap link is no longer usable');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.invitations
      WHERE lower(email) = 'platform.bootstrap@example.test' AND status = 'pending') = 1,
    'exactly one pending platform invitation exists per address');

  -- Expiry is enforced by the stored row, and the audit trail records the event
  -- without any token material.
  PERFORM pg_temp.ok(EXISTS (
      SELECT 1 FROM airs.audit_events
       WHERE org_id = plat AND action = 'platform.bootstrap_invitation_created'),
    'the bootstrap invitation is audited in the platform organization');
  PERFORM pg_temp.ok(NOT EXISTS (
      SELECT 1 FROM airs.audit_events
       WHERE action = 'platform.bootstrap_invitation_created'
         AND detail::text LIKE '%' || repeat('c',64) || '%'),
    'no token hash and no token appears in the audit detail');
END $$;

-- 5. A platform administrator sees no agency-owned rows -------------------------------
-- The fixture identifiers MUST be resolved while still running with setup
-- privileges. Under airs_app the accounts table is RLS-restricted, so a lookup
-- performed after the role switch silently yields NULL and the assertions below
-- would then exercise the account-less, tenant-only branch of
-- airs.current_org_id() instead of a real platform administrator.
DO $$
DECLARE plat uuid; acct uuid;
BEGIN
  SELECT id INTO plat FROM airs.organizations WHERE org_kind = 'platform';
  SELECT id INTO acct FROM airs.accounts WHERE email = 'platform.probe@example.test';

  PERFORM pg_temp.ok(acct IS NOT NULL,
    'the platform probe account exists before the restricted-role section begins');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.memberships
      WHERE account_id = acct AND role_key = 'platform_admin' AND status = 'active') = 1,
    'the platform probe holds exactly one active platform_admin membership');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.memberships m
      JOIN airs.organizations o ON o.id = m.org_id
     WHERE m.account_id = acct AND o.slug = 'anconison-platform') = 1,
    'that membership belongs to the anconison-platform organization');
  PERFORM pg_temp.ok(NOT EXISTS (
      SELECT 1 FROM airs.memberships
       WHERE account_id = acct AND org_id = '11111111-1111-4111-8111-111111111111'),
    'the platform probe holds no Albany membership');
  PERFORM pg_temp.ok(EXISTS (
      SELECT 1 FROM airs.users
       WHERE org_id = '11111111-1111-4111-8111-111111111111'
         AND email_address = 'platform.probe@example.test'),
    'the Albany users probe record exists and is retained for the invisibility proof');

  -- Carry the resolved account id across the role switch in a transaction-local
  -- setting. This is test scaffolding only; it changes no schema, policy or privilege.
  PERFORM set_config('airs.test_platform_account_id', acct::text, true);
  PERFORM set_config('airs.test_platform_org_id', plat::text, true);
END $$;

SET LOCAL ROLE airs_app;
DO $$
DECLARE plat uuid; acct uuid;
BEGIN
  plat := current_setting('airs.test_platform_org_id', true)::uuid;
  acct := current_setting('airs.test_platform_account_id', true)::uuid;
  PERFORM pg_temp.ok(acct IS NOT NULL AND plat IS NOT NULL,
    'the restricted-role section runs with a real platform-admin account id');

  PERFORM set_config('airs.account_id', acct::text, true);
  PERFORM set_config('airs.org_id', '11111111-1111-4111-8111-111111111111', true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL,
    'a platform administrator cannot assume an agency organization context');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.organizations
      WHERE id = '11111111-1111-4111-8111-111111111111') = 0,
    'a platform administrator cannot see the Albany organization row');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.organizations WHERE id = plat) = 1,
    'a platform administrator still sees its own platform organization');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.users
      WHERE org_id = '11111111-1111-4111-8111-111111111111'
        AND email_address = 'platform.probe@example.test') = 0,
    'the Albany probe user row is invisible to a platform administrator');
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.users
      WHERE account_id = acct AND org_id = plat) = 1,
    'the platform administrator still reads its own self-identity row');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.incidents) = 0,
    'a platform administrator reads no agency incidents');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.audit_events) = 0,
    'a platform administrator reads no agency audit rows');

  PERFORM set_config('airs.org_id', plat::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() = plat,
    'a platform administrator may act inside the platform organization');
  PERFORM pg_temp.ok(
    (SELECT slug FROM airs.organizations WHERE id = airs.current_org_id()) = 'anconison-platform',
    'the resolved organization is the Anconison platform tenant');
END $$;
RESET ROLE;

-- 5b. Unchanged behaviour that other planes depend on ---------------------------------
SET LOCAL ROLE airs_app;
DO $$
BEGIN
  -- Account-less, tenant-only context (migrations, background jobs) is unchanged.
  PERFORM set_config('airs.account_id', '', true);
  PERFORM set_config('airs.org_id', '11111111-1111-4111-8111-111111111111', true);
  PERFORM pg_temp.ok(
    airs.current_org_id() = '11111111-1111-4111-8111-111111111111',
    'account-less tenant-only context still resolves the requested organization');

  -- Invitation redemption context (an account with no membership yet) is unchanged.
  PERFORM set_config('airs.account_id', gen_random_uuid()::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL,
    'an account with no membership resolves no organization context');
END $$;
RESET ROLE;

-- 6. No context, no rows -----------------------------------------------------------
SET LOCAL ROLE airs_app;
DO $$
BEGIN
  PERFORM set_config('airs.account_id', '', true);
  PERFORM set_config('airs.org_id', '', true);
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations) = 0,
    'an unauthenticated caller sees no invitations at all');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.organizations) = 0,
    'an unauthenticated caller sees no organizations at all');
END $$;
RESET ROLE;

ROLLBACK;

\echo 'PLATFORM: all assertions passed'
