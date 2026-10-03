-- Participants may read incidents but must never gain incident update rights.
-- A privileged, access-checked lock keeps acquisition atomic with closeout
-- without applying the owner-only UPDATE policy required by SELECT FOR SHARE.
CREATE FUNCTION airs.lock_framework_incident(inc uuid)
RETURNS TABLE(incident_type text, status text, temp_data_retention_hours integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,airs AS $$
 SELECT r.incident_type, r.status, r.temp_data_retention_hours
 FROM airs.incident_rooms r
 WHERE r.id=inc AND r.status='active'
   AND (r.scheduled_expires_at IS NULL OR r.scheduled_expires_at>now())
   AND (r.org_id=airs.current_org_id() OR airs.has_incident_access(inc))
 FOR SHARE OF r;
$$;
REVOKE ALL ON FUNCTION airs.lock_framework_incident(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.lock_framework_incident(uuid) TO airs_app;
