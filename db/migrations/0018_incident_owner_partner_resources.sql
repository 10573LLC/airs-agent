-- Incident owners are legitimate readers of explicitly shared partner resources.
-- Keep has_incident_access partner-only: changing it would widen unrelated policies.
BEGIN;
CREATE OR REPLACE FUNCTION airs.has_shared_resource(res uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = airs, pg_catalog AS $$
 SELECT EXISTS (
  SELECT 1 FROM airs.resource_shares s JOIN airs.incident_rooms r ON r.id=s.incident_id
  WHERE s.resource_id=res AND s.org_id<>airs.current_org_id()
   AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
   AND s.classification<>'originating_org_only'
   AND (s.classification<>'named_recipients' OR airs.current_org_id()=ANY(s.named_recipient_org_ids))
   AND r.status NOT IN ('closed','archived')
   AND (r.org_id=airs.current_org_id() OR airs.has_incident_access(s.incident_id))
 );
$$;
REVOKE ALL ON FUNCTION airs.has_shared_resource(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.has_shared_resource(uuid) TO airs_app;

-- Test each share's entitlement itself. A valid summary share must not make an
-- expired/revoked/unrelated full share eligible for field projection.
CREATE OR REPLACE FUNCTION airs.effective_disclosure(p_resource_id uuid)
RETURNS TABLE(profile text,custom_field_keys text[],named_recipient boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=airs,pg_catalog AS $$
 SELECT x.profile,x.custom_field_keys,x.named_recipient FROM (
  SELECT 0 AS rank,'full'::text AS profile,'{}'::text[] AS custom_field_keys,true AS named_recipient,NULL::timestamptz AS shared_at,NULL::uuid AS id
   FROM airs.resources r WHERE r.id=p_resource_id AND r.org_id=airs.current_org_id()
  UNION ALL
  SELECT 1,s.disclosure_profile,s.custom_field_keys,
   s.classification='named_recipients' AND airs.current_org_id()=ANY(s.named_recipient_org_ids),s.shared_at,s.id
   FROM airs.resource_shares s JOIN airs.incident_rooms r ON r.id=s.incident_id
   WHERE s.resource_id=p_resource_id AND s.org_id<>airs.current_org_id()
    AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
    AND s.classification<>'originating_org_only'
    AND (s.classification<>'named_recipients' OR airs.current_org_id()=ANY(s.named_recipient_org_ids))
    AND r.status NOT IN ('closed','archived')
    AND (r.org_id=airs.current_org_id() OR airs.has_incident_access(s.incident_id))
 ) x ORDER BY x.rank,x.shared_at DESC,x.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION airs.effective_disclosure(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.effective_disclosure(uuid) TO airs_app;

DROP POLICY IF EXISTS assignment_read ON airs.incident_assignments;
CREATE POLICY assignment_read ON airs.incident_assignments FOR SELECT USING (
 org_id=airs.current_org_id() OR airs.has_incident_access(incident_id)
 OR EXISTS(SELECT 1 FROM airs.incident_rooms r WHERE r.id=incident_id AND r.org_id=airs.current_org_id() AND r.status NOT IN ('closed','archived'))
);
COMMIT;
