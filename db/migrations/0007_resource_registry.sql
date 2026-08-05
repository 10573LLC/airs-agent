-- AIRS Agent — Stage 6: Operational Resource Registry and Readiness Board.
--
-- Adds the agency-owned resource + personnel-readiness plane. Portable
-- PostgreSQL; no vendor extensions beyond pgcrypto (already required).
--
-- Ownership invariant: every row here carries org_id = the ORIGINATING
-- organization. org_id is immutable (trigger) and is the only organization
-- that may write the row. A partner organization sees a resource only through
-- an unexpired, unrevoked airs.resource_shares row bound to an incident room
-- it currently participates in — and never gains write, share or assign rights.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permissions (SQL side of the RBAC parity contract)
-- ---------------------------------------------------------------------------
INSERT INTO airs.permissions (key, description) VALUES
  ('resource.create',             'Create an organization-owned operational resource'),
  ('resource.read',               'Read resources owned by or shared with the active organization'),
  ('resource.update',             'Update permitted metadata of an owned resource'),
  ('resource.retire',             'Retire an owned resource'),
  ('resource.restore',            'Restore a retired resource to service'),
  ('resource.set_status',         'Change the readiness status of an owned resource'),
  ('resource.share',              'Share an owned resource into an incident room'),
  ('resource.revoke_share',       'Revoke an incident share of an owned resource'),
  ('resource.assign_incident',    'Assign an owned resource or person to an incident room'),
  ('resource.release_incident',   'Release, complete or cancel an incident assignment'),
  ('personnel.readiness_manage',  'Maintain operational personnel profiles and availability'),
  ('personnel.schedule_manage',   'Create and maintain operational shifts'),
  ('qualification.manage',        'Add and maintain personnel qualification records'),
  ('qualification.verify',        'Verify a personnel qualification record'),
  ('qualification.revoke',        'Revoke a personnel qualification record')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  -- Agency Administrator: owns the registry itself, but never assigns to incidents.
  ('agency_admin','resource.create'),('agency_admin','resource.read'),
  ('agency_admin','resource.update'),('agency_admin','resource.retire'),
  ('agency_admin','resource.restore'),('agency_admin','resource.set_status'),
  ('agency_admin','resource.share'),('agency_admin','resource.revoke_share'),
  ('agency_admin','personnel.readiness_manage'),('agency_admin','personnel.schedule_manage'),
  ('agency_admin','qualification.manage'),('agency_admin','qualification.verify'),
  ('agency_admin','qualification.revoke'),
  -- Airspace Supervisor: operational custody of aircraft, crews and readiness.
  ('airspace_supervisor','resource.read'),('airspace_supervisor','resource.update'),
  ('airspace_supervisor','resource.set_status'),('airspace_supervisor','resource.share'),
  ('airspace_supervisor','resource.revoke_share'),('airspace_supervisor','resource.assign_incident'),
  ('airspace_supervisor','resource.release_incident'),
  ('airspace_supervisor','personnel.readiness_manage'),
  ('airspace_supervisor','personnel.schedule_manage'),
  ('airspace_supervisor','qualification.verify'),
  -- RPIC: reads the registry and reports its own aircraft readiness.
  ('rpic','resource.read'),('rpic','resource.set_status'),
  -- Visual Observer: read only.
  ('visual_observer','resource.read'),
  -- Dispatcher / RTCC: staffing and readiness board operations.
  ('dispatcher','resource.read'),('dispatcher','resource.set_status'),
  ('dispatcher','resource.assign_incident'),('dispatcher','resource.release_incident'),
  ('dispatcher','personnel.readiness_manage'),('dispatcher','personnel.schedule_manage'),
  -- Incident Commander: incident-side assignment and sharing, no registry edits.
  ('incident_commander','resource.read'),('incident_commander','resource.set_status'),
  ('incident_commander','resource.share'),('incident_commander','resource.revoke_share'),
  ('incident_commander','resource.assign_incident'),('incident_commander','resource.release_incident'),
  -- Analyst and partner: read only. System Auditor is intentionally denied.
  ('intel_analyst','resource.read'),
  ('partner_agency_user','resource.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Category -> readiness-status validation model (explicit, table driven)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.resource_category_statuses (
  category text NOT NULL,
  status   text NOT NULL,
  PRIMARY KEY (category, status)
);
GRANT SELECT ON airs.resource_category_statuses TO airs_app;

