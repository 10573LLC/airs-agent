-- AIRS Agent — Stage 8: Manual Airspace Observations and Awareness layer.
--
-- The AWARENESS plane of the AIRS framework: structured, human-entered reports
-- of what was seen. Nothing in this migration ingests a feed, subscribes to
-- telemetry or reaches an external service. Every row is typed by a human and
-- owned by exactly one organization.
--
-- Three independent decisions govern every awareness read, and none may widen
-- another:
--   1. ROW access        — forced RLS: own tenant, an explicit live share, or a
--                          live incident participation for a participating_orgs
--                          observation.
--   2. FIELD disclosure  — the disclosure profile carried by the share decides
--                          which fields the server serialises (Stage 6 rules).
--   3. GEOGRAPHIC precision — the Stage 7 precision plane decides how exactly a
--                          released geometry may be expressed.
--
-- An observation is INFORMATION, never a determination. Reliability describes
-- the source, credibility describes the reported information and confidence
-- describes the reviewer. The database never combines them into a verdict.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permissions (SQL side of the RBAC parity contract)
-- ---------------------------------------------------------------------------
INSERT INTO airs.permissions (key, description) VALUES
  ('observation.create',                    'Create a manual airspace observation for the active organization'),
  ('observation.read',                      'Read authorized observations'),
  ('observation.update_own',                'Update permitted fields of an observation the organization owns'),
  ('observation.review',                    'Record reviewer annotations and move an observation through review'),
  ('observation.verify',                    'Corroborate or confirm an observation'),
  ('observation.reject',                    'Dispute, mark unable to verify, or reject an observation'),
  ('observation.close',                     'Close or cancel an observation'),
  ('observation.reopen',                    'Reopen a closed observation'),
  ('observation.share',                     'Share an observation with a partner organization'),
  ('observation.revoke_share',              'Revoke an observation share'),
  ('observation.link',                      'Create or invalidate a relationship between observations'),
  ('observation.evidence_reference_manage', 'Add or remove evidence references on an observation')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Deliberately uneven. Verification authority is NOT granted to every role:
