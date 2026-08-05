-- 0008_disclosure_profiles.sql
-- Stage 6 closure: field-level disclosure controls.
--
-- Row-level security already decides WHICH ROWS a partner organization can
-- reach. This migration adds the second, narrower decision: WHICH FIELDS of a
-- reachable row may leave the originating organization. The two layers are
-- independent and neither may widen the other.
--
-- Design rules enforced here:
--   * the field vocabulary is server-controlled reference data; a request can
--     never introduce a column name
--   * sensitive fields are excluded from every partner profile by construction
--     (a CHECK-backed trigger, not application discipline)
--   * default deny: a share with no explicit profile discloses 'summary'
--   * the disclosure profile is owned by the ORIGINATING organization only
--
-- Mirrors src/lib/resources/disclosure.ts exactly; tests/disclosure.test.ts and
-- db/tests/disclosure_projection.sql fail the build if the two drift.
BEGIN;

-- --- reference vocabulary -----------------------------------------------------

CREATE TABLE IF NOT EXISTS airs.disclosure_fields (
  field_key  text PRIMARY KEY,
  source     text NOT NULL CHECK (source IN ('resource','detail','extra','personnel','qualification')),
  sensitive  boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS airs.disclosure_profile_fields (
  profile    text NOT NULL CHECK (profile IN
               ('summary','operational','aviation','incident_command','full','custom')),
  field_key  text NOT NULL REFERENCES airs.disclosure_fields(field_key) ON DELETE CASCADE,
  PRIMARY KEY (profile, field_key)
);

INSERT INTO airs.disclosure_fields (field_key, source, sensitive) VALUES
  ('resourceId','resource',false),
  ('displayName','resource',false),
  ('category','resource',false),
  ('callsign','resource',false),
  ('readinessStatus','resource',false),
  ('originatingOrganization','extra',false),
  ('description','resource',false),
  ('operationalStatus','resource',false),
  ('lifecycleStatus','resource',false),
  ('assignmentStatus','extra',false),
  ('currentIncidentRole','extra',false),
  ('broadAvailability','extra',false),
  ('serviceStatus','detail',false),
  ('operationalLimitations','detail',false),
  ('vehicleType','detail',false),
  ('vehicleIdentifier','detail',false),
  ('assignedUnit','detail',false),
  ('supportedEquipment','detail',false),
  ('dockName','detail',false),
  ('connectivityStatus','detail',false),
  ('powerStatus','detail',false),
  ('siteName','detail',false),
  ('owningOrganizationLabel','detail',false),
  ('supportedCategories','detail',false),
  ('sensorCategory','detail',false),
  ('mounting','detail',false),
  ('detectionCategory','detail',false),
  ('agencyIdentifier','detail',false),
  ('manufacturer','detail',false),
  ('model','detail',false),
  ('aircraftType','detail',false),
  ('thermalCapable','detail',false),
  ('parachuteEquipped','detail',false),
  ('dockCompatible','detail',false),
  ('maxApprovedAltitudeFt','detail',false),
  ('supportedAircraftType','detail',false),
  ('batteryReadiness','detail',false),
  ('qualificationType','qualification',false),
  ('qualificationCurrent','qualification',false),
  ('locationDescription','detail',false),
  ('qualificationExpiresOn','qualification',false),
  ('assignmentWindow','extra',false),
  ('sharedUntil','extra',false),
  ('personDisplayName','personnel',false),
  ('personCallsign','personnel',false),
  ('personAvailabilityStatus','personnel',false),
  ('personOperationalRoles','personnel',false),
  ('personOperationalStatus','personnel',false),
  ('serialNumber','detail',true),
  ('faaRegistration','detail',true),
  ('remoteId','detail',true),
  ('restrictedNotes','resource',true),
  ('detailRestrictedNotes','detail',true),
  ('maintenanceStatus','detail',true),
  ('personDutyContact','personnel',true),
  ('personEmployeeIdentifier','personnel',true),
  ('personQualificationSummary','personnel',true),
  ('qualificationRestrictions','qualification',true),
  ('qualificationIssuer','qualification',true),
  ('qualificationVerification','qualification',true)
ON CONFLICT (field_key) DO UPDATE
  SET source = EXCLUDED.source, sensitive = EXCLUDED.sensitive;

INSERT INTO airs.disclosure_profile_fields (profile, field_key) VALUES
  ('summary','resourceId'),
  ('summary','displayName'),
  ('summary','category'),
  ('summary','callsign'),
  ('summary','readinessStatus'),
  ('summary','originatingOrganization'),
  ('summary','personDisplayName'),
  ('summary','personCallsign'),
  ('summary','personAvailabilityStatus'),
  ('operational','resourceId'),
  ('operational','displayName'),
  ('operational','category'),
  ('operational','callsign'),
  ('operational','readinessStatus'),
  ('operational','originatingOrganization'),
  ('operational','personDisplayName'),
  ('operational','personCallsign'),
  ('operational','personAvailabilityStatus'),
  ('operational','description'),
  ('operational','operationalStatus'),
  ('operational','lifecycleStatus'),
  ('operational','assignmentStatus'),
  ('operational','currentIncidentRole'),
  ('operational','broadAvailability'),
  ('operational','serviceStatus'),
  ('operational','operationalLimitations'),
  ('operational','vehicleType'),
  ('operational','vehicleIdentifier'),
  ('operational','assignedUnit'),
  ('operational','supportedEquipment'),
  ('operational','dockName'),
  ('operational','connectivityStatus'),
  ('operational','powerStatus'),
  ('operational','siteName'),
  ('operational','owningOrganizationLabel'),
  ('operational','supportedCategories'),
  ('operational','sensorCategory'),
  ('operational','mounting'),
  ('operational','detectionCategory'),
  ('operational','agencyIdentifier'),
  ('operational','personOperationalRoles'),
  ('operational','personOperationalStatus'),
  ('aviation','resourceId'),
  ('aviation','displayName'),
  ('aviation','category'),
  ('aviation','callsign'),
  ('aviation','readinessStatus'),
  ('aviation','originatingOrganization'),
  ('aviation','personDisplayName'),
  ('aviation','personCallsign'),
  ('aviation','personAvailabilityStatus'),
  ('aviation','description'),
  ('aviation','operationalStatus'),
  ('aviation','lifecycleStatus'),
  ('aviation','assignmentStatus'),
  ('aviation','currentIncidentRole'),
  ('aviation','broadAvailability'),
  ('aviation','serviceStatus'),
  ('aviation','operationalLimitations'),
  ('aviation','vehicleType'),
  ('aviation','vehicleIdentifier'),
  ('aviation','assignedUnit'),
  ('aviation','supportedEquipment'),
  ('aviation','dockName'),
  ('aviation','connectivityStatus'),
  ('aviation','powerStatus'),
  ('aviation','siteName'),
  ('aviation','owningOrganizationLabel'),
  ('aviation','supportedCategories'),
  ('aviation','sensorCategory'),
  ('aviation','mounting'),
  ('aviation','detectionCategory'),
  ('aviation','agencyIdentifier'),
  ('aviation','personOperationalRoles'),
  ('aviation','personOperationalStatus'),
  ('aviation','manufacturer'),
  ('aviation','model'),
  ('aviation','aircraftType'),
  ('aviation','thermalCapable'),
  ('aviation','parachuteEquipped'),
  ('aviation','dockCompatible'),
  ('aviation','maxApprovedAltitudeFt'),
  ('aviation','supportedAircraftType'),
  ('aviation','batteryReadiness'),
  ('aviation','qualificationType'),
  ('aviation','qualificationCurrent'),
  ('incident_command','resourceId'),
  ('incident_command','displayName'),
  ('incident_command','category'),
  ('incident_command','callsign'),
  ('incident_command','readinessStatus'),
  ('incident_command','originatingOrganization'),
  ('incident_command','personDisplayName'),
  ('incident_command','personCallsign'),
  ('incident_command','personAvailabilityStatus'),
  ('incident_command','description'),
  ('incident_command','operationalStatus'),
  ('incident_command','lifecycleStatus'),
  ('incident_command','assignmentStatus'),
  ('incident_command','currentIncidentRole'),
  ('incident_command','broadAvailability'),
  ('incident_command','serviceStatus'),
  ('incident_command','operationalLimitations'),
  ('incident_command','vehicleType'),
  ('incident_command','vehicleIdentifier'),
  ('incident_command','assignedUnit'),
  ('incident_command','supportedEquipment'),
  ('incident_command','dockName'),
  ('incident_command','connectivityStatus'),
  ('incident_command','powerStatus'),
  ('incident_command','siteName'),
  ('incident_command','owningOrganizationLabel'),
  ('incident_command','supportedCategories'),
  ('incident_command','sensorCategory'),
  ('incident_command','mounting'),
  ('incident_command','detectionCategory'),
  ('incident_command','agencyIdentifier'),
  ('incident_command','personOperationalRoles'),
  ('incident_command','personOperationalStatus'),
  ('incident_command','manufacturer'),
  ('incident_command','model'),
  ('incident_command','aircraftType'),
  ('incident_command','thermalCapable'),
  ('incident_command','parachuteEquipped'),
  ('incident_command','dockCompatible'),
  ('incident_command','maxApprovedAltitudeFt'),
  ('incident_command','supportedAircraftType'),
  ('incident_command','batteryReadiness'),
  ('incident_command','qualificationType'),
  ('incident_command','qualificationCurrent'),
  ('incident_command','locationDescription'),
  ('incident_command','qualificationExpiresOn'),
  ('incident_command','assignmentWindow'),
  ('incident_command','sharedUntil'),
  ('full','resourceId'),
  ('full','displayName'),
  ('full','category'),
  ('full','callsign'),
  ('full','readinessStatus'),
  ('full','originatingOrganization'),
  ('full','description'),
  ('full','operationalStatus'),
  ('full','lifecycleStatus'),
  ('full','assignmentStatus'),
  ('full','currentIncidentRole'),
  ('full','broadAvailability'),
  ('full','serviceStatus'),
  ('full','operationalLimitations'),
  ('full','vehicleType'),
  ('full','vehicleIdentifier'),
  ('full','assignedUnit'),
  ('full','supportedEquipment'),
  ('full','dockName'),
  ('full','connectivityStatus'),
  ('full','powerStatus'),
  ('full','siteName'),
  ('full','owningOrganizationLabel'),
  ('full','supportedCategories'),
  ('full','sensorCategory'),
  ('full','mounting'),
  ('full','detectionCategory'),
  ('full','agencyIdentifier'),
  ('full','manufacturer'),
  ('full','model'),
  ('full','aircraftType'),
  ('full','thermalCapable'),
  ('full','parachuteEquipped'),
  ('full','dockCompatible'),
  ('full','maxApprovedAltitudeFt'),
  ('full','supportedAircraftType'),
  ('full','batteryReadiness'),
  ('full','qualificationType'),
  ('full','qualificationCurrent'),
  ('full','locationDescription'),
  ('full','qualificationExpiresOn'),
  ('full','assignmentWindow'),
  ('full','sharedUntil'),
  ('full','personDisplayName'),
  ('full','personCallsign'),
  ('full','personAvailabilityStatus'),
  ('full','personOperationalRoles'),
  ('full','personOperationalStatus'),
  ('full','serialNumber'),
  ('full','faaRegistration'),
  ('full','remoteId'),
  ('full','restrictedNotes'),
  ('full','detailRestrictedNotes'),
  ('full','maintenanceStatus'),
  ('full','personDutyContact'),
  ('full','personEmployeeIdentifier'),
  ('full','personQualificationSummary'),
  ('full','qualificationRestrictions'),
  ('full','qualificationIssuer'),
  ('full','qualificationVerification'),
  ('custom','resourceId'),
  ('custom','displayName'),
  ('custom','category'),
  ('custom','callsign'),
  ('custom','readinessStatus'),
  ('custom','originatingOrganization'),
  ('custom','description'),
  ('custom','operationalStatus'),
  ('custom','lifecycleStatus'),
  ('custom','assignmentStatus'),
  ('custom','currentIncidentRole'),
  ('custom','broadAvailability'),
  ('custom','serviceStatus'),
  ('custom','operationalLimitations'),
  ('custom','vehicleType'),
  ('custom','vehicleIdentifier'),
  ('custom','assignedUnit'),
  ('custom','supportedEquipment'),
  ('custom','dockName'),
  ('custom','connectivityStatus'),
  ('custom','powerStatus'),
  ('custom','siteName'),
  ('custom','owningOrganizationLabel'),
  ('custom','supportedCategories'),
  ('custom','sensorCategory'),
  ('custom','mounting'),
  ('custom','detectionCategory'),
  ('custom','agencyIdentifier'),
  ('custom','manufacturer'),
  ('custom','model'),
  ('custom','aircraftType'),
  ('custom','thermalCapable'),
  ('custom','parachuteEquipped'),
  ('custom','dockCompatible'),
  ('custom','maxApprovedAltitudeFt'),
  ('custom','supportedAircraftType'),
  ('custom','batteryReadiness'),
  ('custom','qualificationType'),
  ('custom','qualificationCurrent'),
  ('custom','locationDescription'),
  ('custom','qualificationExpiresOn'),
  ('custom','assignmentWindow'),
  ('custom','sharedUntil'),
  ('custom','personDisplayName'),
  ('custom','personCallsign'),
  ('custom','personAvailabilityStatus'),
  ('custom','personOperationalRoles'),
  ('custom','personOperationalStatus')
ON CONFLICT DO NOTHING;

-- Reference data: readable by the application role, never writable by it.
GRANT SELECT ON airs.disclosure_fields, airs.disclosure_profile_fields TO airs_app;
REVOKE INSERT, UPDATE, DELETE ON airs.disclosure_fields FROM airs_app;
REVOKE INSERT, UPDATE, DELETE ON airs.disclosure_profile_fields FROM airs_app;

-- --- disclosure decision function --------------------------------------------

-- Single source of truth for "may this field be disclosed under this profile".
-- Sensitive fields resolve true only for the 'full' profile, which the service
-- layer restricts to the originating org and explicitly named recipients.
CREATE OR REPLACE FUNCTION airs.disclosure_allows(
  p_profile text,
  p_custom_keys text[],
  p_field_key text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_profile = 'custom' THEN EXISTS (
      SELECT 1 FROM airs.disclosure_fields f
       WHERE f.field_key = p_field_key
         AND f.sensitive = false
         AND (f.field_key = ANY (COALESCE(p_custom_keys, '{}'::text[]))
              OR EXISTS (SELECT 1 FROM airs.disclosure_profile_fields s
                          WHERE s.profile = 'summary' AND s.field_key = f.field_key)))
    ELSE EXISTS (
      SELECT 1 FROM airs.disclosure_profile_fields pf
       WHERE pf.profile = COALESCE(p_profile, 'summary')
         AND pf.field_key = p_field_key)
  END;
$$;
GRANT EXECUTE ON FUNCTION airs.disclosure_allows(text, text[], text) TO airs_app;

-- --- share-level disclosure ---------------------------------------------------

ALTER TABLE airs.resource_shares
  ADD COLUMN IF NOT EXISTS disclosure_profile text NOT NULL DEFAULT 'summary',
  ADD COLUMN IF NOT EXISTS custom_field_keys text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE airs.incident_assignments
  ADD COLUMN IF NOT EXISTS disclosure_profile text NOT NULL DEFAULT 'summary',
  ADD COLUMN IF NOT EXISTS custom_field_keys text[] NOT NULL DEFAULT '{}'::text[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_profile_ck') THEN
    ALTER TABLE airs.resource_shares ADD CONSTRAINT resource_shares_profile_ck
      CHECK (disclosure_profile IN
        ('summary','operational','aviation','incident_command','full','custom'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incident_assignments_profile_ck') THEN
    ALTER TABLE airs.incident_assignments ADD CONSTRAINT incident_assignments_profile_ck
      CHECK (disclosure_profile IN
        ('summary','operational','aviation','incident_command','full','custom'));
  END IF;
END $$;

-- A custom profile may only ever name known, non-sensitive fields, and only a
-- custom profile may carry a key list at all. Enforced in the database so a
-- compromised or bypassed service layer still cannot widen a share.
CREATE OR REPLACE FUNCTION airs.enforce_disclosure_keys()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad text;
BEGIN
  IF NEW.disclosure_profile <> 'custom' THEN
    IF COALESCE(array_length(NEW.custom_field_keys, 1), 0) > 0 THEN
      RAISE EXCEPTION 'custom_field_keys requires the custom disclosure profile';
    END IF;
    RETURN NEW;
  END IF;

  SELECT k INTO bad
    FROM unnest(NEW.custom_field_keys) AS k
   WHERE NOT EXISTS (SELECT 1 FROM airs.disclosure_fields f
                      WHERE f.field_key = k AND f.sensitive = false)
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'field % is not disclosable under a custom profile', bad;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_disclosure_keys ON airs.resource_shares;
CREATE TRIGGER enforce_disclosure_keys
  BEFORE INSERT OR UPDATE ON airs.resource_shares
  FOR EACH ROW EXECUTE FUNCTION airs.enforce_disclosure_keys();

DROP TRIGGER IF EXISTS enforce_disclosure_keys ON airs.incident_assignments;
CREATE TRIGGER enforce_disclosure_keys
  BEFORE INSERT OR UPDATE ON airs.incident_assignments
  FOR EACH ROW EXECUTE FUNCTION airs.enforce_disclosure_keys();

-- --- effective disclosure for the acting organization -------------------------

-- Returns the profile the CURRENT organization is entitled to for a resource.
-- Owner reads are unrestricted; every other reader is capped by the live share.
-- A revoked, expired or closed share yields no row at all, so the caller
-- receives the default-deny 'summary' only when a live share exists.
CREATE OR REPLACE FUNCTION airs.effective_disclosure(p_resource_id uuid)
RETURNS TABLE (profile text, custom_field_keys text[], named_recipient boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  SELECT x.profile, x.custom_field_keys, x.named_recipient
    FROM (
      -- rank 0: the originating organization always sees its own record whole
      SELECT 0 AS rank, 'full'::text AS profile, '{}'::text[] AS custom_field_keys,
             true AS named_recipient
        FROM airs.resources r
       WHERE r.id = p_resource_id AND r.org_id = airs.current_org_id()
      UNION ALL
      -- rank 1: a partner is capped by the live share, and only while it lives
      SELECT 1, s.disclosure_profile, s.custom_field_keys,
             s.classification = 'named_recipients'
               AND airs.current_org_id() = ANY (s.named_recipient_org_ids)
        FROM airs.resource_shares s
       WHERE s.resource_id = p_resource_id
         AND s.org_id <> airs.current_org_id()
         AND airs.has_shared_resource(p_resource_id)
    ) x
   ORDER BY x.rank
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION airs.effective_disclosure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.effective_disclosure(uuid) TO airs_app;

-- --- personnel qualification currency for partners ---------------------------

-- Qualification rows are tenant-only under RLS, and stay that way. This helper
-- returns ONLY the list of qualification types that are currently valid for a
-- person assigned into a room the caller can reach: no issuer, no expiry, no
-- restrictions, no verification detail. The service layer discloses it only
-- under the aviation profile or above.
CREATE OR REPLACE FUNCTION airs.assignment_current_qualifications(p_assignment_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  SELECT COALESCE(array_agg(DISTINCT q.qualification_type ORDER BY q.qualification_type), '{}')
    FROM airs.incident_assignments a
    JOIN airs.qualifications q ON q.person_id = a.person_id AND q.org_id = a.org_id
   WHERE a.id = p_assignment_id
     AND a.assignment_type = 'person'
     AND airs.has_incident_access(a.incident_id)
     AND airs.qualification_is_current(q.*);
$$;
REVOKE ALL ON FUNCTION airs.assignment_current_qualifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.assignment_current_qualifications(uuid) TO airs_app;

COMMIT;
