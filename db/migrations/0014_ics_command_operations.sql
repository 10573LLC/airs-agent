BEGIN;

-- ICS command structure for live incident rooms. This is manual operational
-- data entered by authorized agency users; no field implies a live integration.
-- Ownership follows incident_rooms.org_id. Participating agencies may read
-- through the existing incident-room access helper but cannot alter origin data.

CREATE TABLE airs.incident_ics_profiles (
  incident_id              uuid PRIMARY KEY REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id                   uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  command_mode             text NOT NULL DEFAULT 'single' CHECK (command_mode IN ('single','unified')),
  incident_commander       text NOT NULL DEFAULT '',
  command_post_name        text NOT NULL DEFAULT '',
  command_post_description text NOT NULL DEFAULT '',
  operational_period_start timestamptz,
  operational_period_end   timestamptz,
  situation_summary        text NOT NULL DEFAULT '',
  safety_message           text NOT NULL DEFAULT '',
  created_by_account       uuid REFERENCES airs.accounts(id),
  updated_by_account       uuid REFERENCES airs.accounts(id),
  version                  int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (operational_period_end IS NULL OR operational_period_start IS NULL OR operational_period_end > operational_period_start)
);
CREATE TABLE airs.incident_ics_objectives (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  sequence_no      int NOT NULL DEFAULT 1 CHECK (sequence_no BETWEEN 1 AND 999),
  objective        text NOT NULL CHECK (length(btrim(objective)) BETWEEN 1 AND 1000),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  operational_period_label text,
  created_by_account uuid REFERENCES airs.accounts(id),
  updated_by_account uuid REFERENCES airs.accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_ics_objectives_incident_idx
  ON airs.incident_ics_objectives (incident_id, status, sequence_no, created_at);

CREATE TABLE airs.incident_ics_positions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES airs.incident_ics_positions(id) ON DELETE SET NULL,
  position_type    text NOT NULL CHECK (position_type IN (
                    'incident_command','command_staff','operations','planning','logistics','finance_admin',
                    'branch','division','group','unit','staging_area','other')),
  label            text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  leader_name      text NOT NULL DEFAULT '',
  agency_name      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','completed')),
  created_by_account uuid REFERENCES airs.accounts(id),
  updated_by_account uuid REFERENCES airs.accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX incident_ics_positions_incident_idx
  ON airs.incident_ics_positions (incident_id, position_type, status, created_at);

CREATE TABLE airs.incident_resource_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  request_number   text NOT NULL,
  requested_by     text NOT NULL DEFAULT '',
  requested_from   text NOT NULL DEFAULT '',
  resource_kind    text NOT NULL CHECK (resource_kind IN (
                    'personnel','law_enforcement','fire_ems','aviation','uas','counter_uas',
                    'communications','public_works','medical','logistics','specialty_team','other')),
  quantity         int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 9999),
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1500),
  priority         text NOT NULL DEFAULT 'routine' CHECK (priority IN ('immediate','high','routine')),
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN (
                    'draft','requested','acknowledged','partially_filled','filled','denied','cancelled')),
  needed_at        timestamptz,
  staging_location text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  created_by_account uuid REFERENCES airs.accounts(id),
  updated_by_account uuid REFERENCES airs.accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, request_number)
);
CREATE INDEX incident_resource_requests_incident_idx
  ON airs.incident_resource_requests (incident_id, status, priority, created_at);

CREATE OR REPLACE FUNCTION airs.ics_origin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
DECLARE room_org uuid;
BEGIN
  SELECT org_id INTO room_org FROM airs.incident_rooms WHERE id = NEW.incident_id;
  IF room_org IS NULL OR NEW.org_id <> room_org THEN
    RAISE EXCEPTION 'ICS record organization must match incident owner';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.incident_id <> OLD.incident_id OR NEW.org_id <> OLD.org_id) THEN
    RAISE EXCEPTION 'ICS incident ownership is immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER incident_ics_profiles_guard BEFORE INSERT OR UPDATE ON airs.incident_ics_profiles
  FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();
CREATE TRIGGER incident_ics_objectives_guard BEFORE INSERT OR UPDATE ON airs.incident_ics_objectives
  FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();
CREATE TRIGGER incident_ics_positions_guard BEFORE INSERT OR UPDATE ON airs.incident_ics_positions
  FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();
CREATE TRIGGER incident_resource_requests_guard BEFORE INSERT OR UPDATE ON airs.incident_resource_requests
  FOR EACH ROW EXECUTE FUNCTION airs.ics_origin_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'incident_ics_profiles','incident_ics_objectives','incident_ics_positions','incident_resource_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

CREATE POLICY incident_ics_profiles_read ON airs.incident_ics_profiles FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_ics_profiles_write ON airs.incident_ics_profiles FOR ALL
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY incident_ics_objectives_read ON airs.incident_ics_objectives FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_ics_objectives_write ON airs.incident_ics_objectives FOR ALL
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY incident_ics_positions_read ON airs.incident_ics_positions FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_ics_positions_write ON airs.incident_ics_positions FOR ALL
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY incident_resource_requests_read ON airs.incident_resource_requests FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY incident_resource_requests_write ON airs.incident_resource_requests FOR ALL
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

COMMIT;