-- agency_admin, rpic, visual_observer, dispatcher, partner_agency_user and
-- system_auditor cannot verify, and only the owning tenant can write at all.
INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  ('agency_admin','observation.create'),('agency_admin','observation.read'),
  ('agency_admin','observation.update_own'),('agency_admin','observation.review'),
  ('agency_admin','observation.close'),('agency_admin','observation.reopen'),
  ('agency_admin','observation.share'),('agency_admin','observation.revoke_share'),
  ('agency_admin','observation.link'),('agency_admin','observation.evidence_reference_manage'),

  ('airspace_supervisor','observation.create'),('airspace_supervisor','observation.read'),
  ('airspace_supervisor','observation.update_own'),('airspace_supervisor','observation.review'),
  ('airspace_supervisor','observation.verify'),('airspace_supervisor','observation.reject'),
  ('airspace_supervisor','observation.close'),('airspace_supervisor','observation.reopen'),
  ('airspace_supervisor','observation.share'),('airspace_supervisor','observation.revoke_share'),
  ('airspace_supervisor','observation.link'),
  ('airspace_supervisor','observation.evidence_reference_manage'),

  ('rpic','observation.create'),('rpic','observation.read'),
  ('rpic','observation.update_own'),('rpic','observation.evidence_reference_manage'),

  ('visual_observer','observation.create'),('visual_observer','observation.read'),
  ('visual_observer','observation.update_own'),

  ('dispatcher','observation.create'),('dispatcher','observation.read'),
  ('dispatcher','observation.update_own'),('dispatcher','observation.review'),
  ('dispatcher','observation.close'),('dispatcher','observation.link'),
  ('dispatcher','observation.evidence_reference_manage'),

  ('incident_commander','observation.create'),('incident_commander','observation.read'),
  ('incident_commander','observation.update_own'),('incident_commander','observation.review'),
  ('incident_commander','observation.verify'),('incident_commander','observation.reject'),
  ('incident_commander','observation.close'),('incident_commander','observation.reopen'),
  ('incident_commander','observation.share'),('incident_commander','observation.revoke_share'),
  ('incident_commander','observation.link'),
  ('incident_commander','observation.evidence_reference_manage'),

  ('intel_analyst','observation.create'),('intel_analyst','observation.read'),
  ('intel_analyst','observation.update_own'),('intel_analyst','observation.review'),
  ('intel_analyst','observation.verify'),('intel_analyst','observation.reject'),
  ('intel_analyst','observation.link'),
  ('intel_analyst','observation.evidence_reference_manage'),

  ('partner_agency_user','observation.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Freshness thresholds — central, documented, server-side only.
--    An observation is never "current" because it is still open; it is current
--    because the server clock says the observed time is recent enough for that
--    observation type.
-- ---------------------------------------------------------------------------
CREATE TABLE airs.observation_freshness_thresholds (
  observation_type text PRIMARY KEY,   -- 'default' is the fallback row
  current_minutes  int NOT NULL CHECK (current_minutes > 0),
  recent_minutes   int NOT NULL CHECK (recent_minutes > 0),
  aging_minutes    int NOT NULL CHECK (aging_minutes > 0),
  CHECK (recent_minutes > current_minutes AND aging_minutes > recent_minutes)
);
INSERT INTO airs.observation_freshness_thresholds VALUES
  ('default',                        15,   60,  240),
  ('unidentified_aircraft',           5,   15,   60),
  ('suspected_unauthorized_uas',      5,   15,   60),
  ('airspace_conflict',               5,   15,   60),
  ('manned_aircraft_activity',        5,   20,   90),
  ('remote_id_observation_manual',    5,   15,   60),
  ('flight_safety_hazard',           15,   60,  240),
  ('ground_hazard_air_ops',          30,  120,  480),
  ('communications_issue',           15,   60,  240),
  ('navigation_positioning_issue',   15,   60,  240),
  ('dock_launch_site_issue',         30,  120,  480),
  ('sensor_detection_issue',         30,  120,  480),
  ('critical_asset_concern',         60,  240, 1440),
  ('temporary_operating_condition',  60,  240, 1440),
  ('public_report',                  15,   60,  240),
  ('partner_agency_report',          15,   60,  240),
  ('authorized_public_safety_aircraft', 5,  20,   90),
  ('other_observation',              15,   60,  240);
GRANT SELECT ON airs.observation_freshness_thresholds TO airs_app;

CREATE OR REPLACE FUNCTION airs.observation_freshness(
  p_type text, p_observed_at timestamptz, p_visible_until timestamptz
) RETURNS text
LANGUAGE sql STABLE SET search_path = airs, public, pg_catalog AS $$
  SELECT CASE
    WHEN p_visible_until IS NOT NULL AND p_visible_until <= now() THEN 'expired'
    WHEN p_observed_at IS NULL THEN 'unknown'
    WHEN now() - p_observed_at < make_interval(mins => t.current_minutes) THEN 'current'
    WHEN now() - p_observed_at < make_interval(mins => t.recent_minutes)  THEN 'recent'
    WHEN now() - p_observed_at < make_interval(mins => t.aging_minutes)   THEN 'aging'
    ELSE 'stale'
  END
  FROM (
    SELECT COALESCE(
      (SELECT f FROM airs.observation_freshness_thresholds f WHERE f.observation_type = p_type),
      (SELECT f FROM airs.observation_freshness_thresholds f WHERE f.observation_type = 'default')
    ) AS r
  ) x, LATERAL (SELECT (x.r).current_minutes, (x.r).recent_minutes, (x.r).aging_minutes) t
$$;
GRANT EXECUTE ON FUNCTION airs.observation_freshness(text, timestamptz, timestamptz) TO airs_app;

-- ---------------------------------------------------------------------------
-- 3. The observation record
-- ---------------------------------------------------------------------------
CREATE TABLE airs.observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  incident_id           uuid REFERENCES airs.incident_rooms(id) ON DELETE SET NULL,

  observation_type      text NOT NULL CHECK (observation_type IN (
                          'unidentified_aircraft','authorized_public_safety_aircraft',
                          'suspected_unauthorized_uas','manned_aircraft_activity',
                          'remote_id_observation_manual','airspace_conflict',
                          'flight_safety_hazard','ground_hazard_air_ops',
                          'communications_issue','navigation_positioning_issue',
                          'dock_launch_site_issue','sensor_detection_issue',
                          'critical_asset_concern','temporary_operating_condition',
                          'public_report','partner_agency_report','other_observation')),
  title                 text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  -- Structured description: a fixed narrative field plus fixed structured
  -- columns. There is deliberately no free-form JSON payload and no
  -- client-defined property key anywhere in this schema.
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 8000),
  observed_object       text NOT NULL DEFAULT '' CHECK (length(observed_object) <= 240),
  observed_behavior     text NOT NULL DEFAULT '' CHECK (length(observed_behavior) <= 1000),
  observed_count        int  CHECK (observed_count IS NULL OR observed_count BETWEEN 0 AND 1000),
  observed_altitude_ft  int  CHECK (observed_altitude_ft IS NULL OR observed_altitude_ft BETWEEN -1000 AND 60000),

  observed_at           timestamptz,
  observed_time_precision text NOT NULL DEFAULT 'estimated'
                          CHECK (observed_time_precision IN ('exact','estimated','unknown')),
  reported_at           timestamptz NOT NULL DEFAULT now(),

  location_kind         text NOT NULL DEFAULT 'none' CHECK (location_kind IN (
                          'map_feature','operating_area','resource_location',
                          'manual_point','manual_shape','none')),
  map_feature_id        uuid REFERENCES airs.map_features(id) ON DELETE SET NULL,
  operating_area_id     uuid REFERENCES airs.operating_areas(id) ON DELETE SET NULL,
  resource_location_id  uuid REFERENCES airs.resource_locations(id) ON DELETE SET NULL,
  -- Only a MANUALLY entered location is stored here; a referenced feature or
  -- area keeps its geometry in its own table and is never duplicated.
  geom                  public.geometry(Geometry, 4326),
  precision_policy      text NOT NULL DEFAULT 'generalized'
                        REFERENCES airs.geographic_precisions(policy),

  source_type           text NOT NULL CHECK (source_type IN (
                          'direct_reporting_user','direct_other_agency_member','public_report',
                          'partner_agency_report','dispatch_communications_report',
                          'manual_sensor_reading','human_reviewed_media',
                          'document_written_report','other_source')),
  -- Restricted source plane. Never released to a partner by any profile.
  source_detail         text NOT NULL DEFAULT '' CHECK (length(source_detail) <= 2000),
  reporter_identity     text NOT NULL DEFAULT '' CHECK (length(reporter_identity) <= 240),
  reporter_contact      text NOT NULL DEFAULT '' CHECK (length(reporter_contact) <= 240),
  internal_notes        text NOT NULL DEFAULT '' CHECK (length(internal_notes) <= 4000),
  internal_case_number  text NOT NULL DEFAULT '' CHECK (length(internal_case_number) <= 120),

  source_reliability    text NOT NULL DEFAULT 'unknown' CHECK (source_reliability IN (
                          'unknown','unreliable','questionable','usually_reliable',
                          'reliable','highly_reliable')),
  information_credibility text NOT NULL DEFAULT 'unknown' CHECK (information_credibility IN (
                          'unknown','improbable','doubtful','possibly_true',
                          'probably_true','confirmed')),
  confidence_level      text NOT NULL DEFAULT 'unknown' CHECK (confidence_level IN (
                          'unknown','low','moderate','high','very_high')),

  verification_status   text NOT NULL DEFAULT 'unreviewed' CHECK (verification_status IN (
                          'unreviewed','under_review','corroborated','confirmed',
                          'disputed','unable_to_verify','rejected')),
  urgency               text NOT NULL DEFAULT 'routine'
                        CHECK (urgency IN ('routine','elevated','priority','immediate')),
  lifecycle_status      text NOT NULL DEFAULT 'open' CHECK (lifecycle_status IN (
                          'open','monitoring','action_required','resolved',
                          'closed','cancelled','expired')),

  classification        text NOT NULL DEFAULT 'originating_org_only' CHECK (classification IN (
                          'participating_orgs','public_safety_only','law_enforcement_sensitive',
                          'aviation_personnel_only','incident_command_only','originating_org_only',
                          'named_recipients')),
  disclosure_profile    text NOT NULL DEFAULT 'summary'
                        REFERENCES airs.disclosure_precisions(profile),

  visible_from          timestamptz NOT NULL DEFAULT now(),
  visible_until         timestamptz,

  created_by_account    uuid REFERENCES airs.accounts(id),
  updated_by_account    uuid REFERENCES airs.accounts(id),
  reviewed_at           timestamptz,
  reviewed_by_account   uuid REFERENCES airs.accounts(id),
  verified_by_account   uuid REFERENCES airs.accounts(id),
  verified_at           timestamptz,
  closed_by_account     uuid REFERENCES airs.accounts(id),
  closed_at             timestamptz,
  version               int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (geom IS NULL OR public.ST_SRID(geom) = 4326),
  CHECK (visible_until IS NULL OR visible_until > visible_from),
  -- The declared location kind and the stored reference must agree.
  CHECK (
    (location_kind = 'none'
       AND geom IS NULL AND map_feature_id IS NULL AND operating_area_id IS NULL
       AND resource_location_id IS NULL)
    OR (location_kind = 'map_feature'       AND map_feature_id IS NOT NULL AND geom IS NULL)
    OR (location_kind = 'operating_area'    AND operating_area_id IS NOT NULL AND geom IS NULL)
    OR (location_kind = 'resource_location' AND resource_location_id IS NOT NULL AND geom IS NULL)
    OR (location_kind IN ('manual_point','manual_shape') AND geom IS NOT NULL
        AND map_feature_id IS NULL AND operating_area_id IS NULL
        AND resource_location_id IS NULL)
  ),
  CHECK (location_kind <> 'manual_point' OR public.GeometryType(geom) = 'POINT'),
  CHECK (location_kind <> 'manual_shape'
         OR public.GeometryType(geom) IN ('LINESTRING','POLYGON'))
);
CREATE INDEX observations_org_idx ON airs.observations (org_id, lifecycle_status, observed_at DESC);
CREATE INDEX observations_incident_idx ON airs.observations (incident_id);
CREATE INDEX observations_type_idx ON airs.observations (observation_type);
CREATE INDEX observations_geom_idx ON airs.observations USING gist (geom);

