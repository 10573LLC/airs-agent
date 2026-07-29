-- Role and permission reference data (deterministic, safe to re-run)
BEGIN;

INSERT INTO airs.roles (key, name, description) VALUES
  ('agency_admin',        'Agency Administrator',        'Manages users, roles and agency settings within one tenant.'),
  ('airspace_supervisor', 'Airspace Supervisor',         'Approves and deconflicts airspace operations.'),
  ('rpic',                'Remote Pilot in Command',     'Operates UAS and files operation requests.'),
  ('visual_observer',     'Visual Observer',             'Supports a flight crew; read plus observation notes.'),
  ('dispatcher',          'Dispatcher / RTCC Operator',  'Opens incidents and coordinates resources.'),
  ('incident_commander',  'Incident Commander',          'Owns an incident, its sharing and its closure.'),
  ('intel_analyst',       'Intelligence Analyst',        'Reads incident and airspace data for analysis.'),
  ('partner_agency_user', 'Partner-Agency User',         'External agency access limited to shared incidents.'),
  ('system_auditor',      'System Auditor',              'Read-only access to audit records.')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO airs.permissions (key, description) VALUES
  ('org.manage',            'Modify organization settings'),
  ('user.manage',           'Create, disable and assign roles to users'),
  ('incident.create',       'Open an incident room'),
  ('incident.read',         'Read incidents visible to the tenant'),
  ('incident.update',       'Modify incident details'),
  ('incident.close',        'Close an incident and revoke its shares'),
  ('incident.share',        'Grant partner-agency access to an incident'),
  ('incident.revoke_share', 'Revoke partner-agency access'),
  ('airspace.read',         'Read airspace operations'),
  ('airspace.propose',      'Propose an airspace operation'),
  ('airspace.approve',      'Approve or deny an airspace operation'),
  ('aircraft.manage',       'Manage aircraft inventory'),
  ('audit.read',            'Read the audit log'),
  ('retention.manage',      'Change retention policy')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  ('agency_admin','org.manage'),('agency_admin','user.manage'),('agency_admin','incident.read'),
  ('agency_admin','airspace.read'),('agency_admin','aircraft.manage'),('agency_admin','retention.manage'),
  ('agency_admin','audit.read'),

  ('airspace_supervisor','incident.read'),('airspace_supervisor','airspace.read'),
  ('airspace_supervisor','airspace.approve'),('airspace_supervisor','airspace.propose'),
  ('airspace_supervisor','aircraft.manage'),

  ('rpic','incident.read'),('rpic','airspace.read'),('rpic','airspace.propose'),

  ('visual_observer','incident.read'),('visual_observer','airspace.read'),

  ('dispatcher','incident.create'),('dispatcher','incident.read'),('dispatcher','incident.update'),
  ('dispatcher','airspace.read'),

  ('incident_commander','incident.create'),('incident_commander','incident.read'),
  ('incident_commander','incident.update'),('incident_commander','incident.close'),
  ('incident_commander','incident.share'),('incident_commander','incident.revoke_share'),
  ('incident_commander','airspace.read'),('incident_commander','airspace.approve'),

  ('intel_analyst','incident.read'),('intel_analyst','airspace.read'),

  ('partner_agency_user','incident.read'),('partner_agency_user','airspace.read'),

  ('system_auditor','audit.read')
ON CONFLICT DO NOTHING;

COMMIT;