INSERT INTO airs.resource_category_statuses (category, status) VALUES
  -- aircraft
  ('aircraft','available'),('aircraft','assigned'),('aircraft','deploying'),('aircraft','deployed'),
  ('aircraft','airborne'),('aircraft','returning'),('aircraft','charging'),('aircraft','degraded'),
  ('aircraft','maintenance'),('aircraft','unavailable'),('aircraft','out_of_service'),('aircraft','retired'),
  -- ground vehicle
  ('ground_vehicle','available'),('ground_vehicle','assigned'),('ground_vehicle','deploying'),
  ('ground_vehicle','deployed'),('ground_vehicle','degraded'),('ground_vehicle','maintenance'),
  ('ground_vehicle','unavailable'),('ground_vehicle','out_of_service'),('ground_vehicle','retired'),
  -- dock
  ('dock','available'),('dock','degraded'),('dock','offline'),('dock','maintenance'),
  ('dock','out_of_service'),('dock','retired'),
  -- launch site
  ('launch_site','available'),('launch_site','restricted'),('launch_site','inactive'),
  ('launch_site','unavailable'),('launch_site','retired'),
  -- portable trailer
  ('portable_trailer','available'),('portable_trailer','assigned'),('portable_trailer','deploying'),
  ('portable_trailer','deployed'),('portable_trailer','degraded'),('portable_trailer','maintenance'),
  ('portable_trailer','unavailable'),('portable_trailer','out_of_service'),('portable_trailer','retired');

-- sensor / detection categories share one status set
INSERT INTO airs.resource_category_statuses (category, status)
SELECT c, s
  FROM unnest(ARRAY['remote_id_receiver','radar','rf_detector','adsb_receiver',
                    'weather_station','camera','counter_uas','other']) c
 CROSS JOIN unnest(ARRAY['available','assigned','deployed','degraded','offline','maintenance',
                         'unavailable','out_of_service','retired']) s;

CREATE OR REPLACE FUNCTION airs.resource_status_allowed(p_category text, p_status text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = airs, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM airs.resource_category_statuses
                  WHERE category = p_category AND status = p_status)
$$;
GRANT EXECUTE ON FUNCTION airs.resource_status_allowed(text, text) TO airs_app;

-- ---------------------------------------------------------------------------
-- 3. Common resource model
-- ---------------------------------------------------------------------------
CREATE TABLE airs.resources (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  category               text NOT NULL CHECK (category IN (
                           'aircraft','ground_vehicle','dock','launch_site','remote_id_receiver',
                           'radar','rf_detector','adsb_receiver','weather_station','camera',
                           'counter_uas','portable_trailer','other')),
  display_name           text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  callsign               text CHECK (callsign IS NULL OR length(btrim(callsign)) BETWEEN 1 AND 60),
  description            text NOT NULL DEFAULT '',
  readiness_status       text NOT NULL DEFAULT 'unavailable',
  operational_status     text NOT NULL DEFAULT 'unknown'
                         CHECK (operational_status IN ('operational','limited','non_operational','unknown')),
  sharing_classification text NOT NULL DEFAULT 'originating_org_only'
                         CHECK (sharing_classification IN (
                           'participating_orgs','public_safety_only','law_enforcement_sensitive',
                           'aviation_personnel_only','incident_command_only','originating_org_only',
                           'named_recipients')),
  lifecycle_status       text NOT NULL DEFAULT 'active'
                         CHECK (lifecycle_status IN ('active','retired')),
  restricted_notes       text,
  created_by_account     uuid REFERENCES airs.accounts(id),
  updated_by_account     uuid REFERENCES airs.accounts(id),
  retired_by_account     uuid REFERENCES airs.accounts(id),
  restored_by_account    uuid REFERENCES airs.accounts(id),
  retired_at             timestamptz,
  restored_at            timestamptz,
  version                int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, category, callsign)
);
CREATE INDEX resources_org_idx ON airs.resources (org_id, category, readiness_status);

