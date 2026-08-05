-- AIRS Agent — Stage 7: Common Operating Picture map and operating areas.
--
-- Adds the geospatial plane. Portable PostgreSQL + PostGIS; every geometry is
-- stored in SRID 4326 (WGS 84) so the data is interchangeable with any GIS,
-- any tile server and any renderer. No hosted geocoder, no proprietary tile
-- key and no vendor SDK is required by the database.
--
-- Two independent decisions govern every geographic read:
--   1. ROW access  — row-level security (same rules as Stage 5/6: own tenant,
--      or a live incident participation / live resource share).
--   2. GEOGRAPHIC PRECISION — how exactly a released geometry may be
--      expressed. A partner that may see THAT a launch site exists does not
--      automatically get its exact coordinate.
-- Neither layer may widen the other, and both default to the narrower answer.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- 1. Permissions (SQL side of the RBAC parity contract)
-- ---------------------------------------------------------------------------
INSERT INTO airs.permissions (key, description) VALUES
  ('map.read',                    'View the common operating picture for the active organization'),
  ('map.feature.manage',          'Create and maintain organization-owned map features'),
  ('map.operating_area.propose',  'Propose an incident operating area'),
  ('map.operating_area.approve',  'Approve, suspend or complete an incident operating area'),
  ('map.position.report',         'Record a manual fixed or temporary resource position'),
  ('map.precision.manage',        'Set the geographic precision released to partner agencies')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  ('agency_admin','map.read'),('agency_admin','map.feature.manage'),
  ('agency_admin','map.precision.manage'),
  ('airspace_supervisor','map.read'),('airspace_supervisor','map.feature.manage'),
  ('airspace_supervisor','map.operating_area.propose'),
  ('airspace_supervisor','map.operating_area.approve'),
  ('airspace_supervisor','map.position.report'),
  ('airspace_supervisor','map.precision.manage'),
  ('rpic','map.read'),('rpic','map.position.report'),
  ('visual_observer','map.read'),
  ('dispatcher','map.read'),('dispatcher','map.position.report'),
  ('dispatcher','map.operating_area.propose'),
  ('incident_commander','map.read'),('incident_commander','map.operating_area.propose'),
  ('incident_commander','map.operating_area.approve'),
  ('incident_commander','map.position.report'),
  ('incident_commander','map.precision.manage'),
  ('intel_analyst','map.read'),
  ('partner_agency_user','map.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Geographic precision vocabulary (reference data, app role reads only)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.geographic_precisions (
  policy    text PRIMARY KEY,
  grid_deg  numeric,        -- rounding grid in degrees; NULL = not a rounding policy
  rank      int  NOT NULL,  -- higher = more precise; used to take the narrower of two
  label     text NOT NULL
);
INSERT INTO airs.geographic_precisions (policy, grid_deg, rank, label) VALUES
  ('withheld',    NULL,   0, 'Withheld'),
  ('area_only',   NULL,   1, 'General area only'),
  ('generalized', 0.01,   2, 'Generalized (~1 km)'),
  ('approximate', 0.001,  3, 'Approximate (~100 m)'),
  ('exact',       NULL,   4, 'Exact');
GRANT SELECT ON airs.geographic_precisions TO airs_app;

-- Disclosure profile -> the MOST precise geography that profile may ever carry.
CREATE TABLE airs.disclosure_precisions (
  profile text PRIMARY KEY,
  policy  text NOT NULL REFERENCES airs.geographic_precisions(policy)
);
INSERT INTO airs.disclosure_precisions (profile, policy) VALUES
  ('summary',          'withheld'),
  ('operational',      'area_only'),
  ('aviation',         'approximate'),
  ('incident_command', 'exact'),
  ('full',             'exact'),
  ('custom',           'area_only');
GRANT SELECT ON airs.disclosure_precisions TO airs_app;

