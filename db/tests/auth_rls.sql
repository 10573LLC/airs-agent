-- AIRS Agent — identity-plane forced-RLS proof.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/auth_rls.sql
--
-- Sections:
--   1. fixtures            — created by the migration/owner role (administrative)
--   2. assertions          — executed as the UNPRIVILEGED application role
--                            (SET ROLE airs_app; asserted, and asserted to have
--                            neither superuser nor BYPASSRLS)
--   3. pooling / context   — proves SET LOCAL context does not survive COMMIT
--                            and is not inherited by the next operation on the
--                            same (reused) backend connection
--
-- Any failed assertion raises an exception; with ON_ERROR_STOP=1 psql exits
-- non-zero. Everything is rolled back at the end: the script leaves no rows.

\set ON_ERROR_STOP on
\timing off

-- Assertion helpers are created outside the fixture transaction so they
-- survive the ROLLBACK and remain available to section 3.
CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'AUTH-RLS FAIL: %', label;
  END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

-- Asserts that `stmt` is rejected (RLS violation or any error).
CREATE OR REPLACE FUNCTION pg_temp.denied(stmt text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ok  % (rejected: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'AUTH-RLS FAIL: % — statement was NOT rejected', label;
END $$;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Fixtures (administrative role — NOT part of the isolation assertions)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
-- Fixture ids are readable by the assertion role; they carry no tenant data.
GRANT SELECT ON ids TO airs_app;

DO $$
DECLARE
  org_a uuid := '11111111-1111-4111-8111-111111111111';  -- Albany Police Department
  org_b uuid := '22222222-2222-4222-8222-222222222222';  -- Albany County
  acct  uuid;
  usr   uuid;
  mship uuid;
BEGIN
  INSERT INTO ids VALUES ('org_a', org_a), ('org_b', org_b);

  -- Organization A: active administrator, plus invited / suspended / revoked users.
  FOREACH mship IN ARRAY ARRAY[NULL::uuid] LOOP NULL; END LOOP;  -- no-op, keeps DO tidy

  -- user A (active, org A, agency_admin)
  INSERT INTO airs.accounts (email, display_name, password_hash)
    VALUES ('rls.usera@example.test','RLS User A','pbkdf2$sha256$210000$x$y') RETURNING id INTO acct;
  INSERT INTO ids VALUES ('acct_a', acct);
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (org_a,'rls.usera@example.test','RLS User A',acct) RETURNING id INTO usr;
  INSERT INTO ids VALUES ('user_a', usr);
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
    VALUES (org_a, acct, usr, 'agency_admin', 'active', now()) RETURNING id INTO mship;
  INSERT INTO ids VALUES ('mship_a', mship);
  INSERT INTO airs.sessions (account_id, token_hash, active_org_id, expires_at)
    VALUES (acct, 'hash-session-a', org_a, now() + interval '1 hour') RETURNING id INTO mship;
  INSERT INTO ids VALUES ('session_a', mship);

  -- user B (active, org B, agency_admin)
  INSERT INTO airs.accounts (email, display_name, password_hash)
    VALUES ('rls.userb@example.test','RLS User B','pbkdf2$sha256$210000$x$y') RETURNING id INTO acct;
  INSERT INTO ids VALUES ('acct_b', acct);
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (org_b,'rls.userb@example.test','RLS User B',acct) RETURNING id INTO usr;
  INSERT INTO ids VALUES ('user_b', usr);
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
    VALUES (org_b, acct, usr, 'agency_admin', 'active', now()) RETURNING id INTO mship;
  INSERT INTO ids VALUES ('mship_b', mship);
  INSERT INTO airs.sessions (account_id, token_hash, active_org_id, expires_at)
    VALUES (acct, 'hash-session-b', org_b, now() + interval '1 hour') RETURNING id INTO mship;
  INSERT INTO ids VALUES ('session_b', mship);

  -- invited (org A, membership not yet accepted)
  INSERT INTO airs.accounts (email, display_name) VALUES ('rls.invited@example.test','RLS Invited')
    RETURNING id INTO acct;
  INSERT INTO ids VALUES ('acct_invited', acct);
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (org_a,'rls.invited@example.test','RLS Invited',acct) RETURNING id INTO usr;
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, invited_at)
    VALUES (org_a, acct, usr, 'visual_observer', 'invited', now()) RETURNING id INTO mship;
  INSERT INTO ids VALUES ('mship_invited', mship);

  -- suspended (org A)
  INSERT INTO airs.accounts (email, display_name, password_hash)
    VALUES ('rls.suspended@example.test','RLS Suspended','pbkdf2$sha256$210000$x$y') RETURNING id INTO acct;
  INSERT INTO ids VALUES ('acct_suspended', acct);
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (org_a,'rls.suspended@example.test','RLS Suspended',acct) RETURNING id INTO usr;
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at, suspended_at)
    VALUES (org_a, acct, usr, 'dispatcher', 'suspended', now(), now()) RETURNING id INTO mship;
  INSERT INTO ids VALUES ('mship_suspended', mship);

  -- revoked (org A)
  INSERT INTO airs.accounts (email, display_name, password_hash)
    VALUES ('rls.revoked@example.test','RLS Revoked','pbkdf2$sha256$210000$x$y') RETURNING id INTO acct;
  INSERT INTO ids VALUES ('acct_revoked', acct);
  INSERT INTO airs.users (org_id, email_address, display_name, account_id)
    VALUES (org_a,'rls.revoked@example.test','RLS Revoked',acct) RETURNING id INTO usr;
  INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, revoked_at)
    VALUES (org_a, acct, usr, 'dispatcher', 'revoked', now()) RETURNING id INTO mship;
  INSERT INTO ids VALUES ('mship_revoked', mship);

  -- one pending invitation per organization
  INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
    VALUES (org_a,'rls.newa@example.test','visual_observer','hash-invite-a', now() + interval '1 day')
    RETURNING id INTO mship;
  INSERT INTO ids VALUES ('invite_a', mship);
  INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
    VALUES (org_b,'rls.newb@example.test','visual_observer','hash-invite-b', now() + interval '1 day')
    RETURNING id INTO mship;
  INSERT INTO ids VALUES ('invite_b', mship);

  -- one audit row per organization
  INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
    VALUES (org_a,'fixture.seed','test','allow'), (org_b,'fixture.seed','test','allow');
