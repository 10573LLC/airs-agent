-- AIRS Agent — initial schema (portable PostgreSQL 15+, no vendor extensions)
-- Tenancy: every row belongs to an organization. Default deny via RLS.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Application roles used by RLS. The app connects as airs_app (NOT superuser,
-- NOT table owner) so row-level security is always enforced.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_app') THEN
    CREATE ROLE airs_app NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS airs;

-- Session context helpers -----------------------------------------------------
CREATE OR REPLACE FUNCTION airs.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('airs.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION airs.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('airs.user_id', true), '')::uuid
$$;

-- Organizations ---------------------------------------------------------------
CREATE TABLE airs.organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  agency_type  text NOT NULL CHECK (agency_type IN ('law_enforcement','county','fire','ems','other')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Users (identity records; credentials live in the auth adapter) --------------
CREATE TABLE airs.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  email_address  text NOT NULL,
  display_name   text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  external_subject text,        -- subject id from the auth adapter (OIDC sub, etc.)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email_address)
);

-- Roles / permissions ---------------------------------------------------------
CREATE TABLE airs.roles (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL
);

CREATE TABLE airs.permissions (
  key         text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE airs.role_permissions (
  role_key       text NOT NULL REFERENCES airs.roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES airs.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

-- Role assignments are per organization (tenant scoped) -----------------------
CREATE TABLE airs.user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES airs.users(id) ON DELETE CASCADE,
  role_key   text NOT NULL REFERENCES airs.roles(key) ON DELETE RESTRICT,
  granted_by uuid REFERENCES airs.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, role_key)
);

-- Incidents (rooms) -----------------------------------------------------------
CREATE TABLE airs.incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  classification text NOT NULL DEFAULT 'restricted'
                 CHECK (classification IN ('public','restricted','sensitive')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  retain_until  timestamptz,
  created_by    uuid REFERENCES airs.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Cross-agency sharing grants (time boxed, revoked when incident closes) ------
CREATE TABLE airs.incident_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE, -- owning org
  incident_id     uuid NOT NULL REFERENCES airs.incidents(id) ON DELETE CASCADE,
  partner_org_id  uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  scope           text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','contribute')),
  granted_by      uuid REFERENCES airs.users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (incident_id, partner_org_id)
);

-- Airspace operations ---------------------------------------------------------
CREATE TABLE airs.aircraft (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('uas','crewed')),
  registration text NOT NULL,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, registration)
);

CREATE TABLE airs.airspace_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  incident_id   uuid NOT NULL REFERENCES airs.incidents(id) ON DELETE CASCADE,
  aircraft_id   uuid REFERENCES airs.aircraft(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','approved','active','completed','cancelled')),
  -- geometry stored as GeoJSON text so the schema needs no PostGIS dependency
  area_geojson  jsonb,
  altitude_floor_ft int,
  altitude_ceiling_ft int,
  starts_at     timestamptz,
  ends_at       timestamptz,
  approved_by   uuid REFERENCES airs.users(id),
  created_by    uuid REFERENCES airs.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (altitude_ceiling_ft IS NULL OR altitude_floor_ft IS NULL
         OR altitude_ceiling_ft >= altitude_floor_ft)
);

-- Audit log (append only) -----------------------------------------------------
CREATE TABLE airs.audit_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES airs.users(id),
  action       text NOT NULL,
  resource_type text NOT NULL,
  resource_id  text,
  outcome      text NOT NULL CHECK (outcome IN ('allow','deny','error')),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address   inet,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON airs.audit_events (org_id, occurred_at DESC);

-- Retention policy per org ----------------------------------------------------
CREATE TABLE airs.retention_policies (
  org_id             uuid PRIMARY KEY REFERENCES airs.organizations(id) ON DELETE CASCADE,
  incident_days      int NOT NULL DEFAULT 365 CHECK (incident_days > 0),
  audit_days         int NOT NULL DEFAULT 2555 CHECK (audit_days > 0),
  telemetry_days     int NOT NULL DEFAULT 90 CHECK (telemetry_days > 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row-level security: default deny, tenant scoped
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA airs TO airs_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','users','user_roles','incidents','incident_shares',
    'aircraft','airspace_operations','audit_events','retention_policies'
  ] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA airs TO airs_app;
-- Reference tables are read-only to the app.
GRANT SELECT ON airs.roles, airs.permissions, airs.role_permissions TO airs_app;

-- No policy => no access. Policies below grant the minimum.
CREATE POLICY org_self ON airs.organizations
  FOR SELECT USING (id = airs.current_org_id());

CREATE POLICY tenant_rw ON airs.users
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY tenant_rw ON airs.user_roles
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY tenant_rw ON airs.aircraft
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY tenant_rw ON airs.retention_policies
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- Incidents: own org, or an active share to the caller's org.
CREATE POLICY tenant_or_shared_read ON airs.incidents FOR SELECT
  USING (
    org_id = airs.current_org_id()
    OR EXISTS (
      SELECT 1 FROM airs.incident_shares s
      WHERE s.incident_id = airs.incidents.id
        AND s.partner_org_id = airs.current_org_id()
        AND s.revoked_at IS NULL
    )
  );
CREATE POLICY tenant_write ON airs.incidents FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY tenant_update ON airs.incidents FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY tenant_delete ON airs.incidents FOR DELETE
  USING (org_id = airs.current_org_id());

CREATE POLICY share_visibility ON airs.incident_shares FOR SELECT
  USING (org_id = airs.current_org_id() OR partner_org_id = airs.current_org_id());
CREATE POLICY share_owner_write ON airs.incident_shares FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY share_owner_update ON airs.incident_shares FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

CREATE POLICY ops_read ON airs.airspace_operations FOR SELECT
  USING (
    org_id = airs.current_org_id()
    OR EXISTS (
      SELECT 1 FROM airs.incident_shares s
      WHERE s.incident_id = airs.airspace_operations.incident_id
        AND s.partner_org_id = airs.current_org_id()
        AND s.revoked_at IS NULL
    )
  );
CREATE POLICY ops_write ON airs.airspace_operations FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY ops_update ON airs.airspace_operations FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- Audit log: insert + read own tenant only; no update/delete policy = immutable.
CREATE POLICY audit_insert ON airs.audit_events FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY audit_read ON airs.audit_events FOR SELECT
  USING (org_id = airs.current_org_id());

COMMIT;