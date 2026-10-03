BEGIN;
-- Additive migration: legacy Friend profiles are retained as private historical
-- declarations, never converted into sharing authorization.
CREATE TABLE airs.entity_profiles (
  org_id uuid PRIMARY KEY REFERENCES airs.organizations(id),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE airs.source_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES airs.organizations(id),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object'),
  health text NOT NULL DEFAULT 'identified' CHECK (health IN ('identified','configured','verified','unavailable')),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,org_id)
);
CREATE TABLE airs.partner_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES airs.organizations(id),
  recipient_org_id uuid NOT NULL REFERENCES airs.organizations(id),
  source_id uuid NOT NULL, policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_id,org_id) REFERENCES airs.source_systems(id,org_id),
  CHECK(org_id<>recipient_org_id)
);
CREATE TABLE airs.incident_source_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES airs.organizations(id),
  incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id),
  recipient_org_id uuid NOT NULL REFERENCES airs.organizations(id), source_id uuid NOT NULL,
  relationship text NOT NULL CHECK(relationship IN ('partner','associate','originating_entity')),
  envelope_id uuid REFERENCES airs.partner_envelopes(id),
  data_classes text[] NOT NULL CHECK(cardinality(data_classes)>0),
  starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(source_id,org_id) REFERENCES airs.source_systems(id,org_id),
  CHECK(expires_at>starts_at),
  CHECK((relationship='partner' AND envelope_id IS NOT NULL) OR (relationship IN ('associate','originating_entity') AND envelope_id IS NULL)),
  CHECK((relationship='originating_entity')=(org_id=recipient_org_id))
);
CREATE TABLE airs.operational_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES airs.organizations(id),
  incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id),
  source_id uuid, grant_id uuid REFERENCES airs.incident_source_grants(id),
  observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
  received_at timestamptz NOT NULL DEFAULT now(), operational_entity_id uuid,
  correlation_reason text, correlated_at timestamptz,
  expires_at timestamptz NOT NULL, evidence_policy text,
  FOREIGN KEY(source_id,org_id) REFERENCES airs.source_systems(id,org_id),
  CHECK(source_id IS NULL OR grant_id IS NOT NULL)
);
CREATE INDEX operational_observations_incident ON airs.operational_observations(incident_id,received_at);
CREATE TABLE airs.observation_correlations (
  org_id uuid NOT NULL REFERENCES airs.organizations(id),
  incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id),
  observation_id uuid NOT NULL REFERENCES airs.operational_observations(id) ON DELETE CASCADE,
  operational_entity_id uuid NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(incident_id,observation_id)
);
CREATE TABLE airs.supplemental_source_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES airs.organizations(id),
  incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id), source_id uuid NOT NULL,
  recipient_org_id uuid NOT NULL REFERENCES airs.organizations(id),
  profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
  starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revocation_status text NOT NULL DEFAULT 'not_requested' CHECK(revocation_status IN ('not_requested','pending','confirmed','failed')),
  revoked_at timestamptz,
  FOREIGN KEY(source_id,org_id) REFERENCES airs.source_systems(id,org_id), CHECK(expires_at>starts_at)
);
-- This metadata table contains no credentials, session cookies, or tokens.
COMMENT ON TABLE airs.supplemental_source_access IS 'Entity/event authorization and external provisioning/revocation receipts; never credential storage.';

CREATE FUNCTION airs.framework_incident_active(inc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
 SELECT EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=inc AND r.status='active'
   AND (r.scheduled_expires_at IS NULL OR r.scheduled_expires_at>now())
   AND (r.org_id=airs.current_org_id() OR airs.has_incident_access(inc)));
$$;
REVOKE ALL ON FUNCTION airs.framework_incident_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.framework_incident_active(uuid) TO airs_app;

