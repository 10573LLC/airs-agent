-- AIRS Agent — Stage 4: authentication, membership, sessions, invitations.
-- Portable PostgreSQL. No vendor extensions, no superuser at runtime.
--
-- Two planes:
--   identity plane  (accounts, sessions, invitation acceptance) — keyed by the
--                   GUC airs.account_id and by presented-token hashes.
--   tenant plane    (everything else) — keyed by the GUC airs.org_id, unchanged.
-- Both planes are protected by FORCE ROW LEVEL SECURITY under the unprivileged
-- airs_app role. No policy grants unconditional visibility of tenant data.

BEGIN;

-- Identity-plane session context ---------------------------------------------
CREATE OR REPLACE FUNCTION airs.current_account_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('airs.account_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION airs.ctx(name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting(name, true), '')
$$;

-- Authenticated identities (one per human, spans organizations) ---------------
CREATE TABLE airs.accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     text NOT NULL,
  display_name              text NOT NULL,
  -- NULL when an external IdP (OIDC) owns the credential.
  password_hash             text,
  password_algo             text NOT NULL DEFAULT 'pbkdf2-sha256-210000',
  external_issuer           text,
  external_subject          text,
  -- MFA is designed for but NOT implemented; these columns are reserved.
  mfa_enrolled              boolean NOT NULL DEFAULT false,
  mfa_secret_ciphertext     text,
  status                    text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','disabled')),
  failed_login_count        int NOT NULL DEFAULT 0,
  last_login_at             timestamptz,
  password_reset_token_hash text,
  password_reset_expires_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_email_key ON airs.accounts (lower(email));
CREATE UNIQUE INDEX accounts_external_key ON airs.accounts (external_issuer, external_subject)
  WHERE external_subject IS NOT NULL;

-- The existing per-tenant user record is now bound to a global account.
ALTER TABLE airs.users ADD COLUMN account_id uuid REFERENCES airs.accounts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX users_org_account_key ON airs.users (org_id, account_id)
  WHERE account_id IS NOT NULL;

-- Organization membership -----------------------------------------------------
CREATE TABLE airs.memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES airs.accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES airs.users(id) ON DELETE CASCADE,
  role_key     text NOT NULL REFERENCES airs.roles(key) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'invited'
               CHECK (status IN ('invited','active','suspended','revoked')),
  invited_by   uuid REFERENCES airs.users(id),
  invited_at   timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id)
);
CREATE INDEX memberships_account_idx ON airs.memberships (account_id, status);

-- Sessions (opaque token; only the SHA-256 hash is stored) ---------------------
CREATE TABLE airs.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES airs.accounts(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  active_org_id uuid REFERENCES airs.organizations(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip_address    inet,
  user_agent    text
);
CREATE INDEX sessions_account_idx ON airs.sessions (account_id);

-- Invitations ------------------------------------------------------------------
CREATE TABLE airs.invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  email               text NOT NULL,
  role_key            text NOT NULL REFERENCES airs.roles(key) ON DELETE RESTRICT,
  token_hash          text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by          uuid REFERENCES airs.users(id),
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_account_id uuid REFERENCES airs.accounts(id),
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_key ON airs.invitations (org_id, lower(email))
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Grants + forced RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','memberships','sessions','invitations'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

-- accounts: an account is visible to itself, or during an explicit e-mail
-- lookup that the server performs for sign-in / invitation binding. Accounts
-- hold no tenant data.
CREATE POLICY account_self_read ON airs.accounts FOR SELECT
  USING (id = airs.current_account_id() OR lower(email) = lower(coalesce(airs.ctx('airs.login_email'), '~none~')));
CREATE POLICY account_register ON airs.accounts FOR INSERT
  WITH CHECK (lower(email) = lower(coalesce(airs.ctx('airs.login_email'), '~none~')));
CREATE POLICY account_self_write ON airs.accounts FOR UPDATE
  USING (id = airs.current_account_id() OR lower(email) = lower(coalesce(airs.ctx('airs.login_email'), '~none~')))
  WITH CHECK (id = airs.current_account_id() OR lower(email) = lower(coalesce(airs.ctx('airs.login_email'), '~none~')));

-- Password recovery: an unexpired reset token hash reveals exactly its own row.
CREATE POLICY account_reset_read ON airs.accounts FOR SELECT
  USING (password_reset_token_hash IS NOT NULL
         AND password_reset_token_hash = coalesce(airs.ctx('airs.password_reset_hash'), '~none~')
         AND password_reset_expires_at > now());

-- sessions: the presented token, or every session of the current account.
CREATE POLICY session_read ON airs.sessions FOR SELECT
  USING (token_hash = coalesce(airs.ctx('airs.session_token_hash'), '~none~')
         OR account_id = airs.current_account_id());
CREATE POLICY session_create ON airs.sessions FOR INSERT
  WITH CHECK (account_id = airs.current_account_id());
CREATE POLICY session_write ON airs.sessions FOR UPDATE
  USING (account_id = airs.current_account_id())
  WITH CHECK (account_id = airs.current_account_id());
CREATE POLICY session_delete ON airs.sessions FOR DELETE
  USING (account_id = airs.current_account_id());

-- memberships: your own rows (to pick an organization), or the rows of the
-- organization you are currently acting in. Writes always need tenant context.
CREATE POLICY membership_read ON airs.memberships FOR SELECT
  USING (account_id = airs.current_account_id() OR org_id = airs.current_org_id());
CREATE POLICY membership_insert ON airs.memberships FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY membership_update ON airs.memberships FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- invitations: tenant rows, plus exactly the row whose token was presented.
CREATE POLICY invitation_read ON airs.invitations FOR SELECT
  USING (org_id = airs.current_org_id()
         OR token_hash = coalesce(airs.ctx('airs.invite_token_hash'), '~none~'));
CREATE POLICY invitation_insert ON airs.invitations FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY invitation_update ON airs.invitations FOR UPDATE
  USING (org_id = airs.current_org_id()
         OR token_hash = coalesce(airs.ctx('airs.invite_token_hash'), '~none~'))
  WITH CHECK (org_id = airs.current_org_id()
         OR token_hash = coalesce(airs.ctx('airs.invite_token_hash'), '~none~'));

-- organizations: also visible to an account that holds a membership in them,
-- so the organization selector can be rendered before a tenant is chosen.
CREATE POLICY org_via_membership ON airs.organizations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM airs.memberships m
    WHERE m.org_id = airs.organizations.id
      AND m.account_id = airs.current_account_id()
  ));

-- users: an account may read its own user record in any organization it holds
-- a membership in (needed while binding an invitation / resolving identity).
CREATE POLICY user_self_identity ON airs.users FOR SELECT
  USING (account_id IS NOT NULL AND account_id = airs.current_account_id());

-- audit: identity-plane events (sign-in, sign-out, session revoked) are written
-- before a tenant context exists. They are still constrained to organizations
-- the acting account actually belongs to.
CREATE POLICY audit_identity_insert ON airs.audit_events FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM airs.memberships m
    WHERE m.org_id = airs.audit_events.org_id
      AND m.account_id = airs.current_account_id()
  ));

COMMIT;