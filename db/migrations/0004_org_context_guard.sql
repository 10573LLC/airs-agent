-- AIRS Agent — Stage 4b: organization-context guard (defence in depth).
--
-- Problem this closes: every tenant policy trusts the session GUC airs.org_id.
-- The application only sets that GUC after validating an ACTIVE membership
-- (src/lib/auth/authorize.server.ts), but the database itself did not check.
-- A bug in a future endpoint that forwarded a client-supplied organization id
-- would therefore have reached another tenant's rows.
--
-- After this migration the identity plane constrains the tenant plane:
--
--   * no airs.org_id                       -> NULL (default deny, unchanged)
--   * airs.org_id set, no airs.account_id  -> the org id (migration/administrative
--                                             and tenant-only paths, unchanged)
--   * airs.org_id + airs.account_id        -> the org id ONLY IF that account holds
--                                             an ACTIVE membership in it, or is
--                                             redeeming an invitation for it
--   * anything else                        -> NULL, so every policy denies
--
-- SECURITY DEFINER is required: the lookup reads airs.memberships, whose own
-- policies call this function. Running the lookup as the owner both prevents
-- recursion and keeps the check honest for the unprivileged airs_app role.

BEGIN;

CREATE OR REPLACE FUNCTION airs.current_org_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE
  requested uuid;
  acct      uuid;
  invite    text;
BEGIN
  BEGIN
    requested := NULLIF(current_setting('airs.org_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    -- A malformed airs.org_id is treated as no context at all, never as a match.
    RETURN NULL;
  END;
  IF requested IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    acct := NULLIF(current_setting('airs.account_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  -- Tenant-only context (migrations, RLS matrix, background jobs).
  IF acct IS NULL THEN
    RETURN requested;
  END IF;

  IF EXISTS (
    SELECT 1 FROM airs.memberships m
     WHERE m.org_id = requested AND m.account_id = acct AND m.status = 'active'
  ) THEN
    RETURN requested;
  END IF;

  -- Invitation redemption: the membership does not exist yet, so the presented
  -- invitation token is what authorises the organization context.
  invite := NULLIF(current_setting('airs.invite_token_hash', true), '');
  IF invite IS NOT NULL AND EXISTS (
    SELECT 1 FROM airs.invitations i
     WHERE i.org_id = requested
       AND i.token_hash = invite
       AND i.status IN ('pending', 'accepted')
  ) THEN
    RETURN requested;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION airs.current_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.current_org_id() TO airs_app;

-- Identity-plane audit rows may only be written into organizations where the
-- acting account holds an ACTIVE membership.
DROP POLICY IF EXISTS audit_identity_insert ON airs.audit_events;
CREATE POLICY audit_identity_insert ON airs.audit_events FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM airs.memberships m
    WHERE m.org_id = airs.audit_events.org_id
      AND m.account_id = airs.current_account_id()
      AND m.status = 'active'
  ));

COMMIT;
