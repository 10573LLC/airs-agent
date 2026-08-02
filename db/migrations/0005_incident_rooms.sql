-- AIRS Agent — Stage 5: Incident Room Lifecycle.
--
-- Adds the temporary, owner-controlled incident room and everything needed to
-- invite, approve, restrict, revoke and remove partner organizations, plus the
-- trusted-agency eligibility model. Portable PostgreSQL; no vendor extensions.
--
-- Ownership invariant: airs.incident_rooms.org_id is the ORIGINATING
-- organization. It is immutable (trigger), it is the only organization that
-- may write the room, and no participation row can ever transfer it.
--
-- Access invariant: a partner organization sees a room only through an
-- ACCEPTED + ACTIVE/RESTRICTED, unexpired, unrevoked, unremoved participation
-- row for a room that is not closed or archived. Everything else is denied by
-- the absence of a policy.

BEGIN;

-- ---------------------------------------------------------------------------
-- New permissions (SQL side of the RBAC parity contract)
-- ---------------------------------------------------------------------------
INSERT INTO airs.permissions (key, description) VALUES
  ('incident.activate',         'Activate a scheduled or paused incident room'),
  ('incident.pause',            'Pause an active incident room'),
  ('incident.resume',           'Resume a paused incident room'),
  ('incident.archive',          'Archive a closed incident room'),
  ('incident.invite_partner',   'Invite a trusted partner organization to an incident room'),
  ('incident.approve_partner',  'Approve a partner organization''s participation'),
  ('incident.restrict_partner', 'Restrict or suspend a participating organization'),
  ('incident.remove_partner',   'Remove a participating organization from the room'),
  ('incident.view_participants','View the participating organizations of an incident room')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO airs.role_permissions (role_key, permission_key) VALUES
  -- Incident Commander owns the room lifecycle end to end.
  ('incident_commander','incident.activate'),
  ('incident_commander','incident.pause'),
  ('incident_commander','incident.resume'),
  ('incident_commander','incident.archive'),
  ('incident_commander','incident.invite_partner'),
  ('incident_commander','incident.approve_partner'),
  ('incident_commander','incident.restrict_partner'),
  ('incident_commander','incident.remove_partner'),
  ('incident_commander','incident.view_participants'),
  -- Dispatcher / RTCC operates rooms but never shares or closes them.
  ('dispatcher','incident.activate'),
  ('dispatcher','incident.pause'),
  ('dispatcher','incident.resume'),
  ('dispatcher','incident.view_participants'),
  -- Agency Administrator governs retention/archival and oversight only.
  ('agency_admin','incident.archive'),
  ('agency_admin','incident.view_participants'),
  -- Read-side roles may see who is in the room, nothing more.
  ('intel_analyst','incident.view_participants'),
  ('airspace_supervisor','incident.view_participants'),
  ('partner_agency_user','incident.view_participants')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Trusted-agency relationships (eligibility only, never access)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.trusted_agencies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  partner_org_id uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','restricted','suspended','revoked')),
  note           text,
  requested_by   uuid REFERENCES airs.users(id),
  approved_by    uuid REFERENCES airs.users(id),
  approved_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, partner_org_id),
  CHECK (org_id <> partner_org_id)
);

-- ---------------------------------------------------------------------------
-- Incident rooms
-- ---------------------------------------------------------------------------
CREATE TABLE airs.incident_rooms (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE RESTRICT,
  name                    text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  incident_type           text NOT NULL CHECK (incident_type IN (
                            'routine_dfr','planned_event','missing_person','search_and_rescue',
                            'fire','critical_incident','tactical_operation','disaster',
                            'infrastructure_incident','unauthorized_uas_investigation',
                            'counter_uas_coordination','training','mutual_aid','other')),
  description             text NOT NULL DEFAULT '',
  external_number         text,
  geographic_description  text,
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','scheduled','active','paused','closing','closed','archived')),
  classification          text NOT NULL DEFAULT 'restricted'
                          CHECK (classification IN ('public','restricted','sensitive')),
  default_share_rule      text NOT NULL DEFAULT 'no_sharing'
                          CHECK (default_share_rule IN ('no_sharing','view_only','operational')),
  temp_data_retention_hours int NOT NULL DEFAULT 72 CHECK (temp_data_retention_hours BETWEEN 1 AND 8760),
  scheduled_start_at      timestamptz,
  scheduled_expires_at    timestamptz,
  activated_at            timestamptz,
  closing_started_at      timestamptz,
  closed_at               timestamptz,
  closure_reason          text,
  archived_at             timestamptz,
  temp_data_expires_at    timestamptz,
  data_expired_at         timestamptz,
  created_by_account      uuid REFERENCES airs.accounts(id),
  updated_by_account      uuid REFERENCES airs.accounts(id),
  closed_by_account       uuid REFERENCES airs.accounts(id),
  version                 int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_rooms_org_idx ON airs.incident_rooms (org_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Incident participation (one row per partner organization per room)
-- ---------------------------------------------------------------------------
CREATE TABLE airs.incident_participants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id        uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE, -- originating org
  partner_org_id     uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  invitation_status  text NOT NULL DEFAULT 'pending'
                     CHECK (invitation_status IN ('pending','accepted','declined','revoked','expired')),
  participation_status text NOT NULL DEFAULT 'invited'
                     CHECK (participation_status IN ('invited','pending_approval','active',
                            'restricted','suspended','revoked','expired','removed','declined')),
  access_level       text NOT NULL DEFAULT 'view_only'
                     CHECK (access_level IN ('view_only','operational','incident_command')),
  requires_approval  boolean NOT NULL DEFAULT true,
  -- only the SHA-256 hash of the invitation token is ever stored
  token_hash         text UNIQUE,
  invited_by_org_id  uuid NOT NULL REFERENCES airs.organizations(id) ON DELETE CASCADE,
  invited_by_user    uuid REFERENCES airs.users(id),
  approved_by_user   uuid REFERENCES airs.users(id),
  accepted_by_user   uuid REFERENCES airs.users(id),
  invited_at         timestamptz NOT NULL DEFAULT now(),
  invitation_expires_at timestamptz NOT NULL,
  accepted_at        timestamptz,
  approved_at        timestamptz,
  expires_at         timestamptz,
  restricted_at      timestamptz,
  revoked_at         timestamptz,
  removed_at         timestamptz,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, partner_org_id),
  CHECK (org_id <> partner_org_id)
);
CREATE INDEX incident_participants_partner_idx
  ON airs.incident_participants (partner_org_id, participation_status);

