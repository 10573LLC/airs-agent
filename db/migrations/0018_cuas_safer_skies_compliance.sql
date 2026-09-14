-- SAFER SKIES Act / 6 & 28 CFR Part 124 C-UAS compliance plane.
-- Source basis: July 2026 interim final rule materials supplied by the operator.
-- The controlling legal text remains 6 & 28 CFR Part 124; AIRS records compliance
-- facts and workflow state, and must not manufacture legal conclusions.
BEGIN;

CREATE TABLE airs.cuas_agency_profiles (
  org_id                       uuid PRIMARY KEY REFERENCES airs.organizations(id) ON DELETE CASCADE,
  participation_status         text NOT NULL DEFAULT 'not_participating' CHECK (participation_status IN (
    'not_participating','detection_warning','mitigation','correctional_mitigation','suspended')),
  agency_approving_official    text NOT NULL DEFAULT '',
  counsel_reviewer             text NOT NULL DEFAULT '',
  policy_adopted_at            timestamptz,
  annual_attestation_at        timestamptz,
  annual_attestation_due_at    timestamptz,
  federal_portal_reference     text NOT NULL DEFAULT '',
  mutual_aid_authorized        boolean NOT NULL DEFAULT false,
  notes                        text NOT NULL DEFAULT '',
  updated_by_account           uuid REFERENCES airs.accounts(id),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (annual_attestation_due_at IS NULL OR annual_attestation_at IS NULL OR annual_attestation_due_at > annual_attestation_at)
);

