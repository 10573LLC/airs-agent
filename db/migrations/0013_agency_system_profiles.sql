BEGIN;

-- Proposed AIRS agency Systems & Integrations persistence.
-- Stores agency-declared usage only. No credentials, tokens, connector
-- authorization, or data-access grants are stored in these tables.

CREATE TABLE airs.agency_system_profiles (
  org_id          uuid PRIMARY KEY REFERENCES airs.organizations(id) ON DELETE CASCADE,
  version         int NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user uuid REFERENCES airs.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airs.agency_system_ecosystems (
  org_id            uuid NOT NULL REFERENCES airs.agency_system_profiles(org_id) ON DELETE CASCADE,
  ecosystem_id      text NOT NULL CHECK (length(btrim(ecosystem_id)) BETWEEN 1 AND 120),
  usage_status      text NOT NULL DEFAULT 'in_use' CHECK (usage_status IN ('in_use','planned')),
  confirmed_by_user uuid REFERENCES airs.users(id) ON DELETE SET NULL,
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, ecosystem_id)
);
CREATE TABLE airs.agency_system_components (
  org_id            uuid NOT NULL REFERENCES airs.agency_system_profiles(org_id) ON DELETE CASCADE,
  component_id      text NOT NULL CHECK (length(btrim(component_id)) BETWEEN 1 AND 160),
  usage_status      text NOT NULL DEFAULT 'in_use' CHECK (usage_status IN ('in_use','planned')),
  source            text NOT NULL DEFAULT 'agency_confirmed' CHECK (source = 'agency_confirmed'),
  confirmed_by_user uuid REFERENCES airs.users(id) ON DELETE SET NULL,
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, component_id)
);

CREATE INDEX agency_system_ecosystems_org_status_idx
  ON airs.agency_system_ecosystems (org_id, usage_status, ecosystem_id);
CREATE INDEX agency_system_components_org_status_idx
  ON airs.agency_system_components (org_id, usage_status, component_id);

ALTER TABLE airs.agency_system_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.agency_system_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE airs.agency_system_ecosystems ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.agency_system_ecosystems FORCE ROW LEVEL SECURITY;
ALTER TABLE airs.agency_system_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.agency_system_components FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON airs.agency_system_profiles TO airs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON airs.agency_system_ecosystems TO airs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON airs.agency_system_components TO airs_app;

CREATE POLICY agency_system_profiles_read ON airs.agency_system_profiles FOR SELECT
  USING (org_id = airs.current_org_id());
CREATE POLICY agency_system_profiles_insert ON airs.agency_system_profiles FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_profiles_update ON airs.agency_system_profiles FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_profiles_delete ON airs.agency_system_profiles FOR DELETE
  USING (org_id = airs.current_org_id());

CREATE POLICY agency_system_ecosystems_read ON airs.agency_system_ecosystems FOR SELECT
  USING (org_id = airs.current_org_id());
CREATE POLICY agency_system_ecosystems_insert ON airs.agency_system_ecosystems FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_ecosystems_update ON airs.agency_system_ecosystems FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_ecosystems_delete ON airs.agency_system_ecosystems FOR DELETE
  USING (org_id = airs.current_org_id());
CREATE POLICY agency_system_components_read ON airs.agency_system_components FOR SELECT
  USING (org_id = airs.current_org_id());
CREATE POLICY agency_system_components_insert ON airs.agency_system_components FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_components_update ON airs.agency_system_components FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY agency_system_components_delete ON airs.agency_system_components FOR DELETE
  USING (org_id = airs.current_org_id());

COMMENT ON TABLE airs.agency_system_profiles IS
  'Agency-declared technology profile. Connector credentials and authorization are stored elsewhere.';
COMMENT ON TABLE airs.agency_system_ecosystems IS
  'Agency-confirmed technology ecosystems used only to drive advisory catalog suggestions.';
COMMENT ON TABLE airs.agency_system_components IS
  'Agency-confirmed catalog components. Presence never grants connector access or credentials.';

COMMIT;
