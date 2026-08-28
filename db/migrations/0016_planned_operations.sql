BEGIN;

-- Planned operations extend the existing incident-room model rather than
-- creating a parallel event-planning product. A planned_event may be built in
-- draft, staged while scheduled, and fully operational while active before any
-- emergency occurs. Operational condition is separate from lifecycle state.

ALTER TABLE airs.incident_ics_profiles
  ADD COLUMN operational_condition text NOT NULL DEFAULT 'nominal'
  CHECK (operational_condition IN ('nominal','elevated','emergency','recovery'));

CREATE TABLE airs.incident_coordination_partners (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id           uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  partner_org_id        uuid REFERENCES airs.organizations(id) ON DELETE SET NULL,
  organization_name     text NOT NULL CHECK (length(btrim(organization_name)) BETWEEN 1 AND 240),
  operational_role      text NOT NULL DEFAULT '' CHECK (length(operational_role) <= 500),
  command_post_role     text NOT NULL DEFAULT '' CHECK (length(command_post_role) <= 300),
  connection_mode       text NOT NULL DEFAULT 'external_liaison' CHECK (connection_mode IN (
                          'airs','external_liaison','emergency_communications','radio','phone','email','other')),
  participation_state   text NOT NULL DEFAULT 'planned' CHECK (participation_state IN (
                          'planned','invited','confirmed','on_scene','active','released','cancelled')),
  primary_contact       text NOT NULL DEFAULT '' CHECK (length(primary_contact) <= 240),
  notes                 text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  planned_from          timestamptz,
  planned_to            timestamptz,
  created_by_account    uuid REFERENCES airs.accounts(id),
  updated_by_account    uuid REFERENCES airs.accounts(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_to IS NULL OR planned_from IS NULL OR planned_to > planned_from)
);

CREATE INDEX incident_coordination_partners_incident_idx
  ON airs.incident_coordination_partners (incident_id, participation_state, organization_name);

CREATE TRIGGER incident_coordination_partners_guard
  BEFORE INSERT OR UPDATE ON airs.incident_coordination_partners
  FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();

ALTER TABLE airs.incident_coordination_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.incident_coordination_partners FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON airs.incident_coordination_partners TO airs_app;

CREATE POLICY incident_coordination_partners_read
  ON airs.incident_coordination_partners FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_coordination_partners_write
  ON airs.incident_coordination_partners FOR ALL
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
-- Coordination roster is informational/operational context only. A row with
-- connection_mode='airs' does NOT create incident access; incident_participants
-- remains the sole source of partner authorization.

COMMIT;
