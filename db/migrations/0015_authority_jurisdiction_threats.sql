-- Authority/jurisdiction and threat-hypothesis plane for live incident rooms.
-- Records are operator-confirmed incident facts or hypotheses, never AI legal conclusions.
-- Unified Command coordinates authorities; it never transfers statutory jurisdiction.
BEGIN;

CREATE TABLE airs.incident_authorities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id        uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  domain             text NOT NULL CHECK (length(btrim(domain)) BETWEEN 2 AND 160),
  authority_holder   text NOT NULL CHECK (length(btrim(authority_holder)) BETWEEN 2 AND 240),
  authority_type     text NOT NULL CHECK (authority_type IN (
    'jurisdictional','regulatory','functional','command','investigative','protective','delegated','supporting')),
  geographic_scope   text NOT NULL DEFAULT '',
  functional_scope   text NOT NULL DEFAULT '',
  basis_type         text NOT NULL DEFAULT 'unresolved' CHECK (basis_type IN (
    'baseline','incident_confirmed','claimed','delegated','unresolved')),
  basis_reference    text NOT NULL DEFAULT '',
  source_reference   text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','superseded','ended')),
  limitations        text NOT NULL DEFAULT '',
  confidence         text NOT NULL DEFAULT 'reported' CHECK (confidence IN ('confirmed','probable','reported','unresolved')),
  effective_from     timestamptz NOT NULL DEFAULT now(),
  effective_to       timestamptz,
  created_by_account uuid REFERENCES airs.accounts(id),
  updated_by_account uuid REFERENCES airs.accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX incident_authorities_incident_idx
  ON airs.incident_authorities (incident_id, status, domain, created_at);

CREATE TABLE airs.incident_threat_hypotheses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id             uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  hypothesis_type         text NOT NULL CHECK (hypothesis_type IN (
    'secondary_assault','follow_on_uas','responder_targeting','coordinated_attack',
    'explosive_hazard','cbrne','other')),
  title                   text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 240),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','supported','reduced','ruled_out','confirmed')),
  confidence              text NOT NULL DEFAULT 'unknown' CHECK (confidence IN ('unknown','low','medium','high')),
  rationale               text NOT NULL DEFAULT '',
  indicators              text[] NOT NULL DEFAULT '{}',
  protective_implications text NOT NULL DEFAULT '',
  source_basis            text NOT NULL DEFAULT '',
  last_assessed_at        timestamptz NOT NULL DEFAULT now(),
  created_by_account      uuid REFERENCES airs.accounts(id),
  updated_by_account      uuid REFERENCES airs.accounts(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_threat_hypotheses_incident_idx
  ON airs.incident_threat_hypotheses (incident_id, status, hypothesis_type, updated_at DESC);
CREATE TRIGGER incident_authorities_guard
BEFORE INSERT OR UPDATE ON airs.incident_authorities
FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();

CREATE TRIGGER incident_threat_hypotheses_guard
BEFORE INSERT OR UPDATE ON airs.incident_threat_hypotheses
FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incident_authorities','incident_threat_hypotheses'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

CREATE POLICY incident_authorities_read ON airs.incident_authorities FOR SELECT
USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_authorities_write ON airs.incident_authorities FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

CREATE POLICY incident_threat_hypotheses_read ON airs.incident_threat_hypotheses FOR SELECT
USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_threat_hypotheses_write ON airs.incident_threat_hypotheses FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

COMMIT;