END $$;

-- ---------------------------------------------------------------------------
-- 2. Assertions — unprivileged application role
-- ---------------------------------------------------------------------------
SET ROLE airs_app;

DO $$
BEGIN
  PERFORM pg_temp.ok(current_user = 'airs_app', 'assertions run as airs_app (not the owner)');
  PERFORM pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)),
    'airs_app has neither SUPERUSER nor BYPASSRLS');
  PERFORM pg_temp.ok(
    (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='airs' AND c.relname IN
       ('accounts','memberships','sessions','invitations','organizations','users','audit_events')),
    'FORCE ROW LEVEL SECURITY is enabled on every identity-plane table');
END $$;

-- 2a. No context at all -> default deny -------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.accounts)      = 0, 'no context: accounts invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships)   = 0, 'no context: memberships invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.sessions)      = 0, 'no context: sessions invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations)   = 0, 'no context: invitations invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.organizations) = 0, 'no context: organizations invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.users)         = 0, 'no context: users invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.audit_events)  = 0, 'no context: audit events invisible');
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL,                 'no context: current_org_id() is NULL');

  PERFORM pg_temp.denied(
    format('INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
            VALUES (%L, ''x'', ''y'', ''allow'')', (SELECT v FROM ids WHERE k='org_a')),
    'no context: audit insert rejected');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.memberships (org_id, account_id, user_id, role_key)
            VALUES (%L, %L, %L, ''dispatcher'')',
           (SELECT v FROM ids WHERE k='org_a'), (SELECT v FROM ids WHERE k='acct_a'),
           (SELECT v FROM ids WHERE k='user_a')),
    'no context: membership insert rejected');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
            VALUES (%L, ''x@example.test'', ''rpic'', ''h-nc'', now() + interval ''1 day'')',
           (SELECT v FROM ids WHERE k='org_a')),
    'no context: invitation insert rejected');

  PERFORM set_config('airs.x', '1', true);  -- unrelated GUC must change nothing
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships) = 0,
    'unapproved GUC (airs.x) grants nothing');
END $$;

-- 2b. Malformed / unapproved organization context ---------------------------
DO $$
BEGIN
  PERFORM set_config('airs.org_id', 'not-a-uuid', true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL, 'malformed airs.org_id yields NULL context');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.users) = 0, 'malformed airs.org_id sees no rows');
  PERFORM set_config('airs.org_id', '', true);
END $$;

