-- AIRS Agent — Platform administration plane (bootstrap of the first platform owner).
--
-- Purpose: give the product operator (Anconison) an administrative identity that
-- is NOT a member of any participating agency. Platform administration and
-- agency administration are different planes:
--
--   agency plane    — organizations with org_kind = 'agency' (Albany Police
--                     Department, Albany County, ...). Operational records live
--                     here and stay behind the existing forced RLS.
--   platform plane  — a single organization with org_kind = 'platform'. It owns
--                     no incidents, resources, geography or observations, and
--                     the platform_admin role is granted NO operational
--                     permission, so a platform administrator cannot read
--                     agency-owned operational records. Cross-tenant reads stay
--                     impossible: airs.current_org_id() still requires an ACTIVE
--                     membership in the requested organization.
--
-- Nothing here weakens authentication or RLS. The bootstrap routine below is a
-- SECURITY DEFINER function owned by the migration role, deliberately NOT
-- granted to airs_app, and it accepts only a token HASH — never a token.

BEGIN;

-- 1. Organization kind ---------------------------------------------------------
ALTER TABLE airs.organizations
  ADD COLUMN IF NOT EXISTS org_kind text NOT NULL DEFAULT 'agency'
  CHECK (org_kind IN ('agency','platform'));

-- At most one platform organization may exist.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_single_platform
  ON airs.organizations ((org_kind)) WHERE org_kind = 'platform';

-- 2. The platform organization --------------------------------------------------
-- Distinct from, and with no relationship to, the City of Albany tenants.
-- The display name is deliberately plain ASCII: a non-UTF-8 Windows psql client
-- (cp1252 console) mangles a Unicode em dash into '???'. See 0012.
INSERT INTO airs.organizations (id, slug, name, agency_type, org_kind) VALUES
  ('00000000-0000-4000-8000-00000000a123','anconison-platform','Anconison - AIRS Agent Platform','other','platform')
ON CONFLICT (slug) DO UPDATE SET org_kind = 'platform';

INSERT INTO airs.retention_policies (org_id)
VALUES ('00000000-0000-4000-8000-00000000a123')
ON CONFLICT (org_id) DO NOTHING;

-- 3. Platform role ---------------------------------------------------------------
INSERT INTO airs.roles (key, name, description) VALUES
  ('platform_admin', 'Platform Administrator', 'Operates the AIRS Agent platform itself; holds no agency operational permission.')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

-- Deliberately narrow: administration of the platform organization and its
-- own audit trail. No incident.*, resource.*, map.* or observation.* grant.
INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  ('platform_admin','org.manage'),
  ('platform_admin','user.manage'),
  ('platform_admin','audit.read'),
  ('platform_admin','retention.manage')
ON CONFLICT DO NOTHING;

-- 4. Plane separation guard --------------------------------------------------------
-- platform_admin may only exist inside the platform organization, and the
-- platform organization may only hold platform_admin principals. Enforced in
-- the database so no future endpoint can cross the planes.
CREATE OR REPLACE FUNCTION airs.enforce_platform_role_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE is_platform boolean;
BEGIN
  SELECT o.org_kind = 'platform' INTO is_platform
    FROM airs.organizations o WHERE o.id = NEW.org_id;
  IF is_platform IS NULL THEN
    RAISE EXCEPTION 'unknown organization %', NEW.org_id;
  END IF;
  IF NEW.role_key = 'platform_admin' AND NOT is_platform THEN
    RAISE EXCEPTION 'platform_admin is only valid in the platform organization';
  END IF;
  IF is_platform AND NEW.role_key <> 'platform_admin' THEN
    RAISE EXCEPTION 'the platform organization only accepts platform_admin';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS memberships_platform_scope ON airs.memberships;
CREATE TRIGGER memberships_platform_scope
  BEFORE INSERT OR UPDATE OF role_key, org_id ON airs.memberships
  FOR EACH ROW EXECUTE FUNCTION airs.enforce_platform_role_scope();

DROP TRIGGER IF EXISTS user_roles_platform_scope ON airs.user_roles;
CREATE TRIGGER user_roles_platform_scope
  BEFORE INSERT OR UPDATE OF role_key, org_id ON airs.user_roles
  FOR EACH ROW EXECUTE FUNCTION airs.enforce_platform_role_scope();

DROP TRIGGER IF EXISTS invitations_platform_scope ON airs.invitations;
CREATE TRIGGER invitations_platform_scope
  BEFORE INSERT OR UPDATE OF role_key, org_id ON airs.invitations
  FOR EACH ROW EXECUTE FUNCTION airs.enforce_platform_role_scope();