-- ---------------------------------------------------------------------------
-- Access helper. SECURITY DEFINER so policies on incident_rooms may consult
-- incident_participants (and vice versa) without recursive policy evaluation.
-- It encodes the ONLY way a non-originating organization ever sees a room.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.has_incident_access(inc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM airs.incident_participants p
      JOIN airs.incident_rooms r ON r.id = p.incident_id
     WHERE p.incident_id = inc
       AND p.partner_org_id = airs.current_org_id()
       AND p.invitation_status = 'accepted'
       AND p.participation_status IN ('active','restricted')
       AND p.revoked_at IS NULL
       AND p.removed_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > now())
       AND r.status NOT IN ('closed','archived')
  )
$$;
REVOKE ALL ON FUNCTION airs.has_incident_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.has_incident_access(uuid) TO airs_app;

-- ---------------------------------------------------------------------------
-- Immutability triggers: ownership can never move, archived rooms are frozen,
-- and a partner may only ever touch its own participation bookkeeping fields.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION airs.incident_room_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'incident room ownership and identity are immutable';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'archived incident rooms are immutable';
  END IF;
  IF OLD.status = 'closed' AND NEW.status NOT IN ('closed','archived') THEN
    RAISE EXCEPTION 'a closed incident room cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER incident_room_guard BEFORE UPDATE ON airs.incident_rooms
  FOR EACH ROW EXECUTE FUNCTION airs.incident_room_guard();

CREATE OR REPLACE FUNCTION airs.incident_participant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.incident_id <> OLD.incident_id
     OR NEW.org_id <> OLD.org_id
     OR NEW.partner_org_id <> OLD.partner_org_id THEN
    RAISE EXCEPTION 'participation identity is immutable';
  END IF;
  -- Acting as the partner: accept / decline / withdraw only.
  IF airs.current_org_id() = OLD.partner_org_id AND airs.current_org_id() <> OLD.org_id THEN
    IF NEW.access_level <> OLD.access_level
       OR NEW.requires_approval <> OLD.requires_approval
       OR NEW.invitation_expires_at <> OLD.invitation_expires_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.invited_by_org_id <> OLD.invited_by_org_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.approved_by_user IS DISTINCT FROM OLD.approved_by_user THEN
      RAISE EXCEPTION 'a participating organization cannot alter its own grant';
    END IF;
    IF NEW.participation_status NOT IN ('pending_approval','active','declined','removed')
       OR OLD.participation_status IN ('revoked','removed','expired') THEN
      RAISE EXCEPTION 'invalid participation transition for a partner organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER incident_participant_guard BEFORE UPDATE ON airs.incident_participants
  FOR EACH ROW EXECUTE FUNCTION airs.incident_participant_guard();

-- ---------------------------------------------------------------------------
-- Grants + forced RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trusted_agencies','incident_rooms','incident_participants'] LOOP
    EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON airs.%I TO airs_app', t);
  END LOOP;
END $$;

-- trusted agencies: both sides may read the relationship; only the owning
-- organization may create or change it.
CREATE POLICY trusted_read ON airs.trusted_agencies FOR SELECT
  USING (org_id = airs.current_org_id() OR partner_org_id = airs.current_org_id());
CREATE POLICY trusted_insert ON airs.trusted_agencies FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY trusted_update ON airs.trusted_agencies FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());

-- incident rooms: originating organization, or a partner with live access.
CREATE POLICY room_read ON airs.incident_rooms FOR SELECT
  USING (org_id = airs.current_org_id() OR airs.has_incident_access(id));
CREATE POLICY room_insert ON airs.incident_rooms FOR INSERT
  WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY room_update ON airs.incident_rooms FOR UPDATE
  USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id());
CREATE POLICY room_delete ON airs.incident_rooms FOR DELETE
  USING (org_id = airs.current_org_id() AND status = 'draft');

-- participation: the originating organization sees every row; a partner sees
-- its own row, plus (only while it holds live access) the other participants.
CREATE POLICY participant_read ON airs.incident_participants FOR SELECT
  USING (org_id = airs.current_org_id()
         OR partner_org_id = airs.current_org_id()
         OR airs.has_incident_access(incident_id));
-- only the originating organization of the room may create participation
CREATE POLICY participant_insert ON airs.incident_participants FOR INSERT
  WITH CHECK (org_id = airs.current_org_id()
              AND invited_by_org_id = airs.current_org_id()
              AND EXISTS (SELECT 1 FROM airs.incident_rooms r
                           WHERE r.id = incident_id AND r.org_id = airs.current_org_id()));
CREATE POLICY participant_update ON airs.incident_participants FOR UPDATE
  USING (org_id = airs.current_org_id() OR partner_org_id = airs.current_org_id())
  WITH CHECK (org_id = airs.current_org_id() OR partner_org_id = airs.current_org_id());

COMMIT;