-- --- category detail tables (no unrestricted JSON blob) --------------------
CREATE TABLE airs.resource_aircraft (
  resource_id        uuid PRIMARY KEY REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  manufacturer       text,
  model              text,
  serial_number      text,                 -- restricted by default (see readResource)
  faa_registration   text,
  remote_id          text,
  aircraft_type      text NOT NULL DEFAULT 'multirotor'
                     CHECK (aircraft_type IN ('multirotor','fixed_wing','vtol','helicopter','other')),
  thermal_capable    boolean NOT NULL DEFAULT false,
  parachute_equipped boolean NOT NULL DEFAULT false,
  dock_compatible    boolean NOT NULL DEFAULT false,
  max_approved_altitude_ft int CHECK (max_approved_altitude_ft IS NULL
                                      OR max_approved_altitude_ft BETWEEN 0 AND 18000),
  maintenance_status text NOT NULL DEFAULT 'current'
                     CHECK (maintenance_status IN ('current','due','overdue','in_maintenance','grounded')),
  battery_readiness  text NOT NULL DEFAULT 'unknown'
                     CHECK (battery_readiness IN ('full','partial','low','charging','unknown')),
  home_resource_id   uuid REFERENCES airs.resources(id) ON DELETE SET NULL,
  service_status     text NOT NULL DEFAULT 'active'
                     CHECK (service_status IN ('active','maintenance','grounded','out_of_service','retired')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airs.resource_vehicles (
  resource_id        uuid PRIMARY KEY REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  vehicle_identifier text,
  vehicle_type       text NOT NULL DEFAULT 'other'
                     CHECK (vehicle_type IN ('patrol','command_post','support','trailer_tow',
                                             'utility','mobile_command','other')),
  assigned_unit      text,
  supported_equipment text[] NOT NULL DEFAULT '{}',
  service_status     text NOT NULL DEFAULT 'available'
                     CHECK (service_status IN ('available','assigned','deployed','maintenance',
                                               'unavailable','out_of_service','retired')),
  restricted_notes   text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airs.resource_docks (
  resource_id          uuid PRIMARY KEY REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  dock_name            text,
  manufacturer         text,
  model                text,
  supported_aircraft_type text,
  launch_site_id       uuid REFERENCES airs.resources(id) ON DELETE SET NULL,
  connectivity_status  text NOT NULL DEFAULT 'unknown'
                       CHECK (connectivity_status IN ('online','intermittent','offline','unknown')),
  power_status         text NOT NULL DEFAULT 'unknown'
                       CHECK (power_status IN ('normal','backup','fault','unknown')),
  service_status       text NOT NULL DEFAULT 'available'
                       CHECK (service_status IN ('available','degraded','offline','maintenance',
                                                 'out_of_service','retired')),
  restricted_notes     text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airs.resource_launch_sites (
  resource_id            uuid PRIMARY KEY REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  site_name              text,
  location_description   text,   -- textual only; no coordinates in this stage
  owning_organization    text,
  operational_limitations text,
  supported_categories   text[] NOT NULL DEFAULT '{}',
  service_status         text NOT NULL DEFAULT 'active'
                         CHECK (service_status IN ('active','restricted','inactive','retired')),
  restricted_notes       text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE airs.resource_sensors (
  resource_id         uuid PRIMARY KEY REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  sensor_category     text NOT NULL DEFAULT 'other'
                      CHECK (sensor_category IN ('remote_id_receiver','radar','rf_detector',
                              'adsb_receiver','weather_station','camera','counter_uas','other')),
  manufacturer        text,
  model               text,
  agency_identifier   text,
  mounting            text NOT NULL DEFAULT 'fixed' CHECK (mounting IN ('fixed','portable')),
  detection_category  text,
  host_resource_id    uuid REFERENCES airs.resources(id) ON DELETE SET NULL,
  connectivity_status text NOT NULL DEFAULT 'unknown'
                      CHECK (connectivity_status IN ('online','intermittent','offline','unknown')),
  maintenance_status  text NOT NULL DEFAULT 'current'
                      CHECK (maintenance_status IN ('current','due','overdue','in_maintenance')),
  service_status      text NOT NULL DEFAULT 'available'
                      CHECK (service_status IN ('available','degraded','offline','maintenance',
                                                'unavailable','out_of_service','retired')),
  restricted_notes    text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. Personnel operational profiles (NOT an HR record)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.personnel_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  user_id               uuid REFERENCES airs.users(id) ON DELETE SET NULL,
  account_id            uuid REFERENCES airs.accounts(id) ON DELETE SET NULL,
  display_name          text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  callsign              text,
  employee_identifier   text,
  operational_roles     text[] NOT NULL DEFAULT '{}',
  availability_status   text NOT NULL DEFAULT 'off_duty'
                        CHECK (availability_status IN ('scheduled','available','assigned','deploying',
                                                       'deployed','unavailable','off_duty')),
  qualification_summary text,
  operational_status    text NOT NULL DEFAULT 'active'
                        CHECK (operational_status IN ('active','unavailable','suspended','inactive')),
  duty_contact          text,   -- operational contact only; restricted on read
  created_by_account    uuid REFERENCES airs.accounts(id),
  updated_by_account    uuid REFERENCES airs.accounts(id),
  version               int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX personnel_org_idx ON airs.personnel_profiles (org_id, availability_status);

CREATE TABLE airs.qualifications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  person_id              uuid NOT NULL REFERENCES airs.personnel_profiles(id) ON DELETE CASCADE,
  qualification_type     text NOT NULL CHECK (qualification_type IN (
                           'rpic','visual_observer','airspace_supervisor','dfr_operator',
                           'sensor_operator','incident_commander','intel_analyst',
                           'counter_uas_operator','instructor','other')),
  issuing_organization   text,
  effective_date         date NOT NULL DEFAULT current_date,
  expires_on             date,
  verification_status    text NOT NULL DEFAULT 'unverified'
                         CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verified_by_account    uuid REFERENCES airs.accounts(id),
  verified_at            timestamptz,
  restrictions           text,
  sharing_classification text NOT NULL DEFAULT 'originating_org_only'
                         CHECK (sharing_classification IN (
                           'participating_orgs','public_safety_only','law_enforcement_sensitive',
                           'aviation_personnel_only','incident_command_only','originating_org_only',
                           'named_recipients')),
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','expired','revoked')),
  revoked_by_account     uuid REFERENCES airs.accounts(id),
  revoked_at             timestamptz,
  created_by_account     uuid REFERENCES airs.accounts(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR expires_on >= effective_date)
);
CREATE INDEX qualifications_person_idx ON airs.qualifications (org_id, person_id, status);

-- Single definition of "currently valid". An expired or revoked qualification
-- can never satisfy it, regardless of the stored status column.
CREATE OR REPLACE FUNCTION airs.qualification_is_current(q airs.qualifications)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT q.status = 'active'
     AND q.verification_status = 'verified'
     AND q.revoked_at IS NULL
     AND q.effective_date <= current_date
     AND (q.expires_on IS NULL OR q.expires_on >= current_date)
$$;

CREATE TABLE airs.shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES airs.personnel_profiles(id) ON DELETE CASCADE,
  operational_role    text NOT NULL CHECK (operational_role IN (
                        'rpic','visual_observer','airspace_supervisor','dfr_operator',
                        'sensor_operator','incident_commander','intel_analyst',
                        'counter_uas_operator','dispatcher','other')),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  availability_status text NOT NULL DEFAULT 'scheduled'
                      CHECK (availability_status IN ('scheduled','available','assigned','deploying',
                                                     'deployed','unavailable','off_duty','cancelled')),
  incident_id         uuid REFERENCES airs.incident_rooms(id) ON DELETE SET NULL,
  notes               text,
  created_by_account  uuid REFERENCES airs.accounts(id),
  updated_by_account  uuid REFERENCES airs.accounts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX shifts_org_window_idx ON airs.shifts (org_id, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- 5. Incident-scoped resource sharing
-- ---------------------------------------------------------------------------
CREATE TABLE airs.resource_shares (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id         uuid NOT NULL REFERENCES airs.resources(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE, -- originating
  incident_id         uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  classification      text NOT NULL DEFAULT 'participating_orgs'
                      CHECK (classification IN (
                        'participating_orgs','public_safety_only','law_enforcement_sensitive',
                        'aviation_personnel_only','incident_command_only','originating_org_only',
                        'named_recipients')),
  named_recipient_org_ids uuid[] NOT NULL DEFAULT '{}',
  shared_by_account   uuid REFERENCES airs.accounts(id),
  shared_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by_account  uuid REFERENCES airs.accounts(id),
  revocation_reason   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_id, incident_id)
);
CREATE INDEX resource_shares_incident_idx ON airs.resource_shares (incident_id, revoked_at);

-- The single definition of partner visibility for a resource. SECURITY DEFINER
-- so the policy on airs.resources may consult shares + rooms without recursion.
CREATE OR REPLACE FUNCTION airs.has_shared_resource(res uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM airs.resource_shares s
      JOIN airs.incident_rooms r ON r.id = s.incident_id
     WHERE s.resource_id = res
       AND s.org_id <> airs.current_org_id()
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND s.classification <> 'originating_org_only'
       AND (s.classification <> 'named_recipients'
            OR airs.current_org_id() = ANY (s.named_recipient_org_ids))
       AND r.status NOT IN ('closed','archived')
       AND airs.has_incident_access(s.incident_id)
  )
$$;
REVOKE ALL ON FUNCTION airs.has_shared_resource(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.has_shared_resource(uuid) TO airs_app;

-- ---------------------------------------------------------------------------
-- 6. Incident assignments (resources and people)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.incident_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id              uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id                   uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  assignment_type          text NOT NULL CHECK (assignment_type IN ('resource','person')),
  resource_id              uuid REFERENCES airs.resources(id) ON DELETE CASCADE,
  person_id                uuid REFERENCES airs.personnel_profiles(id) ON DELETE CASCADE,
  assigned_role            text,
  status                   text NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed','assigned','deploying','active',
                                             'released','cancelled','completed')),
  starts_at                timestamptz NOT NULL DEFAULT now(),
  ends_at                  timestamptz,
  visibility_classification text NOT NULL DEFAULT 'participating_orgs'
                           CHECK (visibility_classification IN (
                             'participating_orgs','public_safety_only','law_enforcement_sensitive',
                             'aviation_personnel_only','incident_command_only',
                             'originating_org_only','named_recipients')),
  assigned_by_account      uuid REFERENCES airs.accounts(id),
  released_by_account      uuid REFERENCES airs.accounts(id),
  release_reason           text,
  released_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((assignment_type = 'resource' AND resource_id IS NOT NULL AND person_id IS NULL)
      OR (assignment_type = 'person'   AND person_id  IS NOT NULL AND resource_id IS NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX incident_assignments_incident_idx
  ON airs.incident_assignments (incident_id, status);
CREATE UNIQUE INDEX incident_assignments_active_resource_idx
  ON airs.incident_assignments (incident_id, resource_id)
  WHERE resource_id IS NOT NULL AND status IN ('proposed','assigned','deploying','active');
CREATE UNIQUE INDEX incident_assignments_active_person_idx
  ON airs.incident_assignments (incident_id, person_id)
  WHERE person_id IS NOT NULL AND status IN ('proposed','assigned','deploying','active');

-- ---------------------------------------------------------------------------
-- 7. Guards: ownership immutability, status validity, terminal states
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.resource_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'resource ownership and identity are immutable';
    END IF;
    IF NEW.category <> OLD.category THEN
      RAISE EXCEPTION 'resource category is immutable';
    END IF;
    -- A retired resource may only be changed by an explicit restoration.
    IF OLD.lifecycle_status = 'retired' AND NEW.lifecycle_status = 'retired'
       AND NEW.readiness_status <> 'retired' THEN
      RAISE EXCEPTION 'a retired resource cannot re-enter operational service';
    END IF;
  END IF;
  IF NOT airs.resource_status_allowed(NEW.category, NEW.readiness_status) THEN
    RAISE EXCEPTION 'readiness status % is not valid for category %',
      NEW.readiness_status, NEW.category;
  END IF;
  IF NEW.lifecycle_status = 'retired' AND NEW.readiness_status <> 'retired' THEN
    RAISE EXCEPTION 'a retired resource must hold the retired readiness status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_guard BEFORE INSERT OR UPDATE ON airs.resources
  FOR EACH ROW EXECUTE FUNCTION airs.resource_guard();

CREATE OR REPLACE FUNCTION airs.resource_detail_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
DECLARE owner_org uuid;
BEGIN
  SELECT org_id INTO owner_org FROM airs.resources WHERE id = NEW.resource_id;
  IF owner_org IS NULL OR owner_org <> NEW.org_id THEN
    RAISE EXCEPTION 'resource detail must carry the owning organization';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.resource_id <> OLD.resource_id OR NEW.org_id <> OLD.org_id) THEN
    RAISE EXCEPTION 'resource detail ownership is immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION airs.share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
DECLARE owner_org uuid;
BEGIN
  SELECT org_id INTO owner_org FROM airs.resources WHERE id = NEW.resource_id;
  IF owner_org IS NULL OR owner_org <> NEW.org_id THEN
    RAISE EXCEPTION 'only the originating organization may share a resource';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.resource_id <> OLD.resource_id OR NEW.org_id <> OLD.org_id
       OR NEW.incident_id <> OLD.incident_id THEN
      RAISE EXCEPTION 'share identity is immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'a revoked share cannot be restored';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.classification <> OLD.classification THEN
      RAISE EXCEPTION 'a revoked share cannot be reclassified';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER share_guard BEFORE INSERT OR UPDATE ON airs.resource_shares
  FOR EACH ROW EXECUTE FUNCTION airs.share_guard();

CREATE OR REPLACE FUNCTION airs.assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
DECLARE owner_org uuid; room_status text;
BEGIN
  IF NEW.resource_id IS NOT NULL THEN
    SELECT org_id INTO owner_org FROM airs.resources WHERE id = NEW.resource_id;
  ELSE
    SELECT org_id INTO owner_org FROM airs.personnel_profiles WHERE id = NEW.person_id;
  END IF;
  IF owner_org IS NULL OR owner_org <> NEW.org_id THEN
    RAISE EXCEPTION 'an organization may only assign resources or personnel it owns';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO room_status FROM airs.incident_rooms WHERE id = NEW.incident_id;
    IF room_status IS NULL OR room_status IN ('closed','archived') THEN
      RAISE EXCEPTION 'a closed incident room cannot accept new assignments';
    END IF;
  ELSE
    IF NEW.incident_id <> OLD.incident_id OR NEW.org_id <> OLD.org_id
       OR NEW.assignment_type <> OLD.assignment_type
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
      RAISE EXCEPTION 'assignment identity is immutable';
    END IF;
    IF OLD.status IN ('released','cancelled','completed')
       AND NEW.status NOT IN ('released','cancelled','completed') THEN
      RAISE EXCEPTION 'a terminated assignment cannot be reactivated';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_guard BEFORE INSERT OR UPDATE ON airs.incident_assignments
  FOR EACH ROW EXECUTE FUNCTION airs.assignment_guard();

-- Shifts: no cross-organization scheduling, no scheduling of suspended or
-- revoked members, no overlapping active shifts for the same person.
CREATE OR REPLACE FUNCTION airs.shift_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
DECLARE person_org uuid; person_status text; member_status text; person_user uuid;
BEGIN
  SELECT org_id, operational_status, user_id
    INTO person_org, person_status, person_user
    FROM airs.personnel_profiles WHERE id = NEW.person_id;
  IF person_org IS NULL OR person_org <> NEW.org_id THEN
    RAISE EXCEPTION 'cross-organization scheduling is not permitted';
  END IF;
  IF person_status IN ('suspended','inactive') THEN
    RAISE EXCEPTION 'a suspended or inactive person cannot be scheduled';
  END IF;
  IF person_user IS NOT NULL THEN
    SELECT status INTO member_status FROM airs.memberships
      WHERE org_id = NEW.org_id AND user_id = person_user
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1;
    IF member_status IS NOT NULL AND member_status <> 'active' THEN
      RAISE EXCEPTION 'only an active member may be scheduled';
    END IF;
  END IF;
  IF NEW.availability_status <> 'cancelled' AND EXISTS (
    SELECT 1 FROM airs.shifts s
     WHERE s.person_id = NEW.person_id
       AND s.id <> NEW.id
       AND s.availability_status <> 'cancelled'
       AND s.starts_at < NEW.ends_at AND s.ends_at > NEW.starts_at
  ) THEN
    RAISE EXCEPTION 'overlapping shifts are not permitted for the same person';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER shift_guard BEFORE INSERT OR UPDATE ON airs.shifts
  FOR EACH ROW EXECUTE FUNCTION airs.shift_guard();

-- ---------------------------------------------------------------------------
-- 8. Grants + forced RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources','resource_aircraft','resource_vehicles','resource_docks',
                           'resource_launch_sites','resource_sensors','personnel_profiles',
                           'qualifications','shifts','resource_shares','incident_assignments'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

-- detail-table guards need the trigger attached after table creation
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource_aircraft','resource_vehicles','resource_docks',
                           'resource_launch_sites','resource_sensors'] LOOP
    EXECUTE format('CREATE TRIGGER resource_detail_guard BEFORE INSERT OR UPDATE ON airs.%I
                    FOR EACH ROW EXECUTE FUNCTION airs.resource_detail_guard()', t);
  END LOOP;
END $$;

-- resources: own tenant always; partners only through a live incident share.
CREATE POLICY resource_read ON airs.resources FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_shared_resource(id));
CREATE POLICY resource_insert ON airs.resources FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY resource_update ON airs.resources FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY resource_delete ON airs.resources FOR DELETE
  USING (org_id = airs.current_org_id() AND lifecycle_status = 'retired');

-- category detail tables inherit the parent's visibility, never more.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource_aircraft','resource_vehicles','resource_docks',
                           'resource_launch_sites','resource_sensors'] LOOP
    EXECUTE format($f$
      CREATE POLICY detail_read ON airs.%1$I FOR SELECT
        USING (org_id = airs.current_org_id() OR airs.has_shared_resource(resource_id));
      CREATE POLICY detail_insert ON airs.%1$I FOR INSERT
        WITH CHECK (org_id = airs.current_org_id());
      CREATE POLICY detail_update ON airs.%1$I FOR UPDATE
        USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
      CREATE POLICY detail_delete ON airs.%1$I FOR DELETE
        USING (org_id = airs.current_org_id());
    $f$, t);
  END LOOP;
END $$;

-- personnel, qualifications and shifts stay strictly inside the tenant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['personnel_profiles','qualifications','shifts'] LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_read ON airs.%1$I FOR SELECT USING (org_id = airs.current_org_id());
      CREATE POLICY tenant_insert ON airs.%1$I FOR INSERT WITH CHECK (org_id = airs.current_org_id());
      CREATE POLICY tenant_update ON airs.%1$I FOR UPDATE
        USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
      CREATE POLICY tenant_delete ON airs.%1$I FOR DELETE USING (org_id = airs.current_org_id());
    $f$, t);
  END LOOP;
END $$;

-- shares: the originating organization writes; a live participant may read.
CREATE POLICY share_read ON airs.resource_shares FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_shared_resource(resource_id));
CREATE POLICY share_insert ON airs.resource_shares FOR INSERT
  WITH CHECK (org_id = airs.current_org_id()
              AND EXISTS (SELECT 1 FROM airs.resources r
                           WHERE r.id = resource_id AND r.org_id = airs.current_org_id()));
CREATE POLICY share_update ON airs.resource_shares FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- assignments: the assigning organization writes; live participants may read.
CREATE POLICY assignment_read ON airs.incident_assignments FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY assignment_insert ON airs.incident_assignments FOR INSERT
  WITH CHECK (org_id = airs.current_org_id()
              AND (resource_id IS NULL
                   OR EXISTS (SELECT 1 FROM airs.resources r
                               WHERE r.id = resource_id AND r.org_id = airs.current_org_id()))
              AND (person_id IS NULL
                   OR EXISTS (SELECT 1 FROM airs.personnel_profiles p
                               WHERE p.id = person_id AND p.org_id = airs.current_org_id())));
CREATE POLICY assignment_update ON airs.incident_assignments FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- ---------------------------------------------------------------------------
-- 9. Closure rule: closing a room terminates every temporary grant it carries.
--
-- SECURITY DEFINER because the closing organization must be able to end
-- PARTNER-owned assignments in its own room. The function refuses to act
-- unless the caller's active organization owns the room, and it can only ever
-- REMOVE access: it releases assignments and revokes shares, never the reverse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.terminate_incident_resource_access(inc uuid)
RETURNS TABLE (assignments_released int, shares_revoked int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
DECLARE owner_org uuid; a int; s int;
BEGIN
  SELECT org_id INTO owner_org FROM airs.incident_rooms WHERE id = inc;
  IF owner_org IS NULL OR owner_org <> airs.current_org_id() THEN
    RAISE EXCEPTION 'only the originating organization may terminate incident resource access';
  END IF;

  UPDATE airs.incident_assignments
     SET status = 'released', released_at = now(),
         release_reason = COALESCE(release_reason, 'incident_closed'), updated_at = now()
   WHERE incident_id = inc AND status IN ('proposed','assigned','deploying','active');
  GET DIAGNOSTICS a = ROW_COUNT;

  UPDATE airs.resource_shares
     SET revoked_at = now(),
         revocation_reason = COALESCE(revocation_reason, 'incident_closed'), updated_at = now()
   WHERE incident_id = inc AND revoked_at IS NULL;
  GET DIAGNOSTICS s = ROW_COUNT;

  assignments_released := a; shares_revoked := s; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION airs.terminate_incident_resource_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.terminate_incident_resource_access(uuid) TO airs_app;

COMMIT;
