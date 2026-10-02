-- Real agency routing and responses, shared by humans and exercise agents.
ALTER TABLE airs.incident_resource_requests ADD COLUMN recipient_org_id uuid REFERENCES airs.organizations(id);
CREATE TABLE airs.incident_request_responses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES airs.incident_resource_requests(id) ON DELETE CASCADE,
 incident_id uuid NOT NULL REFERENCES airs.incident_rooms(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES airs.organizations(id),
 responder_account_id uuid NOT NULL REFERENCES airs.accounts(id),
 status text NOT NULL CHECK(status IN ('acknowledged','partially_filled','filled','denied')),
 message text NOT NULL CHECK(length(btrim(message)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_request_responses_request_idx ON airs.incident_request_responses(request_id,created_at);
-- Recipient-scoped lock avoids granting recipients UPDATE on owner requests.
CREATE FUNCTION airs.lock_agency_request(req uuid, inc uuid)
RETURNS TABLE(recipient uuid,status text) LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,airs AS $$
 SELECT r.recipient_org_id,r.status FROM airs.incident_resource_requests r
 WHERE r.id=req AND r.incident_id=inc AND r.recipient_org_id=airs.current_org_id()
 AND airs.has_incident_access(inc) FOR UPDATE OF r;
$$;
REVOKE ALL ON FUNCTION airs.lock_agency_request(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.lock_agency_request(uuid,uuid) TO airs_app;
ALTER TABLE airs.incident_request_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE airs.incident_request_responses FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON airs.incident_request_responses TO airs_app;
CREATE POLICY response_read ON airs.incident_request_responses FOR SELECT USING (
 EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=incident_id AND
 (r.org_id=airs.current_org_id() OR airs.has_incident_access(r.id)))
);
CREATE POLICY response_insert ON airs.incident_request_responses FOR INSERT WITH CHECK (
 org_id=airs.current_org_id() AND responder_account_id=airs.current_account_id()
 AND EXISTS(SELECT 1 FROM airs.incident_resource_requests r WHERE r.id=request_id
   AND r.incident_id=incident_request_responses.incident_id AND r.recipient_org_id=airs.current_org_id()
   AND r.status NOT IN ('cancelled','filled','denied'))
 AND EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=incident_id AND r.status='active'
   AND (r.scheduled_expires_at IS NULL OR r.scheduled_expires_at>now()))
 AND EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=incident_request_responses.incident_id
   AND p.partner_org_id=airs.current_org_id() AND p.invitation_status='accepted'
   AND p.participation_status='active' AND p.access_level IN ('operational','incident_command')
   AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))
);