CREATE FUNCTION airs.framework_grant_valid(gid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
 SELECT EXISTS(SELECT 1 FROM airs.incident_source_grants g
 JOIN airs.source_systems s ON s.id=g.source_id AND s.org_id=g.org_id
 LEFT JOIN airs.partner_envelopes e ON e.id=g.envelope_id
 JOIN airs.incident_rooms r ON r.id=g.incident_id
 WHERE g.id=gid AND g.revoked_at IS NULL AND g.expires_at>now()
 AND s.profile->>'ingestionAuthorization'='authorized'
 AND s.profile->'dataClasses' @> to_jsonb(g.data_classes)
 AND r.status='active' AND (r.scheduled_expires_at IS NULL OR r.scheduled_expires_at>now())
 AND (g.relationship IN ('associate','originating_entity') OR (e.revoked_at IS NULL AND e.expires_at>now()
   AND e.org_id=g.org_id AND e.source_id=g.source_id AND e.recipient_org_id=g.recipient_org_id
   AND e.policy->'incidentTypes' ? r.incident_type AND e.policy->'dataClasses' @> to_jsonb(g.data_classes)))
 AND (g.org_id=r.org_id OR EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=r.id AND p.partner_org_id=g.org_id AND p.invitation_status='accepted' AND p.participation_status='active' AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())))
 AND (g.recipient_org_id=r.org_id OR EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=r.id AND p.partner_org_id=g.recipient_org_id AND p.invitation_status='accepted' AND p.participation_status='active' AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))));
$$;
REVOKE ALL ON FUNCTION airs.framework_grant_valid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.framework_grant_valid(uuid) TO airs_app;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['entity_profiles','source_systems','partner_envelopes','incident_source_grants','operational_observations','supplemental_source_access'] LOOP
  EXECUTE format('ALTER TABLE airs.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE airs.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON airs.%I TO airs_app',t);
  EXECUTE format('CREATE POLICY own_read ON airs.%I FOR SELECT USING(org_id=airs.current_org_id())',t);
  EXECUTE format('CREATE POLICY own_insert ON airs.%I FOR INSERT WITH CHECK(org_id=airs.current_org_id())',t);
  EXECUTE format('CREATE POLICY own_update ON airs.%I FOR UPDATE USING(org_id=airs.current_org_id()) WITH CHECK(org_id=airs.current_org_id())',t);
 END LOOP;
END $$;
CREATE POLICY recipient_envelopes ON airs.partner_envelopes FOR SELECT USING(recipient_org_id=airs.current_org_id());
CREATE POLICY recipient_grants ON airs.incident_source_grants FOR SELECT USING(recipient_org_id=airs.current_org_id() AND airs.framework_incident_active(incident_id));
CREATE POLICY recipient_supplemental ON airs.supplemental_source_access FOR SELECT USING(recipient_org_id=airs.current_org_id() AND airs.framework_incident_active(incident_id));
ALTER TABLE airs.observation_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.observation_correlations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON airs.observation_correlations TO airs_app;
CREATE POLICY visible_correlation ON airs.observation_correlations FOR SELECT USING (
  EXISTS(SELECT 1 FROM airs.operational_observations o WHERE o.id=observation_id AND o.incident_id=observation_correlations.incident_id));
CREATE POLICY incident_owner_correlation_insert ON airs.observation_correlations FOR INSERT WITH CHECK (
  org_id=airs.current_org_id() AND EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=incident_id AND r.org_id=airs.current_org_id()));
CREATE POLICY incident_owner_correlation_update ON airs.observation_correlations FOR UPDATE USING (
  org_id=airs.current_org_id()) WITH CHECK(org_id=airs.current_org_id());
CREATE POLICY authorized_observations ON airs.operational_observations FOR SELECT USING (
 expires_at>now() AND airs.framework_incident_active(incident_id) AND (
  (source_id IS NULL) OR EXISTS(SELECT 1 FROM airs.incident_source_grants g
   WHERE g.id=grant_id AND g.recipient_org_id=airs.current_org_id()
   AND g.incident_id=operational_observations.incident_id AND airs.framework_grant_valid(g.id)
   AND observation->>'dataClass'=ANY(g.data_classes))
 ));

-- Closure is atomic with the room transition, including scheduled maintenance.
-- External revocation stays pending until an actual provider receipt is recorded.
CREATE FUNCTION airs.framework_closeout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
BEGIN
 IF NEW.status IN ('closed','archived') AND OLD.status NOT IN ('closed','archived') THEN
  UPDATE airs.incident_source_grants SET revoked_at=coalesce(revoked_at,now()) WHERE incident_id=NEW.id;
  UPDATE airs.supplemental_source_access SET revocation_status='pending'
   WHERE incident_id=NEW.id AND revocation_status<>'confirmed';
  UPDATE airs.operational_observations SET expires_at=least(expires_at,now()+make_interval(hours=>NEW.temp_data_retention_hours))
   WHERE incident_id=NEW.id AND evidence_policy IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION airs.framework_closeout() FROM PUBLIC;
