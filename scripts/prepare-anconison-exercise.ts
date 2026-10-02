// Operator-only fixtures. Does not start the scenario or send invitations.
// Fictional actors use short-lived simulated sessions; the observer uses real Cognito.
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { createIncident, readIncident } from '../src/lib/incidents/incidents.server';
import { getDatabase } from '../src/lib/adapters/index.server';

const names = ['Anconison Agency', 'Blue Ridge Rescue', 'Mountain Air Support', 'Piedmont UAS', 'Foothills Logistics', 'Valley Medical', 'Ridge Communications'];
const key = 'anconison-helene-2024';
const id = (label:string) => { const h=createHash('sha256').update(key+':'+label).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const owner = new pg.Client({connectionString:process.env.DATABASE_URL});
const sessionHashes:string[]=[];
const roomName='EXERCISE ONLY — Anconison Helene coordination gauntlet';
async function membership(orgId:string, accountId:string, email:string, name:string, role:string) {
  const userId=id('user:'+orgId+':'+email);
  await owner.query(`INSERT INTO airs.users(id,org_id,account_id,email_address,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[userId,orgId,accountId,email,name]);
  const existing=await owner.query('SELECT id FROM airs.users WHERE org_id=$1 AND account_id=$2',[orgId,accountId]);
  if(existing.rows.length!==1) throw Error('Fixture user conflict');
  const user=existing.rows[0].id;
  await owner.query(`INSERT INTO airs.memberships(org_id,account_id,user_id,role_key,status,activated_at) VALUES($1,$2,$3,$4,'active',now()) ON CONFLICT DO NOTHING`,[orgId,accountId,user,role]);
  const check=await owner.query('SELECT role_key,status FROM airs.memberships WHERE org_id=$1 AND account_id=$2',[orgId,accountId]);
  if(check.rows[0]?.role_key!==role||check.rows[0]?.status!=='active') throw Error('Existing fixture membership differs; manual review required');
  await owner.query('INSERT INTO airs.user_roles(org_id,user_id,role_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[orgId,user,role]);
}
async function main() {
  if(process.env.AIRS_EXERCISE_PREPARE!=='anconison-simulated-only') throw Error('Explicit exercise prepare flag required');
  if(!process.env.APP_DB_PASSWORD) throw Error('Application database credential missing');
  await owner.connect();
  await owner.query('BEGIN');
  await owner.query("SELECT pg_advisory_xact_lock(hashtext('airs-anconison-exercise-prepare'))");
  const observer=(await owner.query("SELECT a.id FROM airs.accounts a WHERE lower(a.email)='admin@airsagent.com' AND a.status='active' AND EXISTS(SELECT 1 FROM airs.memberships m JOIN airs.organizations o ON o.id=m.org_id WHERE m.account_id=a.id AND m.status='active' AND o.org_kind='platform')")).rows[0];
  if(!observer) throw Error('Verified platform administrator is required');
  for(const [i,name] of names.entries()) {
    const orgId=id('org:'+i), slug=`exercise-helene-${i}`;
    await owner.query('INSERT INTO airs.organizations(id,slug,name,agency_type) VALUES($1,$2,$3,\'other\') ON CONFLICT DO NOTHING',[orgId,slug,name+' — Exercise']);
    const check=(await owner.query('SELECT id,name FROM airs.organizations WHERE slug=$1',[slug])).rows[0];
    if(check?.id!==orgId||check?.name!==name+' — Exercise') throw Error('Exercise organization collision');
    await owner.query('INSERT INTO airs.retention_policies(org_id) VALUES($1) ON CONFLICT DO NOTHING',[orgId]);
    const email=`helene-${i}@simulation.invalid`, accountId=id('account:'+i);
    await owner.query('INSERT INTO airs.accounts(id,email,display_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[accountId,email,name+' simulated controller']);
    await membership(orgId,accountId,email,name+' simulated controller','incident_commander');
  }
  // Explicit exercise membership, separate from platform administration; no real agency touched.
  await membership(id('org:0'),observer.id,'admin@airsagent.com','Anconison exercise observer','incident_commander');
  await owner.query(`INSERT INTO airs.audit_events(org_id,action,resource_type,outcome,detail) VALUES($1,'exercise.fixtures_prepared','exercise','allow',$2::jsonb)`,[id('org:0'),JSON.stringify({exercise:key,simulatedAgencies:7,externalDelivery:false,observerRole:'incident_commander',started:false})]);
  await owner.query('COMMIT');
  const token=randomBytes(32).toString('base64url'), hash=createHash('sha256').update(token).digest('hex');
  sessionHashes.push(hash);
  await owner.query("INSERT INTO airs.sessions(account_id,token_hash,active_org_id,expires_at,user_agent) VALUES($1,$2,$3,now()+interval '15 minutes','AIRS exercise fixture controller: simulated authentication')",[id('account:0'),hash,id('org:0')]);
  const appUrl=new URL(process.env.DATABASE_URL!); appUrl.username='airs_app';
  process.env.DATABASE_URL=appUrl.toString(); process.env.PGPASSWORD=process.env.APP_DB_PASSWORD;
  // This setting is process-local for synthetic actors only. Production web auth remains OIDC+MFA.
  process.env.AUTH_DRIVER='local';
  const role=await getDatabase().withContext({},q=>q.query<{current_user:string,rolbypassrls:boolean,rolsuper:boolean}>('SELECT current_user,rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user'));
  if(role[0].current_user!=='airs_app'||role[0].rolbypassrls||role[0].rolsuper) throw Error('Exercise must use restricted application role');
  const existing=(await owner.query('SELECT id FROM airs.incident_rooms WHERE org_id=$1 AND name=$2',[id('org:0'),roomName])).rows;
  if(existing.length>1) throw Error('Duplicate exercise incident');
  const meta={userAgent:'AIRS EXERCISE preparation — simulated controller, no external delivery'};
  const room=existing.length ? (await readIncident(token,id('org:0'),existing[0].id,meta)).incident : await createIncident(token,id('org:0'),{
    name:roomName,incidentType:'training',classification:'restricted',defaultShareRule:'no_sharing',
    description:'EXERCISE ONLY. Historical context: Hurricane Helene, western North Carolina, September–October 2024. All participating agencies and activity are simulated. No real emergency response. Prepared and waiting for observer; scenario has not started.',
    geographicDescription:'Western North Carolina — historical Helene exercise context',tempDataRetentionHours:24,
  },meta);
  if(room.status!=='draft') throw Error('Exercise already progressed; refusing to restart');
  console.log('AIRS_EXERCISE_PREPARED:'+JSON.stringify({incidentId:room.id,observerOrgId:id('org:0'),agencies:names.map((name,i)=>({id:id('org:'+i),name:name+' — Exercise'})),status:room.status,started:false,observerUrl:`https://app.airsagent.com/incidents/${room.id}/command`}));
}
try {await main();} catch(e) {await owner.query('ROLLBACK').catch(()=>{}); console.error('Exercise preparation failed:',e instanceof Error?e.message:'unknown');process.exitCode=1;}
finally {for(const hash of sessionHashes) await owner.query('UPDATE airs.sessions SET revoked_at=now() WHERE token_hash=$1',[hash]).catch(()=>{});await getDatabase().close().catch(()=>{});await owner.end().catch(()=>{});}