-- Takes the NARROWER of the owner's declared policy and the profile ceiling.
CREATE OR REPLACE FUNCTION airs.resolve_precision(
  p_declared text, p_profile text, p_is_owner boolean
) RETURNS text
LANGUAGE sql STABLE SET search_path = airs, public, pg_catalog AS $$
  SELECT CASE
    WHEN p_is_owner THEN 'exact'
    ELSE COALESCE((
      SELECT gp.policy
        FROM airs.geographic_precisions gp
       WHERE gp.rank = LEAST(
               COALESCE((SELECT rank FROM airs.geographic_precisions WHERE policy = p_declared), 0),
               COALESCE((SELECT gp2.rank
                           FROM airs.disclosure_precisions dp
                           JOIN airs.geographic_precisions gp2 ON gp2.policy = dp.policy
                          WHERE dp.profile = p_profile), 0))
    ), 'withheld')
  END
$$;
GRANT EXECUTE ON FUNCTION airs.resolve_precision(text, text, boolean) TO airs_app;

-- Applies a precision policy to a geometry. Default deny: an unknown policy
-- yields NULL, so a caller can never obtain geography by naming a policy the
-- database does not know.
CREATE OR REPLACE FUNCTION airs.apply_precision(g public.geometry, p_policy text)
RETURNS public.geometry
LANGUAGE plpgsql IMMUTABLE SET search_path = airs, public, pg_catalog AS $$
DECLARE grid numeric;
BEGIN
  IF g IS NULL THEN RETURN NULL; END IF;
  IF p_policy = 'exact' THEN RETURN g; END IF;
  IF p_policy = 'area_only' THEN
    -- A coarse envelope around the feature: conveys "roughly here", never a point.
    RETURN public.ST_Envelope(public.ST_Buffer(public.ST_Envelope(g), 0.02));
  END IF;
  SELECT grid_deg INTO grid FROM airs.geographic_precisions WHERE policy = p_policy;
  IF grid IS NULL THEN RETURN NULL; END IF;   -- 'withheld' and unknown policies
  RETURN public.ST_SnapToGrid(g, grid);
END $$;
GRANT EXECUTE ON FUNCTION airs.apply_precision(public.geometry, text) TO airs_app;

-- ---------------------------------------------------------------------------
-- 3. Position freshness (never inferred in the browser)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.location_freshness(
  p_reported_at timestamptz, p_expires_at timestamptz
) RETURNS text
LANGUAGE sql STABLE SET search_path = airs, public, pg_catalog AS $$
  SELECT CASE
    WHEN p_reported_at IS NULL THEN 'unknown'
    WHEN p_expires_at IS NOT NULL AND p_expires_at <= now() THEN 'expired'
    WHEN now() - p_reported_at < interval '5 minutes'  THEN 'fresh'
    WHEN now() - p_reported_at < interval '15 minutes' THEN 'recent'
    WHEN now() - p_reported_at < interval '60 minutes' THEN 'aging'
    ELSE 'stale'
  END
$$;
GRANT EXECUTE ON FUNCTION airs.location_freshness(timestamptz, timestamptz) TO airs_app;

