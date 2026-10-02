\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.check_framework(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS NOT TRUE THEN RAISE EXCEPTION 'framework check failed: %',label; END IF; RAISE NOTICE 'ok: %',label; END $$;
CREATE TEMP TABLE framework_ids(k text PRIMARY KEY,id uuid);
GRANT SELECT ON framework_ids TO airs_app;
DO $$ DECLARE a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); i uuid; s uuid; g uuid; e uuid;
BEGIN
 INSERT INTO airs.organizations(id,slug,name,agency_type) VALUES(a,'framework-a','Source entity','other'),(b,'framework-b','Recipient entity','other'),(c,'framework-c','Unrelated entity','other');
 INSERT INTO airs.incident_rooms(org_id,name,incident_type,status) VALUES(a,'Framework test','planned_event','draft') RETURNING id INTO i;
 INSERT INTO airs.incident_participants(incident_id,org_id,partner_org_id,invited_by_org_id,access_level,invitation_status,participation_status,requires_approval,invitation_expires_at)
 VALUES(i,a,b,a,'operational','accepted','active',false,now()+interval '1 day');
 INSERT INTO airs.source_systems(org_id,profile) VALUES(a,'{"vendor":"Dedrone","ingestionAuthorization":"authorized","dataClasses":["uas_track"]}') RETURNING id INTO s;
 INSERT INTO airs.partner_envelopes(org_id,recipient_org_id,source_id,policy,expires_at)
 VALUES(a,b,s,'{"activation":"automatic","incidentTypes":["planned_event"],"dataClasses":["uas_track"]}',now()+interval '1 day') RETURNING id INTO e;
 UPDATE airs.incident_rooms SET status='active' WHERE id=i;
 SELECT id INTO g FROM airs.incident_source_grants WHERE incident_id=i AND envelope_id=e;
 PERFORM pg_temp.check_framework(g IS NOT NULL,'qualifying automatic Partner envelope activates');
 INSERT INTO airs.operational_observations(org_id,incident_id,source_id,grant_id,observation,expires_at)
 VALUES(a,i,s,g,'{"dataClass":"uas_track","label":"UAS"}',now()+interval '1 day');
 INSERT INTO airs.supplemental_source_access(org_id,incident_id,source_id,recipient_org_id,profile,expires_at)
 VALUES(a,i,s,b,'{"accessProfile":"Observation Only"}',now()+interval '1 day');
 INSERT INTO framework_ids VALUES('a',a),('b',b),('c',c),('i',i),('s',s),('g',g),('e',e);
END $$;
SET LOCAL ROLE airs_app;
SELECT set_config('airs.org_id',(SELECT id::text FROM framework_ids WHERE k='b'),true);
SELECT pg_temp.check_framework((SELECT count(*)=0 FROM airs.source_systems),'recipient cannot browse source profile');
SELECT pg_temp.check_framework((SELECT count(*)=1 FROM airs.operational_observations),'recipient sees authorized normalized representation');
SELECT set_config('airs.org_id',(SELECT id::text FROM framework_ids WHERE k='c'),true);
SELECT pg_temp.check_framework((SELECT count(*)=0 FROM airs.operational_observations),'unrelated entity sees no observations');
SELECT set_config('airs.org_id',(SELECT id::text FROM framework_ids WHERE k='a'),true);
UPDATE airs.partner_envelopes SET revoked_at=now() WHERE id=(SELECT id FROM framework_ids WHERE k='e');
SELECT set_config('airs.org_id',(SELECT id::text FROM framework_ids WHERE k='b'),true);
SELECT pg_temp.check_framework((SELECT count(*)=0 FROM airs.operational_observations),'envelope revocation removes derived representation');
RESET ROLE;
UPDATE airs.incident_rooms SET status='closed' WHERE id=(SELECT id FROM framework_ids WHERE k='i');
SELECT pg_temp.check_framework((SELECT bool_and(revoked_at IS NOT NULL) FROM airs.incident_source_grants WHERE incident_id=(SELECT id FROM framework_ids WHERE k='i')),'closeout ends activated sharing');
SELECT pg_temp.check_framework((SELECT bool_and(revocation_status='pending') FROM airs.supplemental_source_access WHERE incident_id=(SELECT id FROM framework_ids WHERE k='i')),'external revocation pending until receipt');
UPDATE airs.operational_observations SET expires_at=now()-interval '1 second';
SELECT airs.expire_framework_state();
SELECT pg_temp.check_framework((SELECT count(*)=0 FROM airs.operational_observations),'expired cache purged');
SELECT pg_temp.check_framework((SELECT count(*)=1 FROM airs.source_systems),'source configuration retained');
ROLLBACK;