-- 5. Pre-flight identity report -------------------------------------------------
-- Answers "does this address already exist anywhere?" without disclosing
-- credentials, token hashes or any tenant content. Aggregates only.
CREATE OR REPLACE FUNCTION airs.platform_identity_report(p_email text)
RETURNS TABLE (
  account_exists        boolean,
  account_status        text,
  account_has_password  boolean,
  membership_rows       int,
  platform_membership   boolean,
  agency_user_rows      int,
  pending_invitations   int,
  total_invitations     int,
  active_sessions       int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  WITH a AS (
    SELECT id, status, password_hash IS NOT NULL AS has_password
      FROM airs.accounts WHERE lower(email) = lower(p_email)
  )
  SELECT
    EXISTS (SELECT 1 FROM a),
    (SELECT status FROM a),
    coalesce((SELECT has_password FROM a), false),
    (SELECT count(*)::int FROM airs.memberships m WHERE m.account_id IN (SELECT id FROM a)),
    EXISTS (
      SELECT 1 FROM airs.memberships m
        JOIN airs.organizations o ON o.id = m.org_id
       WHERE m.account_id IN (SELECT id FROM a) AND o.org_kind = 'platform'
    ),
    (SELECT count(*)::int FROM airs.users u WHERE lower(u.email_address) = lower(p_email)),
    (SELECT count(*)::int FROM airs.invitations i
      WHERE lower(i.email) = lower(p_email) AND i.status = 'pending'),
    (SELECT count(*)::int FROM airs.invitations i WHERE lower(i.email) = lower(p_email)),
    (SELECT count(*)::int FROM airs.sessions s
      WHERE s.account_id IN (SELECT id FROM a) AND s.revoked_at IS NULL AND s.expires_at > now());
$$;

-- 6. One-time bootstrap invitation ------------------------------------------------
-- Creates (or safely replaces) the single pending platform-administrator
-- invitation for one address. Only the SHA-256 hash of the token is accepted,
-- so no token is ever transmitted to, stored in, or logged by the database.
-- Single use and expiry are enforced by the existing acceptance path.
CREATE OR REPLACE FUNCTION airs.bootstrap_platform_invitation(
  p_email        text,
  p_token_hash   text,
  p_ttl_seconds  int DEFAULT 259200
)
RETURNS TABLE (
  invitation_id uuid,
  org_id        uuid,
  org_slug      text,
  expires_at    timestamptz,
  superseded    int,
  account_exists boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE
  v_org      uuid;
  v_slug     text;
  v_email    text := lower(trim(p_email));
  v_ttl      int  := least(greatest(coalesce(p_ttl_seconds, 259200), 300), 604800);
  v_superseded int;
  v_id       uuid;
  v_expires  timestamptz;
  v_exists   boolean;
BEGIN
  IF v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'invalid e-mail address';
  END IF;
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'token hash must be a 64-character SHA-256 hex digest';
  END IF;

  SELECT o.id, o.slug INTO v_org, v_slug
    FROM airs.organizations o WHERE o.org_kind = 'platform';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no platform organization exists';
  END IF;

  -- Never create a duplicate: any earlier pending invitation for this address
  -- (in any organization) is revoked first, so exactly one link can be redeemed.
  WITH revoked AS (
    UPDATE airs.invitations
       SET status = 'revoked', revoked_at = now(), updated_at = now()
     WHERE lower(email) = v_email AND status = 'pending'
    RETURNING 1
  ) SELECT count(*)::int INTO v_superseded FROM revoked;

  INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
  VALUES (v_org, v_email, 'platform_admin', p_token_hash,
          now() + (v_ttl || ' seconds')::interval)
  RETURNING id, invitations.expires_at INTO v_id, v_expires;

  SELECT EXISTS (SELECT 1 FROM airs.accounts WHERE lower(email) = v_email) INTO v_exists;

  -- Audit: recorded in the platform organization. Contains no token, no hash.
  INSERT INTO airs.audit_events
    (org_id, actor_user_id, action, resource_type, resource_id, outcome, detail)
  VALUES (v_org, NULL, 'platform.bootstrap_invitation_created', 'invitation', v_id, 'allow',
          jsonb_build_object(
            'email', v_email,
            'role_key', 'platform_admin',
            'expires_at', v_expires,
            'superseded_pending', v_superseded,
            'account_existed', v_exists,
            'source', 'cli'));

  RETURN QUERY SELECT v_id, v_org, v_slug, v_expires, v_superseded, v_exists;
END $$;

-- Least privilege: the application role must not be able to mint platform
-- administrators. These routines are for the operator connection only.
REVOKE ALL ON FUNCTION airs.platform_identity_report(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION airs.bootstrap_platform_invitation(text, text, int) FROM PUBLIC;

COMMIT;