CREATE TRIGGER framework_closeout AFTER UPDATE OF status ON airs.incident_rooms FOR EACH ROW EXECUTE FUNCTION airs.framework_closeout();

CREATE FUNCTION airs.expire_framework_state() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
DECLARE removed bigint;
BEGIN
 UPDATE airs.incident_source_grants SET revoked_at=now() WHERE revoked_at IS NULL AND expires_at<=now();
 UPDATE airs.supplemental_source_access SET revocation_status='pending' WHERE expires_at<=now() AND revocation_status='not_requested';
 DELETE FROM airs.operational_observations WHERE expires_at<=now() AND evidence_policy IS NULL;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION airs.expire_framework_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.expire_framework_state() TO airs_maintenance;

-- Extend the one shared scheduler entry point, including HTTP and pg_cron.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('airs.run_incident_expiration(uuid)'::regprocedure) INTO definition;
 IF position('SELECT * INTO sweep FROM airs.expire_incident_state();' IN definition)=0 THEN
  RAISE EXCEPTION 'maintenance entry point changed; review framework expiration integration';
 END IF;
 EXECUTE replace(definition,'SELECT * INTO sweep FROM airs.expire_incident_state();',
  'SELECT * INTO sweep FROM airs.expire_incident_state(); PERFORM airs.expire_framework_state();');
END $$;

-- Directory projection: account existence reveals no source configuration or data.
CREATE FUNCTION airs.framework_entity_directory() RETURNS TABLE(id uuid,name text,entity_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
 SELECT id,name,agency_type FROM airs.organizations WHERE airs.current_org_id() IS NOT NULL AND slug<>'airs-platform';
$$;
REVOKE ALL ON FUNCTION airs.framework_entity_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.framework_entity_directory() TO airs_app;

-- Automatic activation is restricted to preauthorized envelopes, qualified
-- incident types, and entities already accepted into the incident.
CREATE FUNCTION airs.activate_framework_partners(inc uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
BEGIN
 INSERT INTO airs.incident_source_grants(org_id,incident_id,recipient_org_id,source_id,relationship,envelope_id,data_classes,expires_at)
 SELECT e.org_id,r.id,e.recipient_org_id,e.source_id,'partner',e.id,
   ARRAY(SELECT jsonb_array_elements_text(e.policy->'dataClasses') INTERSECT SELECT jsonb_array_elements_text(s.profile->'dataClasses')),
   least(e.expires_at,coalesce(r.scheduled_expires_at,e.expires_at))
 FROM airs.partner_envelopes e JOIN airs.source_systems s ON s.id=e.source_id
 JOIN airs.incident_rooms r ON r.id=inc
 WHERE r.status='active' AND e.revoked_at IS NULL AND e.expires_at>now()
 AND (r.scheduled_expires_at IS NULL OR r.scheduled_expires_at>now())
 AND e.policy->>'activation'='automatic' AND e.policy->'incidentTypes' ? r.incident_type
 AND s.profile->>'ingestionAuthorization'='authorized'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.policy->'dataClasses') c WHERE s.profile->'dataClasses' ? c)
 AND (e.org_id=r.org_id OR EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=r.id AND p.partner_org_id=e.org_id AND p.invitation_status='accepted' AND p.participation_status='active' AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())))
 AND (e.recipient_org_id=r.org_id OR EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=r.id AND p.partner_org_id=e.recipient_org_id AND p.invitation_status='accepted' AND p.participation_status='active' AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())))
 AND NOT EXISTS(SELECT 1 FROM airs.incident_source_grants g WHERE g.incident_id=r.id AND g.envelope_id=e.id);
END $$;
REVOKE ALL ON FUNCTION airs.activate_framework_partners(uuid) FROM PUBLIC;
CREATE FUNCTION airs.framework_activation_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
BEGIN
 IF TG_TABLE_NAME='incident_rooms' THEN PERFORM airs.activate_framework_partners(NEW.id);
 ELSE PERFORM airs.activate_framework_partners(NEW.incident_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION airs.framework_activation_trigger() FROM PUBLIC;
CREATE TRIGGER framework_activate_room AFTER UPDATE OF status ON airs.incident_rooms FOR EACH ROW EXECUTE FUNCTION airs.framework_activation_trigger();
CREATE TRIGGER framework_activate_participant AFTER INSERT OR UPDATE OF participation_status ON airs.incident_participants FOR EACH ROW EXECUTE FUNCTION airs.framework_activation_trigger();
COMMIT;