-- ---------------------------------------------------------------------------
-- 4. Organization-owned map features
-- ---------------------------------------------------------------------------
CREATE TABLE airs.map_features (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  incident_id       uuid REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  feature_type      text NOT NULL CHECK (feature_type IN (
                      'staging_area','landing_zone','hazard','point_of_interest',
                      'boundary','route','sector','search_area','command_post')),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description       text NOT NULL DEFAULT '',
  geom              public.geometry(Geometry, 4326) NOT NULL,
  classification    text NOT NULL DEFAULT 'originating_org_only' CHECK (classification IN (
                      'participating_orgs','public_safety_only','law_enforcement_sensitive',
                      'aviation_personnel_only','incident_command_only','originating_org_only',
                      'named_recipients')),
  precision_policy  text NOT NULL DEFAULT 'approximate'
                    REFERENCES airs.geographic_precisions(policy),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from    timestamptz,
  effective_to      timestamptz,
  version           int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_account uuid REFERENCES airs.accounts(id),
  updated_by_account uuid REFERENCES airs.accounts(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (public.ST_SRID(geom) = 4326),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX map_features_org_idx ON airs.map_features (org_id, status);
CREATE INDEX map_features_incident_idx ON airs.map_features (incident_id);
CREATE INDEX map_features_geom_idx ON airs.map_features USING gist (geom);

-- ---------------------------------------------------------------------------
-- 5. Incident operating areas (the airspace volume, not just a shape)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.operating_areas (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  incident_id        uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  purpose            text NOT NULL DEFAULT '',
  area               public.geometry(Polygon, 4326) NOT NULL,
  altitude_floor_ft  int NOT NULL DEFAULT 0 CHECK (altitude_floor_ft BETWEEN 0 AND 18000),
  altitude_ceiling_ft int NOT NULL DEFAULT 400 CHECK (altitude_ceiling_ft BETWEEN 0 AND 18000),
  starts_at          timestamptz NOT NULL DEFAULT now(),
  ends_at            timestamptz,
  status             text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                       'proposed','approved','active','suspended','completed','cancelled')),
  classification     text NOT NULL DEFAULT 'participating_orgs' CHECK (classification IN (
                       'participating_orgs','public_safety_only','law_enforcement_sensitive',
                       'aviation_personnel_only','incident_command_only','originating_org_only',
                       'named_recipients')),
  precision_policy   text NOT NULL DEFAULT 'exact'
                     REFERENCES airs.geographic_precisions(policy),
  approved_by_account uuid REFERENCES airs.accounts(id),
  approved_at        timestamptz,
  created_by_account uuid REFERENCES airs.accounts(id),
  version            int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (altitude_ceiling_ft >= altitude_floor_ft),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (public.ST_SRID(area) = 4326)
);
CREATE INDEX operating_areas_incident_idx ON airs.operating_areas (incident_id, status);
CREATE INDEX operating_areas_geom_idx ON airs.operating_areas USING gist (area);

-- ---------------------------------------------------------------------------
-- 6. Resource locations — fixed sites and manual temporary positions
-- ---------------------------------------------------------------------------
CREATE TABLE airs.resource_locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  resource_id        uuid NOT NULL REFERENCES airs.resources(id) ON DELETE CASCADE,
  incident_id        uuid REFERENCES airs.incident_rooms(id) ON DELETE SET NULL,
  location_kind      text NOT NULL CHECK (location_kind IN ('fixed','temporary')),
  geom               public.geometry(Point, 4326) NOT NULL,
  altitude_ft        int CHECK (altitude_ft IS NULL OR altitude_ft BETWEEN -1000 AND 18000),
  accuracy_meters    int CHECK (accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 100000),
  -- Manual entry only. There is no telemetry, tracking or live feed in this stage.
  position_source    text NOT NULL DEFAULT 'manual'
                     CHECK (position_source IN ('manual','planned','last_known')),
  note               text NOT NULL DEFAULT '',
  precision_policy   text NOT NULL DEFAULT 'approximate'
                     REFERENCES airs.geographic_precisions(policy),
  reported_at        timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  superseded_at      timestamptz,
  reported_by_account uuid REFERENCES airs.accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (public.ST_SRID(geom) = 4326),
  CHECK (expires_at IS NULL OR expires_at > reported_at),
  -- A fixed site is a property of the resource and never expires on a clock.
  CHECK (location_kind = 'temporary' OR (expires_at IS NULL AND incident_id IS NULL))
);
-- Exactly one live fixed location per resource; temporary positions keep history.
CREATE UNIQUE INDEX resource_locations_fixed_idx ON airs.resource_locations (resource_id)
  WHERE location_kind = 'fixed' AND superseded_at IS NULL;