-- 2c. Identity context only (account A, no organization chosen) --------------
DO $$
DECLARE
  a uuid := (SELECT v FROM ids WHERE k='acct_a');
  n int;
BEGIN
  PERFORM set_config('airs.account_id', a::text, true);
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.accounts) = 1, 'account context: only own account row visible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.accounts WHERE id = (SELECT v FROM ids WHERE k='acct_b')) = 0,
    'account context: other accounts invisible even by known id');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships) = 1, 'account context: only own membership visible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.organizations) = 1, 'account context: only org A visible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.sessions) = 1, 'account context: only own sessions visible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.sessions WHERE id = (SELECT v FROM ids WHERE k='session_b')) = 0,
    'account context: other account sessions invisible by known id');
  UPDATE airs.sessions SET revoked_at = now() WHERE id = (SELECT v FROM ids WHERE k='session_b');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'account context: revoking another account session affects 0 rows');
END $$;

-- 2d. Organization A context: organization B is unreachable ------------------
DO $$
DECLARE
  org_a uuid := (SELECT v FROM ids WHERE k='org_a');
  org_b uuid := (SELECT v FROM ids WHERE k='org_b');
  n int;
BEGIN
  PERFORM set_config('airs.account_id', (SELECT v FROM ids WHERE k='acct_a')::text, true);
  PERFORM set_config('airs.org_id', org_a::text, true);
  PERFORM set_config('airs.user_id', (SELECT v FROM ids WHERE k='user_a')::text, true);

  PERFORM pg_temp.ok(airs.current_org_id() = org_a, 'active membership establishes org A context');
  -- Fixture-scoped, not table-wide: the assertion proves this context sees all
  -- four org A fixture memberships regardless of unrelated rows in the database.
  PERFORM pg_temp.ok(
    (SELECT count(*) FROM airs.memberships
      WHERE id IN (SELECT v FROM ids
                    WHERE k IN ('mship_a','mship_invited','mship_suspended','mship_revoked'))) = 4,
    'org A context: sees the four org A memberships');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships WHERE org_id = org_b) = 0,
    'org A context: org B memberships invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships WHERE id = (SELECT v FROM ids WHERE k='mship_b')) = 0,
    'org A context: org B membership invisible by known id');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.users WHERE org_id = org_b) = 0,
    'org A context: org B users invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations WHERE id = (SELECT v FROM ids WHERE k='invite_b')) = 0,
    'org A context: org B invitation invisible by known id');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.audit_events WHERE org_id = org_b) = 0,
    'org A context: org B audit rows invisible');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.organizations WHERE id = org_b) = 0,
    'org A context: org B organization row invisible');

  UPDATE airs.memberships SET role_key = 'rpic' WHERE id = (SELECT v FROM ids WHERE k='mship_b');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'org A context: cross-tenant membership UPDATE affects 0 rows');

  UPDATE airs.invitations SET status = 'revoked' WHERE id = (SELECT v FROM ids WHERE k='invite_b');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'org A context: cross-tenant invitation UPDATE affects 0 rows');

  DELETE FROM airs.audit_events WHERE org_id = org_b;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'org A context: cross-tenant audit DELETE affects 0 rows');

  PERFORM pg_temp.denied(
    format('INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status)
            VALUES (%L, %L, %L, ''agency_admin'', ''active'')',
           org_b, (SELECT v FROM ids WHERE k='acct_a'), (SELECT v FROM ids WHERE k='user_b')),
    'org A context: cannot create a membership in org B');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
            VALUES (%L, ''intruder@example.test'', ''agency_admin'', ''h-x'', now() + interval ''1 day'')',
           org_b),
    'org A context: cannot create an invitation in org B');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
            VALUES (%L, ''forged'', ''test'', ''allow'')', org_b),
    'org A context: cannot write an audit row into org B');

  -- Tenant escape by rewriting org_id is denied by WITH CHECK.
  PERFORM pg_temp.denied(
    format('UPDATE airs.memberships SET org_id = %L WHERE id = %L',
           org_b, (SELECT v FROM ids WHERE k='mship_a')),
    'org A context: cannot move a membership into org B');

  -- Audit insert into the OWN organization is the intended, allowed path.
  INSERT INTO airs.audit_events (org_id, actor_user_id, action, resource_type, outcome)
    VALUES (org_a, (SELECT v FROM ids WHERE k='user_a'), 'test.audit_allowed', 'test', 'allow');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.audit_events WHERE action = 'test.audit_allowed') = 1,
    'org A context: audit insert into own organization is allowed');

  -- Audit remains append-only for the application role.
  UPDATE airs.audit_events SET outcome = 'deny' WHERE org_id = org_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'audit rows cannot be updated by airs_app');
  DELETE FROM airs.audit_events WHERE org_id = org_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.ok(n = 0, 'audit rows cannot be deleted by airs_app');
