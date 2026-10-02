import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {loadMigrations,buildLedgerBootstrapScript,buildMigrationScript} from './lib/migrate-plan.mjs';
const name='airs-exercise-check-'+randomBytes(5).toString('hex');
const password=randomBytes(24).toString('hex');
const call=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw Error(r.stderr);return r.stdout;};
const sql=text=>call(['exec','-i',name,'psql','-h','127.0.0.1','-X','-v','ON_ERROR_STOP=1','-U','airs_owner','-d','airs','-At'],text);
try {
  call(['run','-d','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_USER=airs_owner','-e','POSTGRES_DB=airs','-e','POSTGRES_PASSWORD='+password,'postgis/postgis:16-3.5-alpine']);
  for(let i=0;i<40;i++){try{sql('SELECT 1');break;}catch{await new Promise(r=>setTimeout(r,500));}}
  sql(buildLedgerBootstrapScript());
  for(const m of loadMigrations())sql(buildMigrationScript(m));
  sql(readFileSync('db/tests/incident_owner_resources.sql','utf8').replace(/^\uFEFF/,''));
  console.log('PASS: owner/outsider/revoked-share/field-disclosure regression tests.');
  sql(`ALTER ROLE airs_app LOGIN PASSWORD '${password}';
    INSERT INTO airs.accounts(id,email,display_name) VALUES('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','admin@airsagent.com','Disposable observer');
    INSERT INTO airs.users(id,org_id,account_id,email_address,display_name) SELECT 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',id,'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','admin@airsagent.com','Disposable observer' FROM airs.organizations WHERE org_kind='platform';
    INSERT INTO airs.memberships(org_id,account_id,user_id,role_key,status) SELECT org_id,account_id,id,'platform_admin','active' FROM airs.users WHERE id='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';`);
  const port=JSON.parse(call(['inspect',name]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  for(let i=0;i<2;i++) {
    const r=spawnSync(process.execPath,['scripts/prepare-anconison-exercise.mjs'],{encoding:'utf8',env:{...process.env,DATABASE_URL:`postgresql://airs_owner@127.0.0.1:${port}/airs`,PGPASSWORD:password,APP_DB_PASSWORD:password,AIRS_EXERCISE_PREPARE:'anconison-simulated-only'},maxBuffer:2*1024*1024});
    if(r.status!==0)throw Error(r.stderr+r.stdout);
    console.log('Preparation pass '+(i+1)+' succeeded');
  }
  const counts=sql(`SELECT (SELECT count(*) FROM airs.organizations WHERE slug LIKE 'exercise-helene-%'),(SELECT count(*) FROM airs.incident_rooms WHERE name LIKE 'EXERCISE ONLY%'),(SELECT count(*) FROM airs.incident_rooms WHERE status<>'draft'),(SELECT count(*) FROM airs.sessions WHERE revoked_at IS NULL);`).trim();
  if(counts!=='7|1|0|0')throw Error('Unexpected fixture state: '+counts);
  const r=spawnSync(process.execPath,['scripts/run-anconison-exercise.mjs','--rehearsal'],{encoding:'utf8',env:{...process.env,DATABASE_URL:`postgresql://airs_owner@127.0.0.1:${port}/airs`,PGPASSWORD:password,APP_DB_PASSWORD:password,AIRS_EXERCISE_RUN:'anconison-simulated-only'},maxBuffer:4*1024*1024});
  console.log(r.stdout);
  if(r.status!==0)throw Error(r.stderr+'Runner failed');
  const final=sql(`SELECT (SELECT count(*) FROM airs.incident_rooms WHERE status='closed'),(SELECT count(*) FROM airs.sessions WHERE revoked_at IS NULL);`).trim();
  if(final!=='1|0')throw Error('Unexpected final state: '+final);
  console.log('PASS: full service/RLS rehearsal; incident closed; no active synthetic sessions.');
} finally {spawnSync('docker',['rm','-f',name],{stdio:'ignore'});}