CREATE INDEX resource_locations_current_idx
  ON airs.resource_locations (resource_id, reported_at DESC);
CREATE INDEX resource_locations_geom_idx ON airs.resource_locations USING gist (geom);

-- ---------------------------------------------------------------------------
-- 7. Guards: ownership immutability, room ownership, terminal states
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.map_feature_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE room_org uuid; room_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id
       OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'map feature ownership and identity are immutable';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      RAISE EXCEPTION 'an archived map feature cannot be reactivated';
    END IF;
  END IF;
  IF NEW.incident_id IS NOT NULL THEN
    SELECT org_id, status INTO room_org, room_status
      FROM airs.incident_rooms WHERE id = NEW.incident_id;
    IF room_org IS NULL OR room_org <> NEW.org_id THEN
      RAISE EXCEPTION 'only the originating organization may place features in its incident room';
    END IF;
    IF TG_OP = 'INSERT' AND room_status IN ('closed','archived') THEN
      RAISE EXCEPTION 'a closed incident room cannot accept new map features';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER map_feature_guard BEFORE INSERT OR UPDATE ON airs.map_features
  FOR EACH ROW EXECUTE FUNCTION airs.map_feature_guard();

CREATE OR REPLACE FUNCTION airs.operating_area_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE room_org uuid; room_status text;
BEGIN
  SELECT org_id, status INTO room_org, room_status
    FROM airs.incident_rooms WHERE id = NEW.incident_id;
  IF room_org IS NULL OR room_org <> NEW.org_id THEN
    RAISE EXCEPTION 'only the originating organization may define operating areas in its room';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF room_status IN ('closed','archived') THEN
      RAISE EXCEPTION 'a closed incident room cannot accept new operating areas';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.incident_id <> OLD.incident_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'operating area ownership and identity are immutable';
    END IF;
    IF OLD.status IN ('completed','cancelled') AND NEW.status NOT IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'a completed or cancelled operating area cannot be reactivated';
    END IF;
  END IF;
  IF NEW.status IN ('approved','active') AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'an approved operating area must record its approval';
  END IF;
  IF NEW.status = 'proposed' AND NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'a proposed operating area cannot carry an approval';
  END IF;
  IF NOT public.ST_IsValid(NEW.area) THEN
    RAISE EXCEPTION 'operating area geometry is not a valid polygon';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER operating_area_guard BEFORE INSERT OR UPDATE ON airs.operating_areas
  FOR EACH ROW EXECUTE FUNCTION airs.operating_area_guard();

CREATE OR REPLACE FUNCTION airs.resource_location_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE owner_org uuid; room_org uuid;
BEGIN
  SELECT org_id INTO owner_org FROM airs.resources WHERE id = NEW.resource_id;
  IF owner_org IS NULL OR owner_org <> NEW.org_id THEN
    RAISE EXCEPTION 'an organization may only report positions for resources it owns';
  END IF;
  IF NEW.incident_id IS NOT NULL THEN
    SELECT org_id INTO room_org FROM airs.incident_rooms WHERE id = NEW.incident_id;
    IF room_org IS NULL THEN
      RAISE EXCEPTION 'unknown incident room';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.resource_id <> OLD.resource_id
       OR NEW.reported_at <> OLD.reported_at OR NOT public.ST_Equals(NEW.geom, OLD.geom) THEN
      -- A position report is evidence: it is superseded, never edited.
      RAISE EXCEPTION 'a recorded position is immutable; record a new one instead';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_location_guard BEFORE INSERT OR UPDATE ON airs.resource_locations
  FOR EACH ROW EXECUTE FUNCTION airs.resource_location_guard();