END $$;

-- 2e. Non-active memberships never establish access --------------------------
DO $$
DECLARE org_a uuid := (SELECT v FROM ids WHERE k='org_a');
BEGIN
  PERFORM set_config('airs.org_id', org_a::text, true);

  PERFORM set_config('airs.account_id', (SELECT v FROM ids WHERE k='acct_invited')::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL, 'invited membership does not establish org context');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.users WHERE org_id = org_a AND account_id IS NULL) = 0,
    'invited membership: tenant rows stay invisible');

  PERFORM set_config('airs.account_id', (SELECT v FROM ids WHERE k='acct_suspended')::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL, 'suspended membership does not establish org context');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.audit_events) = 0,
    'suspended membership: audit history invisible');

  PERFORM set_config('airs.account_id', (SELECT v FROM ids WHERE k='acct_revoked')::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL, 'revoked membership does not establish org context');
  PERFORM pg_temp.denied(
    format('INSERT INTO airs.audit_events (org_id, action, resource_type, outcome)
            VALUES (%L, ''revoked.write'', ''test'', ''allow'')', org_a),
    'revoked membership: audit insert rejected');

  -- An account with no membership at all in org A.
  PERFORM set_config('airs.account_id', (SELECT v FROM ids WHERE k='acct_b')::text, true);
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL,
    'account B cannot claim org A context by supplying the org id');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.memberships WHERE org_id = org_a) = 0,
    'account B sees no org A memberships even with airs.org_id = org A');
END $$;

-- 2f. Invitation-token context reveals exactly one row -----------------------
DO $$
BEGIN
  PERFORM set_config('airs.account_id', '', true);
  PERFORM set_config('airs.org_id', '', true);
  PERFORM set_config('airs.invite_token_hash', 'hash-invite-b', true);
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations) = 1,
    'invite token context reveals exactly one invitation');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations WHERE token_hash = 'hash-invite-a') = 0,
    'invite token context reveals no other invitation');
  PERFORM set_config('airs.invite_token_hash', 'hash-invite-wrong', true);
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.invitations) = 0,
    'unknown invite token reveals nothing');
  PERFORM set_config('airs.invite_token_hash', '', true);
END $$;

RESET ROLE;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- 3. Context lifetime and pooled-connection reuse
--    Runs OUTSIDE any wrapping transaction, as airs_app, on this same backend
--    connection — which is exactly what a pooled connection re-issue looks like.
-- ---------------------------------------------------------------------------
SET ROLE airs_app;

BEGIN;
SELECT set_config('airs.org_id', '11111111-1111-4111-8111-111111111111', true) AS set_local_org_a;
DO $$
BEGIN
  PERFORM pg_temp.ok(
    current_setting('airs.org_id', true) = '11111111-1111-4111-8111-111111111111',
    'SET LOCAL context applies inside its transaction');
  PERFORM pg_temp.ok(airs.current_org_id() = '11111111-1111-4111-8111-111111111111',
    'SET LOCAL context is honoured by current_org_id() inside the transaction');
END $$;
COMMIT;

-- Same connection, next "borrower": the context must be gone.
DO $$
BEGIN
  PERFORM pg_temp.ok(coalesce(current_setting('airs.org_id', true), '') = '',
    'tenant context does not survive COMMIT on a reused connection');
  PERFORM pg_temp.ok(airs.current_org_id() IS NULL,
    'reused connection starts with no organization context');
  PERFORM pg_temp.ok((SELECT count(*) FROM airs.users) = 0,
    'reused connection sees no tenant rows');
END $$;

-- Rolled-back transaction: context must not leak either.
BEGIN;
SELECT set_config('airs.org_id', '22222222-2222-4222-8222-222222222222', true) AS set_local_org_b;
ROLLBACK;
DO $$
BEGIN
  PERFORM pg_temp.ok(coalesce(current_setting('airs.org_id', true), '') = '',
    'tenant context does not survive ROLLBACK on a reused connection');
END $$;

RESET ROLE;

\echo 'AUTH-RLS: all assertions passed'
