BEGIN;
-- Existing invitation eligibility remains Associate. Friendship is reciprocal.
ALTER TABLE airs.trusted_agencies
  ADD COLUMN relationship_level text NOT NULL DEFAULT 'associate' CHECK (relationship_level IN ('associate','friend')),
  ADD COLUMN share_profile boolean NOT NULL DEFAULT false,
  ADD COLUMN friend_profile jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(friend_profile)='object'),
  ADD COLUMN profile_confirmed_at timestamptz,
  ADD COLUMN profile_valid_until timestamptz;
-- Private drafts and unshared declarations must not be readable from the reverse relationship.
DROP POLICY trusted_read ON airs.trusted_agencies;
CREATE POLICY trusted_read ON airs.trusted_agencies FOR SELECT USING (org_id=airs.current_org_id());

-- A narrow projection: no private relationship notes, user IDs, secrets or live feeds.
-- The caller cannot choose a viewing organization. Both agencies must currently agree.
CREATE FUNCTION airs.friend_briefings()
RETURNS TABLE ("partnerOrgId" uuid, "partnerOrgName" text, "mutualFriend" boolean,
  "profileState" text, profile jsonb, "confirmedAt" text, "validUntil" text,
  ecosystems jsonb, components jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, airs AS $$
  SELECT incoming.org_id, o.name,
    incoming.status='approved' AND incoming.relationship_level='friend'
      AND outgoing.status='approved' AND outgoing.relationship_level='friend',
    CASE WHEN incoming.status<>'approved' OR incoming.relationship_level<>'friend'
           OR outgoing.status<>'approved' OR outgoing.relationship_level<>'friend' THEN 'associate'
         WHEN NOT incoming.share_profile THEN 'not_shared'
         WHEN incoming.profile_valid_until IS NULL OR incoming.profile_valid_until<=now() THEN 'expired'
         ELSE 'shared' END,
    CASE WHEN incoming.status='approved' AND incoming.relationship_level='friend'
      AND outgoing.status='approved' AND outgoing.relationship_level='friend'
      AND incoming.share_profile AND incoming.profile_valid_until>now() THEN incoming.friend_profile ELSE '{}'::jsonb END,
    CASE WHEN incoming.share_profile AND incoming.relationship_level='friend' AND incoming.status='approved'
      AND outgoing.relationship_level='friend' AND outgoing.status='approved' THEN to_json(incoming.profile_confirmed_at)#>>'{}' END,
    CASE WHEN incoming.share_profile AND incoming.relationship_level='friend' AND incoming.status='approved'
      AND outgoing.relationship_level='friend' AND outgoing.status='approved' THEN to_json(incoming.profile_valid_until)#>>'{}' END,
    CASE WHEN incoming.status='approved' AND incoming.relationship_level='friend'
      AND outgoing.status='approved' AND outgoing.relationship_level='friend'
      AND incoming.share_profile AND incoming.profile_valid_until>now()
      THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('ecosystemId',e.ecosystem_id,'usageStatus',e.usage_status))
        FROM airs.agency_system_ecosystems e WHERE e.org_id=incoming.org_id),'[]'::jsonb) ELSE '[]'::jsonb END,
    CASE WHEN incoming.status='approved' AND incoming.relationship_level='friend'
      AND outgoing.status='approved' AND outgoing.relationship_level='friend'
      AND incoming.share_profile AND incoming.profile_valid_until>now()
      THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('componentId',c.component_id,'usageStatus',c.usage_status))
        FROM airs.agency_system_components c WHERE c.org_id=incoming.org_id),'[]'::jsonb) ELSE '[]'::jsonb END
  FROM airs.trusted_agencies incoming
  JOIN airs.trusted_agencies outgoing ON outgoing.org_id=incoming.partner_org_id AND outgoing.partner_org_id=incoming.org_id
  JOIN airs.organizations o ON o.id=incoming.org_id
  WHERE outgoing.org_id=airs.current_org_id();
$$;
REVOKE ALL ON FUNCTION airs.friend_briefings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION airs.friend_briefings() TO airs_app;
COMMIT;
