\set ON_ERROR_STOP on
BEGIN;
INSERT INTO airs.organizations(id,slug,name,agency_type) VALUES
('19191919-1111-4111-8111-111111111111','friend-test-a','Agency A','other'),
('19191919-2222-4222-8222-222222222222','friend-test-b','Agency B','other'),
('19191919-3333-4333-8333-333333333333','friend-test-c','Outsider','other');
INSERT INTO airs.trusted_agencies(org_id,partner_org_id,status,relationship_level,share_profile,friend_profile,profile_valid_until) VALUES
('19191919-1111-4111-8111-111111111111','19191919-2222-4222-8222-222222222222','approved','associate',false,'{}',null),
('19191919-2222-4222-8222-222222222222','19191919-1111-4111-8111-111111111111','approved','friend',true,'{"equipment":"TEST RADIO"}',now()+interval '1 day');
SET LOCAL ROLE airs_app;
SELECT set_config('airs.org_id','19191919-1111-4111-8111-111111111111',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM airs.friend_briefings() WHERE profile<>'{}'::jsonb OR "mutualFriend") THEN RAISE EXCEPTION 'associate acquired friend profile'; END IF;
END $$;
UPDATE airs.trusted_agencies SET relationship_level='friend' WHERE org_id=airs.current_org_id();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM airs.friend_briefings() WHERE profile->>'equipment'='TEST RADIO' AND "mutualFriend") THEN RAISE EXCEPTION 'reciprocal friend missing'; END IF;
 IF EXISTS(SELECT 1 FROM airs.trusted_agencies WHERE org_id<>airs.current_org_id()) THEN RAISE EXCEPTION 'private relationship row leaked'; END IF;
END $$;
SELECT set_config('airs.org_id','19191919-3333-4333-8333-333333333333',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM airs.friend_briefings()) THEN RAISE EXCEPTION 'outsider leak'; END IF; END $$;
SELECT set_config('airs.org_id','19191919-2222-4222-8222-222222222222',true);
UPDATE airs.trusted_agencies SET profile_valid_until=now()-interval '1 minute' WHERE org_id=airs.current_org_id();
SELECT set_config('airs.org_id','19191919-1111-4111-8111-111111111111',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM airs.friend_briefings() WHERE profile<>'{}'::jsonb OR "profileState"<>'expired') THEN RAISE EXCEPTION 'expired profile leak'; END IF; END $$;
SELECT set_config('airs.org_id','19191919-2222-4222-8222-222222222222',true);
UPDATE airs.trusted_agencies SET profile_valid_until=now()+interval '1 day',share_profile=false WHERE org_id=airs.current_org_id();
SELECT set_config('airs.org_id','19191919-1111-4111-8111-111111111111',true);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM airs.friend_briefings() WHERE profile<>'{}'::jsonb) THEN RAISE EXCEPTION 'unshared profile leak'; END IF; END $$;
UPDATE airs.trusted_agencies SET status='revoked' WHERE org_id=airs.current_org_id();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM airs.friend_briefings() WHERE "mutualFriend" OR profile<>'{}'::jsonb) THEN RAISE EXCEPTION 'revoked friend leak'; END IF; END $$;
RESET ROLE;
ROLLBACK;