CREATE TABLE airs.cuas_personnel_certifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  account_id            uuid REFERENCES airs.accounts(id) ON DELETE SET NULL,
  display_name          text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 240),
  certification_tier    text NOT NULL CHECK (certification_tier IN (
    'detection_warning','mitigation','correctional_mitigation')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','inactive')),
  certified_at          timestamptz,
  suspension_reason     text NOT NULL DEFAULT '',
  source_reference      text NOT NULL DEFAULT '',
  created_by_account    uuid REFERENCES airs.accounts(id),
  updated_by_account    uuid REFERENCES airs.accounts(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cuas_personnel_cert_org_idx
  ON airs.cuas_personnel_certifications (org_id, status, certification_tier, display_name);

CREATE TABLE airs.cuas_equipment_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  system_name           text NOT NULL CHECK (length(btrim(system_name)) BETWEEN 2 AND 240),
  manufacturer          text NOT NULL DEFAULT '',
  model                 text NOT NULL DEFAULT '',
  technology_category   text NOT NULL CHECK (technology_category IN (
    'atl_1_rf_detection_interception','atl_2_rf_protocol_manipulation','atl_3_rf_disruption',
    'camera','radar','acoustic','passive_rf_energy','remote_id','other_non_intercept')),
  asl_status            text NOT NULL DEFAULT 'not_applicable' CHECK (asl_status IN (
    'not_applicable','category_not_populated','listed','not_listed','suspended','unknown')),
  asl_reference         text NOT NULL DEFAULT '',
  faa_spectrum_status   text NOT NULL DEFAULT 'not_applicable' CHECK (faa_spectrum_status IN (
    'not_applicable','required_pending','authorized','expired','unknown')),
  operational_status    text NOT NULL DEFAULT 'available' CHECK (operational_status IN (
    'available','training_only','suspended','out_of_service')),
  notes                 text NOT NULL DEFAULT '',
  created_by_account    uuid REFERENCES airs.accounts(id),
  updated_by_account    uuid REFERENCES airs.accounts(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cuas_equipment_org_idx
  ON airs.cuas_equipment_authorizations (org_id, operational_status, technology_category);

CREATE TABLE airs.cuas_operations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  incident_id                uuid REFERENCES airs.incident_rooms(id) ON DELETE SET NULL,
  operation_name             text NOT NULL CHECK (length(btrim(operation_name)) BETWEEN 2 AND 240),
  operation_type             text NOT NULL CHECK (operation_type IN (
    'planned','standing_fixed_site','major_event','emergency_exception','training_validation')),
  authority_tier             text NOT NULL CHECK (authority_tier IN ('detection_warning','mitigation','non_intercept_only')),
  protected_interest         text NOT NULL CHECK (protected_interest IN (
    'people_facilities_assets','large_public_gathering','critical_infrastructure','correctional_facility')),
  approving_official         text NOT NULL DEFAULT '',
  counsel_certified          boolean NOT NULL DEFAULT false,
  oplan_reference            text NOT NULL DEFAULT '',
  advance_notification_ref   text NOT NULL DEFAULT '',
  federal_coordination       text NOT NULL DEFAULT 'not_required' CHECK (federal_coordination IN (
    'not_required','pending','submitted','coordinated','emergency_followup_due')),
  lead_cuas_agency           text NOT NULL DEFAULT '',
  tactical_coordination_ack  boolean NOT NULL DEFAULT false,
  starts_at                  timestamptz,
  ends_at                    timestamptz,
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','pending_approval','authorized','active','completed','cancelled','suspended')),
  created_by_account         uuid REFERENCES airs.accounts(id),
  updated_by_account         uuid REFERENCES airs.accounts(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX cuas_operations_org_idx
  ON airs.cuas_operations (org_id, status, starts_at DESC);
CREATE INDEX cuas_operations_incident_idx
  ON airs.cuas_operations (incident_id, status) WHERE incident_id IS NOT NULL;

CREATE TABLE airs.cuas_mitigation_actions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id               uuid NOT NULL REFERENCES airs.cuas_operations(id) ON DELETE CASCADE,
  org_id                     uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  operator_certification_id  uuid NOT NULL REFERENCES airs.cuas_personnel_certifications(id) ON DELETE RESTRICT,
  equipment_id               uuid REFERENCES airs.cuas_equipment_authorizations(id) ON DELETE SET NULL,
  credible_threat_basis      text NOT NULL CHECK (length(btrim(credible_threat_basis)) BETWEEN 10 AND 4000),
  first_amendment_excluded   boolean NOT NULL DEFAULT false,
  proportionality_basis      text NOT NULL CHECK (length(btrim(proportionality_basis)) BETWEEN 5 AND 4000),
  action_type                text NOT NULL CHECK (action_type IN (
    'warn','seize','rf_protocol_manipulation','rf_disruption','disable','take_control','damage_destroy')),
  operator_declined          boolean NOT NULL DEFAULT false,
  atc_notified_at            timestamptz,
  action_started_at          timestamptz NOT NULL DEFAULT now(),
  action_ended_at            timestamptz,
  known_effects              text NOT NULL DEFAULT '',
  created_by_account         uuid REFERENCES airs.accounts(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (action_ended_at IS NULL OR action_ended_at >= action_started_at)
);
CREATE INDEX cuas_mitigation_operation_idx
  ON airs.cuas_mitigation_actions (operation_id, action_started_at DESC);

CREATE TABLE airs.cuas_compliance_reports (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  operation_id           uuid REFERENCES airs.cuas_operations(id) ON DELETE CASCADE,
  report_type            text NOT NULL CHECK (report_type IN (
    'oplan_advance_notification','mitigation_post_operation','detection_consolidated',
    'semiannual_summary','quarterly_minimization_review','annual_attestation',
    'certification_roster','authorized_equipment','system_suspension_ack')),
  due_at                 timestamptz,
  submitted_at           timestamptz,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','due','submitted','overdue','not_required')),
  portal_reference       text NOT NULL DEFAULT '',
  content                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_account     uuid REFERENCES airs.accounts(id),
  updated_by_account     uuid REFERENCES airs.accounts(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cuas_reports_org_due_idx
  ON airs.cuas_compliance_reports (org_id, status, due_at);

CREATE TABLE airs.cuas_intercepted_record_controls (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  operation_id           uuid REFERENCES airs.cuas_operations(id) ON DELETE CASCADE,
  record_category        text NOT NULL CHECK (record_category IN ('intercepted_communications','pattern_data','other_protective_record')),
  protective_purpose     text NOT NULL CHECK (length(btrim(protective_purpose)) BETWEEN 5 AND 1000),
  captured_at            timestamptz NOT NULL DEFAULT now(),
  delete_by              timestamptz,
  retention_exception    boolean NOT NULL DEFAULT false,
  exception_basis        text NOT NULL DEFAULT '',
  anonymized             boolean NOT NULL DEFAULT false,
  deleted_at             timestamptz,
  created_by_account     uuid REFERENCES airs.accounts(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (delete_by IS NULL OR delete_by > captured_at),
  CHECK (retention_exception = false OR length(btrim(exception_basis)) >= 5)
);
CREATE INDEX cuas_intercepted_controls_due_idx
  ON airs.cuas_intercepted_record_controls (org_id, delete_by) WHERE deleted_at IS NULL;

-- Automatically create the 48-hour mitigation report deadline.
CREATE OR REPLACE FUNCTION airs.cuas_queue_mitigation_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_temp AS $$
BEGIN
  INSERT INTO airs.cuas_compliance_reports (
    org_id, operation_id, report_type, due_at, status, content, created_by_account, updated_by_account
  ) VALUES (
    NEW.org_id,
    NEW.operation_id,
    'mitigation_post_operation',
    NEW.action_started_at + interval '48 hours',
    'due',
    jsonb_build_object(
      'action_id', NEW.id,
      'action_started_at', NEW.action_started_at,
      'known_effects', NEW.known_effects
    ),
    NEW.created_by_account,
    NEW.created_by_account
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER cuas_mitigation_report_due
AFTER INSERT ON airs.cuas_mitigation_actions
FOR EACH ROW EXECUTE FUNCTION airs.cuas_queue_mitigation_report();

-- Default intercepted communications retention target: 180 days unless an
-- operator records a narrower documented exception path later.
CREATE OR REPLACE FUNCTION airs.cuas_default_delete_by() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_category = 'intercepted_communications' AND NEW.delete_by IS NULL THEN
    NEW.delete_by := NEW.captured_at + interval '180 days';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cuas_intercepted_default_delete_by
BEFORE INSERT ON airs.cuas_intercepted_record_controls
FOR EACH ROW EXECUTE FUNCTION airs.cuas_default_delete_by();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cuas_agency_profiles','cuas_personnel_certifications','cuas_equipment_authorizations',
    'cuas_operations','cuas_mitigation_actions','cuas_compliance_reports','cuas_intercepted_record_controls'
  ] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

CREATE POLICY cuas_agency_profiles_tenant ON airs.cuas_agency_profiles FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_personnel_tenant ON airs.cuas_personnel_certifications FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_equipment_tenant ON airs.cuas_equipment_authorizations FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_operations_tenant ON airs.cuas_operations FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_actions_tenant ON airs.cuas_mitigation_actions FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_reports_tenant ON airs.cuas_compliance_reports FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY cuas_intercepted_tenant ON airs.cuas_intercepted_record_controls FOR ALL
USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

COMMIT;