-- ---------------------------------------------------------------------------
-- 4. Annotations — the original report is never rewritten in place
-- ---------------------------------------------------------------------------
CREATE TABLE airs.observation_annotations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  observation_id   uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  annotation_type  text NOT NULL CHECK (annotation_type IN (
                     'review_note','correction','clarification','reviewer_assessment',
                     'status_rationale')),
  body             text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  -- 'internal' annotations never leave the originating organization.
  visibility       text NOT NULL DEFAULT 'internal'
                   CHECK (visibility IN ('internal','shared')),
  author_account   uuid REFERENCES airs.accounts(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observation_annotations_idx
  ON airs.observation_annotations (observation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Relationships, information gaps, evidence references
-- ---------------------------------------------------------------------------
CREATE TABLE airs.observation_relationships (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  observation_id         uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  related_observation_id uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  relationship           text NOT NULL CHECK (relationship IN (
                           'supports','corroborates','contradicts','possible_duplicate',
                           'updates','supersedes','related_to')),
  note                   text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_by_account     uuid REFERENCES airs.accounts(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  invalidated_at         timestamptz,
  invalidated_by_account uuid REFERENCES airs.accounts(id),
  CHECK (observation_id <> related_observation_id)
);
CREATE UNIQUE INDEX observation_relationships_live_idx
  ON airs.observation_relationships (observation_id, related_observation_id, relationship)
  WHERE invalidated_at IS NULL;

CREATE TABLE airs.observation_information_gaps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  observation_id      uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  gap_type            text NOT NULL CHECK (gap_type IN (
                        'identity_unknown','location_uncertain','time_uncertain',
                        'authorization_unknown','aircraft_type_unknown','operator_unknown',
                        'intent_unknown','additional_witness_needed','additional_imagery_needed',
                        'sensor_confirmation_needed','partner_confirmation_needed',
                        'policy_legal_review_needed','other_gap')),
  detail              text NOT NULL DEFAULT '' CHECK (length(detail) <= 1000),
  -- An information gap is a record of what is not known. It is NOT a task
  -- assignment: this stage has no dispatch, tasking or assignment semantics.
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','resolved','cancelled')),
  resolution_note     text NOT NULL DEFAULT '' CHECK (length(resolution_note) <= 1000),
  created_by_account  uuid REFERENCES airs.accounts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_by_account uuid REFERENCES airs.accounts(id),
  resolved_at         timestamptz,
  CHECK (status = 'open' OR resolved_at IS NOT NULL)
);
CREATE INDEX observation_gaps_idx ON airs.observation_information_gaps (observation_id, status);

-- Evidence REFERENCES only. No file upload, no storage credential, no signed
-- URL and no local path is stored or emitted by this system.
CREATE TABLE airs.observation_evidence_references (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  observation_id     uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  reference_type     text NOT NULL CHECK (reference_type IN (
                       'photograph','video','screenshot','document','audio',
                       'dispatch_record','sensor_export','external_case_number',
                       'other_evidence')),
  display_name       text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- An opaque case/record identifier held in another system of record.
  reference_value    text NOT NULL DEFAULT '' CHECK (length(reference_value) <= 240),
  classification     text NOT NULL DEFAULT 'originating_org_only' CHECK (classification IN (
                       'participating_orgs','public_safety_only','law_enforcement_sensitive',
                       'aviation_personnel_only','incident_command_only','originating_org_only',
                       'named_recipients')),
  created_by_account uuid REFERENCES airs.accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  removed_by_account uuid REFERENCES airs.accounts(id),
  CHECK (reference_value NOT ILIKE 'file:%'),
  CHECK (position('://' in reference_value) = 0 OR reference_value ILIKE 'https://%')
);
CREATE INDEX observation_evidence_idx
  ON airs.observation_evidence_references (observation_id, removed_at);

-- ---------------------------------------------------------------------------
-- 6. Shares — the only way an observation leaves its originating organization
-- ---------------------------------------------------------------------------
CREATE TABLE airs.observation_shares (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  observation_id      uuid NOT NULL REFERENCES airs.observations(id) ON DELETE CASCADE,
  partner_org_id      uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  incident_id         uuid REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  disclosure_profile  text NOT NULL DEFAULT 'summary'
                      REFERENCES airs.disclosure_precisions(profile),
  precision_policy    text NOT NULL DEFAULT 'area_only'
                      REFERENCES airs.geographic_precisions(policy),
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','revoked','expired')),
  shared_by_account   uuid REFERENCES airs.accounts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by_account  uuid REFERENCES airs.accounts(id),
  CHECK (org_id <> partner_org_id),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX observation_shares_live_idx
  ON airs.observation_shares (observation_id, partner_org_id) WHERE status = 'active';
CREATE INDEX observation_shares_partner_idx ON airs.observation_shares (partner_org_id, status);

-- ---------------------------------------------------------------------------
-- 7. Guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.observation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE room_org uuid; room_status text; ref_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Originating-organization ownership is immutable, as is the identity of
    -- the record and everything that establishes what was originally reported.
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at
       OR NEW.reported_at <> OLD.reported_at
       OR NEW.created_by_account IS DISTINCT FROM OLD.created_by_account THEN
      RAISE EXCEPTION 'observation ownership and origin are immutable';
    END IF;
    IF OLD.lifecycle_status = 'cancelled' AND NEW.lifecycle_status <> 'cancelled' THEN
      RAISE EXCEPTION 'a cancelled observation cannot be reopened';
    END IF;
  END IF;

  -- An observation may only be filed into a room the same organization owns or
  -- actively participates in; a closed room accepts no new observations.
  IF NEW.incident_id IS NOT NULL THEN
    SELECT org_id, status INTO room_org, room_status
      FROM airs.incident_rooms WHERE id = NEW.incident_id;
    IF room_org IS NULL THEN
      RAISE EXCEPTION 'unknown incident room';
    END IF;
    IF TG_OP = 'INSERT' AND room_status IN ('closed','archived') THEN
      RAISE EXCEPTION 'a closed incident room cannot accept new observations';
    END IF;
    IF room_org <> NEW.org_id AND NOT airs.has_incident_access(NEW.incident_id) THEN
      RAISE EXCEPTION 'observations may only be filed into an accessible incident room';
    END IF;
  END IF;

  -- A referenced location must belong to the same organization: an observation
  -- can never borrow another tenant's geometry.
  IF NEW.map_feature_id IS NOT NULL THEN
    SELECT org_id INTO ref_org FROM airs.map_features WHERE id = NEW.map_feature_id;
    IF ref_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'a referenced map feature must belong to the originating organization';
    END IF;
  END IF;
  IF NEW.operating_area_id IS NOT NULL THEN
    SELECT org_id INTO ref_org FROM airs.operating_areas WHERE id = NEW.operating_area_id;
    IF ref_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'a referenced operating area must belong to the originating organization';
    END IF;
  END IF;
  IF NEW.resource_location_id IS NOT NULL THEN
    SELECT org_id INTO ref_org FROM airs.resource_locations WHERE id = NEW.resource_location_id;
    IF ref_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'a referenced resource location must belong to the originating organization';
    END IF;
  END IF;

  IF NEW.geom IS NOT NULL AND NOT public.ST_IsValid(NEW.geom) THEN
    RAISE EXCEPTION 'observation geometry is not valid';
  END IF;

  -- Bookkeeping consistency: a verification state must carry its verifier.
  IF NEW.verification_status IN ('corroborated','confirmed','rejected')
     AND (NEW.verified_by_account IS NULL OR NEW.verified_at IS NULL) THEN
    RAISE EXCEPTION 'a verified or rejected observation must record who decided and when';
  END IF;
  IF NEW.lifecycle_status IN ('closed','cancelled')
     AND (NEW.closed_at IS NULL OR NEW.closed_by_account IS NULL) THEN
    RAISE EXCEPTION 'a closed observation must record who closed it and when';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER observation_guard BEFORE INSERT OR UPDATE ON airs.observations
  FOR EACH ROW EXECUTE FUNCTION airs.observation_guard();

-- Annotations and relationships are evidence of the review trail: append-only.
CREATE OR REPLACE FUNCTION airs.observation_annotation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'observation annotations are append-only';
END $$;
CREATE TRIGGER observation_annotation_guard
  BEFORE UPDATE OR DELETE ON airs.observation_annotations
  FOR EACH ROW EXECUTE FUNCTION airs.observation_annotation_guard();

CREATE OR REPLACE FUNCTION airs.observation_relationship_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE src_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id
       OR NEW.observation_id <> OLD.observation_id
       OR NEW.related_observation_id <> OLD.related_observation_id
       OR NEW.relationship <> OLD.relationship THEN
      RAISE EXCEPTION 'a relationship is invalidated, never rewritten';
    END IF;
    RETURN NEW;
  END IF;
  -- Linking never transfers ownership: only the organization that owns the
  -- SOURCE observation may attach a relationship to it.
  SELECT org_id INTO src_org FROM airs.observations WHERE id = NEW.observation_id;
  IF src_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'only the originating organization may relate its own observation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_relationship_guard
  BEFORE INSERT OR UPDATE ON airs.observation_relationships
  FOR EACH ROW EXECUTE FUNCTION airs.observation_relationship_guard();

CREATE OR REPLACE FUNCTION airs.observation_child_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE parent_org uuid;
BEGIN
  SELECT org_id INTO parent_org FROM airs.observations WHERE id = NEW.observation_id;
  IF parent_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'only the originating organization may annotate its own observation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_annotation_owner_guard
  BEFORE INSERT ON airs.observation_annotations
  FOR EACH ROW EXECUTE FUNCTION airs.observation_child_guard();
CREATE TRIGGER observation_gap_owner_guard
  BEFORE INSERT OR UPDATE ON airs.observation_information_gaps
  FOR EACH ROW EXECUTE FUNCTION airs.observation_child_guard();
CREATE TRIGGER observation_evidence_owner_guard
  BEFORE INSERT OR UPDATE ON airs.observation_evidence_references
  FOR EACH ROW EXECUTE FUNCTION airs.observation_child_guard();

CREATE OR REPLACE FUNCTION airs.observation_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = airs, public, pg_catalog AS $$
DECLARE owner_org uuid; trusted boolean;
BEGIN
  SELECT org_id INTO owner_org FROM airs.observations WHERE id = NEW.observation_id;
  IF owner_org IS DISTINCT FROM NEW.org_id THEN
    -- Closes onward sharing at the database: a receiving organization is not
    -- the owner, so it can never author a share of that observation.
    RAISE EXCEPTION 'only the originating organization may share its observation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM airs.trusted_agencies t
                    WHERE t.org_id = NEW.org_id AND t.partner_org_id = NEW.partner_org_id
                      AND t.status = 'approved') INTO trusted;
    IF NOT trusted THEN
      RAISE EXCEPTION 'an observation may only be shared with an approved trusted agency';
    END IF;
  ELSE
    IF NEW.observation_id <> OLD.observation_id OR NEW.org_id <> OLD.org_id
       OR NEW.partner_org_id <> OLD.partner_org_id THEN
      RAISE EXCEPTION 'observation share identity is immutable';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
      RAISE EXCEPTION 'a revoked observation share cannot be restored';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_share_guard BEFORE INSERT OR UPDATE ON airs.observation_shares
  FOR EACH ROW EXECUTE FUNCTION airs.observation_share_guard();

-- ---------------------------------------------------------------------------
-- 8. Access + disclosure helpers (SECURITY DEFINER: a partner must be able to
--    learn its OWN entitlement without reading the owner's share table)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.has_observation_access(obs uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM airs.observation_shares s
      JOIN airs.observations o ON o.id = s.observation_id
     WHERE s.observation_id = obs
       AND s.partner_org_id = airs.current_org_id()
       AND s.status = 'active'
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND (s.incident_id IS NULL OR airs.has_incident_access(s.incident_id))
       AND o.visible_from <= now()
       AND (o.visible_until IS NULL OR o.visible_until > now())
  )
  OR EXISTS (
    SELECT 1 FROM airs.observations o
     WHERE o.id = obs
       AND o.incident_id IS NOT NULL
       AND o.classification = 'participating_orgs'
       AND airs.has_incident_access(o.incident_id)
       AND o.visible_from <= now()
       AND (o.visible_until IS NULL OR o.visible_until > now())
  )
$$;
REVOKE ALL ON FUNCTION airs.has_observation_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.has_observation_access(uuid) TO airs_app;

-- Field-disclosure profile the CURRENT organization holds for an observation.
-- Default deny: anything but ownership or a live entitlement is 'summary'.
CREATE OR REPLACE FUNCTION airs.observation_profile(obs uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM airs.observations o
                  WHERE o.id = obs AND o.org_id = airs.current_org_id()) THEN 'full'
    WHEN NOT airs.has_observation_access(obs) THEN 'summary'
    ELSE COALESCE(
      (SELECT s.disclosure_profile FROM airs.observation_shares s
        WHERE s.observation_id = obs AND s.partner_org_id = airs.current_org_id()
          AND s.status = 'active' AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > now())
        ORDER BY s.created_at DESC LIMIT 1),
      (SELECT airs.incident_geo_profile(o.incident_id) FROM airs.observations o
        WHERE o.id = obs),
      'summary')
  END
$$;
REVOKE ALL ON FUNCTION airs.observation_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.observation_profile(uuid) TO airs_app;

-- The precision a share declares can only ever NARROW the owner's declaration.
CREATE OR REPLACE FUNCTION airs.observation_precision(obs uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
  SELECT airs.resolve_precision(
    (SELECT CASE
       WHEN o.org_id = airs.current_org_id() THEN o.precision_policy
       ELSE (SELECT gp.policy FROM airs.geographic_precisions gp
              WHERE gp.rank = LEAST(
                COALESCE((SELECT r.rank FROM airs.geographic_precisions r
                           WHERE r.policy = o.precision_policy), 0),
                COALESCE((SELECT r2.rank FROM airs.observation_shares s
                            JOIN airs.geographic_precisions r2 ON r2.policy = s.precision_policy
                           WHERE s.observation_id = obs
                             AND s.partner_org_id = airs.current_org_id()
                             AND s.status = 'active' AND s.revoked_at IS NULL
                             AND (s.expires_at IS NULL OR s.expires_at > now())
                           ORDER BY s.created_at DESC LIMIT 1),
                         COALESCE((SELECT r3.rank FROM airs.geographic_precisions r3
                                    WHERE r3.policy = o.precision_policy), 0))))
     END
     FROM airs.observations o WHERE o.id = obs),
    airs.observation_profile(obs),
    EXISTS (SELECT 1 FROM airs.observations o WHERE o.id = obs
             AND o.org_id = airs.current_org_id()))
$$;
REVOKE ALL ON FUNCTION airs.observation_precision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.observation_precision(uuid) TO airs_app;

-- ---------------------------------------------------------------------------
-- 9. Closure + expiration: incident closure ends every temporary entitlement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.terminate_incident_observations(inc uuid)
RETURNS TABLE (shares_revoked int, observations_closed int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
DECLARE owner_org uuid; s int; o int;
BEGIN
  SELECT org_id INTO owner_org FROM airs.incident_rooms WHERE id = inc;
  IF owner_org IS NULL OR owner_org <> airs.current_org_id() THEN
    RAISE EXCEPTION 'only the originating organization may terminate incident observations';
  END IF;

  UPDATE airs.observation_shares
     SET status = 'revoked', revoked_at = now()
   WHERE incident_id = inc AND status = 'active';
  GET DIAGNOSTICS s = ROW_COUNT;

  UPDATE airs.observations
     SET lifecycle_status = 'closed', closed_at = now(),
         closed_by_account = COALESCE(closed_by_account, created_by_account),
         updated_at = now()
   WHERE incident_id = inc AND org_id = owner_org
     AND lifecycle_status IN ('open','monitoring','action_required');
  GET DIAGNOSTICS o = ROW_COUNT;

  shares_revoked := s; observations_closed := o; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION airs.terminate_incident_observations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.terminate_incident_observations(uuid) TO airs_app;

-- Clock-driven expiry, invoked by the existing maintenance plane.
CREATE OR REPLACE FUNCTION airs.expire_observation_state()
RETURNS TABLE (observations_expired int, shares_expired int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = airs, public, pg_catalog AS $$
DECLARE o int; s int;
BEGIN
  UPDATE airs.observations
     SET lifecycle_status = 'expired', updated_at = now()
   WHERE visible_until IS NOT NULL AND visible_until <= now()
     AND lifecycle_status IN ('open','monitoring','action_required');
  GET DIAGNOSTICS o = ROW_COUNT;

  UPDATE airs.observation_shares
     SET status = 'expired'
   WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now();
  GET DIAGNOSTICS s = ROW_COUNT;

  observations_expired := o; shares_expired := s; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION airs.expire_observation_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.expire_observation_state() TO airs_app, airs_maintenance;

-- ---------------------------------------------------------------------------
-- 10. Grants + forced row-level security
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['observations','observation_annotations',
                           'observation_relationships','observation_information_gaps',
                           'observation_evidence_references','observation_shares'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

-- Observations: own tenant, or a live entitlement. No DELETE grant exists at
-- all — an observation is closed or cancelled, never erased.
CREATE POLICY observation_read ON airs.observations FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_observation_access(id));
CREATE POLICY observation_insert ON airs.observations FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY observation_update ON airs.observations FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- Internal annotations never leave the originating organization.
CREATE POLICY observation_annotation_read ON airs.observation_annotations FOR SELECT
  USING (org_id = airs.current_org_id()
         OR (visibility = 'shared' AND airs.has_observation_access(observation_id)));
CREATE POLICY observation_annotation_insert ON airs.observation_annotations FOR INSERT
  WITH CHECK (org_id = airs.current_org_id()
              AND EXISTS (SELECT 1 FROM airs.observations o
                           WHERE o.id = observation_id AND o.org_id = airs.current_org_id()));

CREATE POLICY observation_relationship_read ON airs.observation_relationships FOR SELECT
  USING (org_id = airs.current_org_id()
         OR airs.has_observation_access(observation_id));
CREATE POLICY observation_relationship_insert ON airs.observation_relationships FOR INSERT
  WITH CHECK (org_id = airs.current_org_id()
              AND EXISTS (SELECT 1 FROM airs.observations o
                           WHERE o.id = observation_id AND o.org_id = airs.current_org_id()));
CREATE POLICY observation_relationship_update ON airs.observation_relationships FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

CREATE POLICY observation_gap_read ON airs.observation_information_gaps FOR SELECT
  USING (org_id = airs.current_org_id());
CREATE POLICY observation_gap_insert ON airs.observation_information_gaps FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY observation_gap_update ON airs.observation_information_gaps FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- A partner may learn that evidence EXISTS only when the reference itself is
-- classified for sharing; storage details are stripped in the service layer.
CREATE POLICY observation_evidence_read ON airs.observation_evidence_references FOR SELECT
  USING (org_id = airs.current_org_id()
         OR (removed_at IS NULL
             AND classification IN ('participating_orgs','public_safety_only',
                                    'aviation_personnel_only')
             AND airs.has_observation_access(observation_id)));
CREATE POLICY observation_evidence_insert ON airs.observation_evidence_references FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY observation_evidence_update ON airs.observation_evidence_references FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- A partner may see THAT it holds a share, and nothing about other partners.
CREATE POLICY observation_share_read ON airs.observation_shares FOR SELECT
  USING (org_id = airs.current_org_id() OR partner_org_id = airs.current_org_id());
CREATE POLICY observation_share_insert ON airs.observation_shares FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY observation_share_update ON airs.observation_shares FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

COMMIT;