-- ---------------------------------------------------------------------------
-- 8. Grants + forced row-level security
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['map_features','operating_areas','resource_locations'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

-- Map features: own tenant always; a partner only through a live participation
-- in the room the feature was placed in. An org-level feature with no room is
-- never visible outside the owning tenant.
CREATE POLICY map_feature_read ON airs.map_features FOR SELECT
  USING (org_id = airs.current_org_id()
         OR (incident_id IS NOT NULL AND airs.has_incident_access(incident_id)));
CREATE POLICY map_feature_insert ON airs.map_features FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY map_feature_update ON airs.map_features FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY map_feature_delete ON airs.map_features FOR DELETE
  USING (org_id = airs.current_org_id() AND status = 'archived');

CREATE POLICY operating_area_read ON airs.operating_areas FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(incident_id));
CREATE POLICY operating_area_insert ON airs.operating_areas FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY operating_area_update ON airs.operating_areas FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- Resource locations follow the resource: a partner reaches one only through a
-- live, unrevoked share of that resource in a room it still participates in.
CREATE POLICY resource_location_read ON airs.resource_locations FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_shared_resource(resource_id));
CREATE POLICY resource_location_insert ON airs.resource_locations FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY resource_location_update ON airs.resource_locations FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY resource_location_delete ON airs.resource_locations FOR DELETE
  USING (org_id = airs.current_org_id());

-- ---------------------------------------------------------------------------
-- 8b. Incident access level -> disclosure profile for geography.
--
-- SECURITY DEFINER so a partner can learn its OWN entitlement without holding
-- read access to the participant table of a room it does not own. Default deny:
-- anything other than a live participation collapses to 'summary', which the
-- precision table maps to 'withheld'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.incident_geo_profile(inc uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM airs.incident_rooms r
                  WHERE r.id = inc AND r.org_id = airs.current_org_id()) THEN 'full'
    WHEN NOT airs.has_incident_access(inc) THEN 'summary'
    ELSE COALESCE((
      SELECT CASE p.access_level
               WHEN 'incident_command' THEN 'incident_command'
               WHEN 'operational'      THEN 'operational'
               ELSE 'summary'
             END
        FROM airs.incident_participants p
       WHERE p.incident_id = inc
         AND p.partner_org_id = airs.current_org_id()
         AND p.participation_status = 'active'
       LIMIT 1), 'summary')
  END
$$;
REVOKE ALL ON FUNCTION airs.incident_geo_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.incident_geo_profile(uuid) TO airs_app;

-- ---------------------------------------------------------------------------
-- 9. Closure rule: closing a room ends its geography as well as its access.
--
-- SECURITY DEFINER for the same reason as terminate_incident_resource_access:
-- the closing organization must be able to end rows it does not own. The
-- function refuses unless the caller's active organization owns the room, and
-- it can only ever REMOVE geography — never create or restore any.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.terminate_incident_geography(inc uuid)
RETURNS TABLE (areas_completed int, features_archived int, positions_expired int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
DECLARE owner_org uuid; a int; f int; p int;
BEGIN
  SELECT org_id INTO owner_org FROM airs.incident_rooms WHERE id = inc;
  IF owner_org IS NULL OR owner_org <> airs.current_org_id() THEN
    RAISE EXCEPTION 'only the originating organization may terminate incident geography';
  END IF;

  UPDATE airs.operating_areas
     SET status = 'completed', updated_at = now()
   WHERE incident_id = inc AND status IN ('proposed','approved','active','suspended');
  GET DIAGNOSTICS a = ROW_COUNT;

  UPDATE airs.map_features
     SET status = 'archived', updated_at = now()
   WHERE incident_id = inc AND status = 'active';
  GET DIAGNOSTICS f = ROW_COUNT;

  UPDATE airs.resource_locations
     SET superseded_at = now(), expires_at = LEAST(COALESCE(expires_at, now()), now())
   WHERE incident_id = inc AND location_kind = 'temporary' AND superseded_at IS NULL;
  GET DIAGNOSTICS p = ROW_COUNT;

  areas_completed := a; features_archived := f; positions_expired := p; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION airs.terminate_incident_geography(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.terminate_incident_geography(uuid) TO airs_app;

COMMIT;
