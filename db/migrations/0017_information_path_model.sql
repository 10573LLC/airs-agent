BEGIN;

-- AIRS connects to systems; it represents organizations and coordinates resources.
-- The coordination roster records how operational information reaches AIRS for
-- an organization. It is not an agency-connectivity or authorization model.
ALTER TABLE airs.incident_coordination_partners
  DROP CONSTRAINT IF EXISTS incident_coordination_partners_connection_mode_check;

UPDATE airs.incident_coordination_partners
SET connection_mode = CASE connection_mode
  WHEN 'airs' THEN 'system_integration'
  WHEN 'external_liaison' THEN 'command_post_liaison'
  WHEN 'emergency_communications' THEN 'dispatch'
  ELSE connection_mode
END;

ALTER TABLE airs.incident_coordination_partners
  RENAME COLUMN connection_mode TO information_path;

ALTER TABLE airs.incident_coordination_partners
  ALTER COLUMN information_path SET DEFAULT 'command_post_liaison';
ALTER TABLE airs.incident_coordination_partners
  ADD CONSTRAINT incident_coordination_partners_information_path_check
  CHECK (information_path IN (
    'system_integration',
    'command_post_liaison',
    'dispatch',
    'radio',
    'phone',
    'email',
    'manual_entry',
    'mutual_aid_coordination',
    'other'
  ));

COMMENT ON COLUMN airs.incident_coordination_partners.information_path IS
  'How AIRS receives or coordinates operational information about the represented organization. This field does not indicate agency connectivity, AIRS membership, or incident authorization.';

COMMIT;
