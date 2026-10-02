\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE owner_share_ids(k text PRIMARY KEY,v uuid);
GRANT SELECT ON owner_share_ids TO airs_app;
DO $$
DECLARE a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();c uuid:=gen_random_uuid();room uuid;other_room uuid;res uuid;unshared uuid;s uuid;
BEGIN
 INSERT INTO airs.organizations(id,slug,name,agency_type) VALUES(a,'test-owner-share-a','Incident owner','other'),(b,'test-owner-share-b','Resource owner','other'),(c,'test-owner-share-c','Outsider','other');
 INSERT INTO airs.incident_rooms(org_id,name,incident_type,status) VALUES(a,'Test shared room','training','active') RETURNING id INTO room;
 INSERT INTO airs.incident_rooms(org_id,name,incident_type,status) VALUES(a,'Test stale share room','training','active') RETURNING id INTO other_room;
 INSERT INTO airs.resources(org_id,category,display_name) VALUES(b,'aircraft','Shared test aircraft') RETURNING id INTO res;
 INSERT INTO airs.resources(org_id,category,display_name) VALUES(b,'aircraft','Private test aircraft') RETURNING id INTO unshared;
 INSERT INTO airs.resource_shares(resource_id,org_id,incident_id,classification,disclosure_profile) VALUES(res,b,room,'participating_orgs','summary') RETURNING id INTO s;
 INSERT INTO airs.resource_shares(resource_id,org_id,incident_id,classification,disclosure_profile,named_recipient_org_ids,revoked_at,shared_at) VALUES(res,b,other_room,'named_recipients','full',ARRAY[a],now(),now()+interval '1 minute');
 INSERT INTO airs.incident_assignments(incident_id,org_id,assignment_type,resource_id,status) VALUES(room,b,'resource',res,'active');
 INSERT INTO owner_share_ids VALUES('a',a),('b',b),('c',c),('room',room),('other',other_room),('res',res),('private',unshared),('share',s);
END $$;
SET ROLE airs_app;
DO $$
DECLARE a uuid:=(SELECT v FROM owner_share_ids WHERE k='a');c uuid:=(SELECT v FROM owner_share_ids WHERE k='c');res uuid:=(SELECT v FROM owner_share_ids WHERE k='res');r uuid:=(SELECT v FROM owner_share_ids WHERE k='room');prof text;
BEGIN
 PERFORM set_config('airs.org_id',a::text,true);
 IF NOT EXISTS(SELECT 1 FROM airs.resources WHERE id=res) THEN RAISE EXCEPTION 'incident owner cannot see explicitly shared resource'; END IF;
 IF EXISTS(SELECT 1 FROM airs.resources WHERE id=(SELECT v FROM owner_share_ids WHERE k='private')) THEN RAISE EXCEPTION 'unshared resource leaked'; END IF;
 IF NOT EXISTS(SELECT 1 FROM airs.incident_assignments WHERE incident_id=r) THEN RAISE EXCEPTION 'owner assignment missing'; END IF;
 SELECT profile INTO prof FROM airs.effective_disclosure(res);
 IF prof<>'summary' THEN RAISE EXCEPTION 'revoked full profile was selected'; END IF;
 PERFORM set_config('airs.org_id',c::text,true);
 IF EXISTS(SELECT 1 FROM airs.resources WHERE id=res) OR EXISTS(SELECT 1 FROM airs.incident_assignments WHERE incident_id=r) THEN RAISE EXCEPTION 'outsider access leak'; END IF;
END $$;
RESET ROLE;
-- A live but wrongly addressed full share also cannot broaden the summary.
DO $$ DECLARE r uuid; BEGIN
 INSERT INTO airs.incident_rooms(org_id,name,incident_type,status) VALUES((SELECT v FROM owner_share_ids WHERE k='a'),'Wrong-recipient full share room','training','active') RETURNING id INTO r;
 INSERT INTO airs.resource_shares(resource_id,org_id,incident_id,classification,disclosure_profile,named_recipient_org_ids,shared_at) VALUES((SELECT v FROM owner_share_ids WHERE k='res'),(SELECT v FROM owner_share_ids WHERE k='b'),r,'named_recipients','full',ARRAY[(SELECT v FROM owner_share_ids WHERE k='c')],now()+interval '2 minutes');
END $$;
SET ROLE airs_app;
DO $$ BEGIN
 PERFORM set_config('airs.org_id',(SELECT v::text FROM owner_share_ids WHERE k='a'),true);
 IF (SELECT profile FROM airs.effective_disclosure((SELECT v FROM owner_share_ids WHERE k='res')))<>'summary' THEN RAISE EXCEPTION 'wrong recipient profile leak'; END IF;
END $$;
RESET ROLE;
UPDATE airs.resource_shares SET revoked_at=now() WHERE id=(SELECT v FROM owner_share_ids WHERE k='share');
SET ROLE airs_app;
DO $$ BEGIN
 PERFORM set_config('airs.org_id',(SELECT v::text FROM owner_share_ids WHERE k='a'),true);
 IF EXISTS(SELECT 1 FROM airs.resources WHERE id=(SELECT v FROM owner_share_ids WHERE k='res')) THEN RAISE EXCEPTION 'revoked owner share still visible'; END IF;
 IF EXISTS(SELECT 1 FROM airs.effective_disclosure((SELECT v FROM owner_share_ids WHERE k='res'))) THEN RAISE EXCEPTION 'profile survived revocation'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
