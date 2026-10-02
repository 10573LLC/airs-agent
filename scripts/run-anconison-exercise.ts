// Operator-run exercise. Only fixture setup uses the owner connection; all scenario
// actions use the real services under airs_app + forced RLS. No delivery integration.
import pg from 'pg';
import {createHash,randomBytes} from 'node:crypto';
import * as incidents from '../src/lib/incidents/incidents.server';
import * as participation from '../src/lib/incidents/participation.server';
import * as ics from '../src/lib/incidents/ics.server';
import * as resources from '../src/lib/resources/resources.server';
import * as assignments from '../src/lib/resources/assignments.server';
import * as maps from '../src/lib/map/map.server';
import {getDatabase} from '../src/lib/adapters/index.server';
import {isAccessError} from '../src/lib/auth/errors';
const key='anconison-helene-2024';
const id=(s:string)=>{const h=createHash('sha256').update(key+':'+s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const orgs=Array.from({length:7},(_,i)=>id('org:'+i));
const rehearsal=process.argv.includes('--rehearsal');
const ownerUrl=process.env.DATABASE_URL!;
if(process.env.AIRS_EXERCISE_RUN!=='anconison-simulated-only')throw Error('Explicit exercise run flag required');
if(rehearsal&&!['127.0.0.1','localhost'].includes(new URL(ownerUrl).hostname))throw Error('Fast rehearsal requires disposable localhost database');
const owner=new pg.Client({connectionString:ownerUrl});
const tokens:string[]=[], hashes:string[]=[], participantIds:string[]=[];
const resourceIds=[1,2,3,6].map(i=>({i,id:id('resource:'+i)}));
const meta={userAgent:'AIRS EXERCISE gauntlet: simulated participants; NO external delivery'};
const started=Date.now(), results:{check:string;outcome:string;detail?:unknown}[]=[];
let incidentId='',activated=false, completed=false, stage='preflight';
const emit=(event:string,detail:unknown={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),stage,detail}));
function check(label:string,condition:boolean,detail?:unknown){if(!condition)throw Error('CHECK FAILED: '+label);results.push({check:label,outcome:'passed',detail});emit('check.passed',{label,detail});}
async function denied(label:string,fn:()=>Promise<unknown>,codes=['incident_not_found','participation_inactive','forbidden','tenant_mismatch','resource_not_found']){let code='';try{await fn();}catch(e){if(!isAccessError(e))throw e;code=e.code;}check(label,codes.includes(code),{code});}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function room(){return (await incidents.readIncident(tokens[0],orgs[0],incidentId,meta)).incident;}
async function gate(){
  if(Date.now()-started>30*60*1000)throw Error('Maximum exercise duration reached');
  let current=await room();
  while(current.status==='paused') {emit('exercise.paused');await sleep(rehearsal?20:3000);if(Date.now()-started>30*60*1000)throw Error('Pause exceeded maximum duration');current=await room();}
  if(current.status!=='active')throw Error('OPERATOR_STOP: incident is '+current.status);
}
async function step(label:string,fn:()=>Promise<void>){stage=label;await gate();emit('step.started');await fn();emit('step.completed');for(let n=0;n<(rehearsal?1:10);n++){await sleep(rehearsal?20:2000);await gate();}}
async function setup(){
 await owner.connect();
 const lock=await owner.query("SELECT pg_try_advisory_lock(hashtext('airs-anconison-exercise-run')) AS locked");
 if(!lock.rows[0].locked)throw Error('Another exercise runner is active');
 const rows=(await owner.query("SELECT id,status FROM airs.incident_rooms WHERE org_id=$1 AND name='EXERCISE ONLY — Anconison Helene coordination gauntlet'",[orgs[0]])).rows;
 if(rows.length!==1||rows[0].status!=='draft')throw Error('Exactly one unstarted exercise draft is required; refusing restart');
 incidentId=rows[0].id;
 const fixture=await owner.query("SELECT count(*)::int AS n FROM airs.organizations WHERE id=ANY($1::uuid[]) AND slug LIKE 'exercise-helene-%'",[orgs]);
 if(fixture.rows[0].n!==7)throw Error('Exercise organization validation failed');
 await owner.query('BEGIN');
 // Pre-existing synthetic actors only; no real account privileges are changed.
 for(let i=0;i<7;i++){
  const account=(await owner.query('SELECT email FROM airs.accounts WHERE id=$1',[id('account:'+i)])).rows[0];
  if(account?.email!==`helene-${i}@simulation.invalid`)throw Error('Synthetic account mismatch');
  const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');tokens[i]=token;hashes.push(hash);
  await owner.query("INSERT INTO airs.sessions(account_id,token_hash,active_org_id,expires_at,user_agent) VALUES($1,$2,$3,now()+interval '40 minutes',$4)",[id('account:'+i),hash,orgs[i],meta.userAgent]);
  if(i)await owner.query("INSERT INTO airs.trusted_agencies(org_id,partner_org_id,status,note,approved_at) VALUES($1,$2,'approved','EXERCISE fixture eligibility only; no incident access granted',now()) ON CONFLICT(org_id,partner_org_id) DO NOTHING",[orgs[0],orgs[i]]);
 }
 for(const r of resourceIds)await owner.query("INSERT INTO airs.resources(id,org_id,category,display_name,description,readiness_status,operational_status,sharing_classification,restricted_notes) VALUES($1,$2,$3,$4,'Fictional resource for isolated Helene exercise','available','unknown','originating_org_only',$5) ON CONFLICT(id) DO NOTHING",[r.id,orgs[r.i],r.i===2||r.i===3?'aircraft':'ground_vehicle',`EXERCISE ${['','Rescue vehicle','Crewed aircraft','UAS','','','Communications vehicle'][r.i]}`,'EXERCISE_OWNER_ONLY_CANARY_'+r.i]);
 await owner.query('COMMIT');
 const appUrl=new URL(ownerUrl);appUrl.username='airs_app';process.env.DATABASE_URL=appUrl.toString();process.env.PGPASSWORD=process.env.APP_DB_PASSWORD;process.env.AUTH_DRIVER='local';
 const roles=await getDatabase().withContext({},q=>q.query<{current_user:string;rolsuper:boolean;rolbypassrls:boolean}>('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'));
 check('Restricted application role',roles[0].current_user==='airs_app'&&!roles[0].rolsuper&&!roles[0].rolbypassrls);
 emit('fixtures.ready',{incidentId,agencies:7,syntheticSessions:7,externalDelivery:false,operatorFixtures:'trusted eligibility and four fictional resource records'});
}
async function main(){
 await setup();
 for(let i=1;i<7;i++)await denied('Uninvited agency '+i+' cannot read',()=>incidents.readIncident(tokens[i],orgs[i],incidentId,meta));
 await ics.saveIcsProfile(tokens[0],orgs[0],incidentId,{commandMode:'single',incidentCommander:'Anconison exercise command',commandPostName:'EXERCISE coordination post',situationSummary:'Historical Helene context, western NC. All agency responses, positions and resources are fictional. Paced exercise running.',safetyMessage:'EXERCISE ONLY. No dispatch, external invitations, real flight authorization or live emergency activity.',operationalCondition:'elevated'},meta);
 const original=await room();await incidents.activateIncident(tokens[0],orgs[0],incidentId,original.version,meta);activated=true;emit('exercise.started',{incidentId});
 await step('Anconison opens command and exercise map',async()=>{
  await denied('Stale incident version rejected',()=>incidents.updateIncident(tokens[0],orgs[0],incidentId,{expectedVersion:original.version,description:'Stale update must not persist'},meta),['incident_stale_version']);
  await ics.addIcsObjective(tokens[0],orgs[0],incidentId,{objective:'EXERCISE: coordinate fictional rescue, aviation, UAS and communications resources while verifying agency data boundaries.'},meta);
  const area=await maps.createOperatingArea(tokens[0],orgs[0],{incidentId,name:'EXERCISE ONLY — fictional western NC sector',purpose:'Illustrative test geometry only; not an actual operation or airspace authorization',area:{type:'Polygon',coordinates:[[[-82.65,35.50],[-82.45,35.50],[-82.45,35.68],[-82.65,35.68],[-82.65,35.50]]]},classification:'participating_orgs',precisionPolicy:'generalized'},meta);
  await maps.setOperatingAreaStatus(tokens[0],orgs[0],area.id,'active',area.version,meta);
 });
 await step('Invite six fictional agencies through AIRS',async()=>{
  for(let i=1;i<7;i++){
   const invite=await participation.invitePartner(tokens[0],orgs[0],incidentId,{partnerOrgId:orgs[i],accessLevel:i===3?'view_only':'operational',requiresApproval:i===1,invitationExpiresAt:new Date(Date.now()+(i===5?(rehearsal?1000:90000):20*60*1000)).toISOString(),reason:'EXERCISE ONLY: simulated internal inbox; no email or external delivery'},meta);
   participantIds[i]=invite.participant.id;
   const inbox=await participation.listPendingInvitations(tokens[i],orgs[i],meta);
   check('Agency '+i+' sees its invitation',inbox.some(p=>p.participantId===participantIds[i]));
   await denied('Invited agency '+i+' cannot read protected room',()=>incidents.readIncident(tokens[i],orgs[i],incidentId,meta));
  }
 });
 await step('Blue Ridge accepts; approval is still required',async()=>{
  const p=await participation.partnerParticipationAction(tokens[1],orgs[1],participantIds[1],'accept',meta);check('Acceptance waits for approval',p.participationStatus==='pending_approval');
  await denied('Pending approval cannot read',()=>incidents.readIncident(tokens[1],orgs[1],incidentId,meta));
  await denied('Duplicate acceptance rejected',()=>participation.partnerParticipationAction(tokens[1],orgs[1],participantIds[1],'accept',meta),['participation_inactive']);
 });
 await step('Command approves rescue; logistics declines',async()=>{
  await participation.ownerParticipantAction(tokens[0],orgs[0],incidentId,participantIds[1],'approve_partner',meta);
  check('Approved rescue can read',(await incidents.readIncident(tokens[1],orgs[1],incidentId,meta)).incident.id===incidentId);
  await participation.partnerParticipationAction(tokens[4],orgs[4],participantIds[4],'decline',meta);
  await denied('Declined logistics cannot read',()=>incidents.readIncident(tokens[4],orgs[4],incidentId,meta));
  const req=await ics.addIncidentResourceRequest(tokens[0],orgs[0],incidentId,{requestedFrom:'Foothills Logistics — Exercise',resourceKind:'logistics',description:'EXERCISE: transport support; simulated agency reports unavailable',priority:'routine'},meta);
  await ics.setIncidentResourceRequestStatus(tokens[0],orgs[0],incidentId,{requestId:req.id,status:'denied'},meta);
 });
 await step('UAS joins with view-only incident access',async()=>{
  await participation.partnerParticipationAction(tokens[3],orgs[3],participantIds[3],'accept',meta);
  await participation.ownerParticipantAction(tokens[0],orgs[0],incidentId,participantIds[3],'restrict_partner',meta,'EXERCISE view-only scope');
  await denied('View-only partner cannot edit command',()=>ics.saveIcsProfile(tokens[3],orgs[3],incidentId,{commandMode:'single',incidentCommander:'Unauthorized overwrite'},meta));
 });
 await step('Delayed aviation and communications respond',async()=>{for(const i of [2,6])await participation.partnerParticipationAction(tokens[i],orgs[i],participantIds[i],'accept',meta);});
 const assigned:{i:number;id:string}[]=[], requestIds:string[]=[];
 for(const i of [1,2,6])await step('Deploy simulated '+({1:'rescue',2:'aviation',6:'communications'}[i]),async()=>{
  const resourceId=id('resource:'+i);
  const req=await ics.addIncidentResourceRequest(tokens[0],orgs[0],incidentId,{requestedFrom:['','Blue Ridge Rescue — Exercise','Mountain Air Support — Exercise','','','','Ridge Communications — Exercise'][i],requestedBy:'Anconison exercise command',resourceKind:i===2?'aviation':i===6?'communications':'specialty_team',description:'EXERCISE: fictional coordination support',priority:i===2?'high':'routine'},meta);requestIds.push(req.id);
  await resources.shareResource(tokens[i],orgs[i],{resourceId,incidentId,classification:'participating_orgs',disclosureProfile:'summary'},meta);
  const a=await assignments.assignToIncident(tokens[i],orgs[i],{incidentId,assignmentType:'resource',resourceId,assignedRole:'other',disclosureProfile:'summary'},meta);assigned.push({i,id:a.id});
  await assignments.setAssignmentStatus(tokens[i],orgs[i],{assignmentId:a.id,status:'active'},meta);
  await maps.reportResourceLocation(tokens[i],orgs[i],{resourceId,locationKind:'temporary',point:{type:'Point',coordinates:[-82.58+i*.012,35.55+i*.012]},precisionPolicy:'approximate',note:'EXERCISE ONLY: fictional reported position',positionSource:'manual',validForHours:1},meta);
  await ics.setIncidentResourceRequestStatus(tokens[0],orgs[0],incidentId,{requestId:req.id,status:'filled'},meta);
  const disclosed=await resources.readResource(tokens[0],orgs[0],resourceId,meta);
  check('Resource '+i+' ownership preserved',disclosed.orgId===orgs[i]);
  check('Resource '+i+' owner-only notes withheld',!JSON.stringify(disclosed).includes('EXERCISE_OWNER_ONLY_CANARY'));
 });
 await step('Verify cross-agency resource boundaries',async()=>{
  await denied('Partner cannot change another agency resource',()=>resources.setResourceStatus(tokens[3],orgs[3],{resourceId:id('resource:2'),readinessStatus:'unavailable'},meta));
  check('Observer sees three assignments',(await assignments.listIncidentAssignments(tokens[0],orgs[0],incidentId,meta)).length===3);
 });
 await step('Communications reconnects and then loses access',async()=>{
  const before=await incidents.readIncident(tokens[6],orgs[6],incidentId,meta);
  await sleep(rehearsal?10:2000);
  const after=await incidents.readIncident(tokens[6],orgs[6],incidentId,meta);
  check('Repeated read retains same incident',before.incident.id===after.incident.id);
  await participation.ownerParticipantAction(tokens[0],orgs[0],incidentId,participantIds[6],'revoke_partner',meta,'EXERCISE access revocation');
  await denied('Revoked agency cannot read',()=>incidents.readIncident(tokens[6],orgs[6],incidentId,meta));
 });
 await step('Verify unanswered medical invitation expiration',async()=>{
  if(rehearsal){await sleep(1100);await owner.query('SET ROLE airs_maintenance');try{await owner.query("SELECT * FROM airs.run_incident_expiration(gen_random_uuid())");}finally{await owner.query('RESET ROLE');}}
  await denied('Expired invitation cannot be accepted',()=>participation.partnerParticipationAction(tokens[5],orgs[5],participantIds[5],'accept',meta),['participation_inactive']);
  await denied('Unanswered agency cannot read',()=>incidents.readIncident(tokens[5],orgs[5],incidentId,meta));
  const rows=await participation.listParticipants(tokens[0],orgs[0],incidentId,meta);
  emit('expiration.observation',{status:rows.find(r=>r.id===participantIds[5])?.invitationStatus,note:'Access expiration is checked at read/accept time; scheduled maintenance materializes expired status.'});
 });
 // Real authenticated service reads, not browser/HTTP saturation or Cognito traffic.
 for(const concurrency of [2,5,10])await step('Bounded service-read check '+concurrency,async()=>{
  const timings:number[]=[];let errors=0,total=0;const active=new Set<Promise<void>>();const until=Date.now()+(rehearsal?300:60000);
  let lastGate=0,peak=0;while(Date.now()<until){if(Date.now()-lastGate>5000){await gate();lastGate=Date.now();}if(active.size>=concurrency)await Promise.race(active);
   const t=Date.now();const p=incidents.readIncident(tokens[1],orgs[1],incidentId,meta).then(()=>{timings.push(Date.now()-t);}).catch(()=>{errors++;}).finally(()=>{active.delete(p);});active.add(p);peak=Math.max(peak,active.size);total++;await sleep(250);
   if(errors>0)throw Error('Service read error; bounded load stopped');
  }await Promise.all(active);timings.sort((a,b)=>a-b);const p95=timings[Math.max(0,Math.ceil(timings.length*.95)-1)]??0;
  check('Service reads with concurrency cap '+concurrency,errors===0&&p95<=2000,{requests:total,errors,p95Ms:p95,concurrencyCap:concurrency,observedPeak:peak,rateCeiling:4,scope:'internal authenticated service + RLS; not HTTP load or capacity proof'});
 });
 await step('Release simulated assignments',async()=>{
  // Revoked communications cannot use the incident; its own resource assignment is still owner-managed.
  for(const a of assigned)await assignments.endAssignment(tokens[a.i],orgs[a.i],{assignmentId:a.id,status:'completed',reason:'EXERCISE complete'},meta);
 });
 stage='Close exercise and verify access ends';await gate();const closing=await incidents.beginClosure(tokens[0],orgs[0],incidentId,{expectedVersion:(await room()).version,reason:'EXERCISE completed; no real-world response was conducted'},meta);
 await sleep(rehearsal?20:20000);
 await incidents.closeIncident(tokens[0],orgs[0],incidentId,{expectedVersion:closing.version},meta);
 for(const i of [1,2,3,6])await denied('Closed incident denies former agency '+i,()=>incidents.readIncident(tokens[i],orgs[i],incidentId,meta));
 check('Owner retains lifecycle history',(await incidents.readIncidentAudit(tokens[0],orgs[0],incidentId,meta)).some(e=>e.action==='incident.closed'));
 completed=true;emit('exercise.completed',{incidentId,checks:results.length,results,notProven:['HTTP/browser load and reconnection','maximum production capacity','restore','rollback','alert delivery']});
}
try{await main();}catch(e){emit('exercise.failed',{message:e instanceof Error?e.message:'unknown',...(rehearsal&&e instanceof Error?{stack:e.stack}:{}),results});process.exitCode=1;await owner.query('ROLLBACK').catch(()=>{});if(activated&&!completed){try{const r=await room();if(r.status==='active')await incidents.pauseIncident(tokens[0],orgs[0],incidentId,r.version,meta);}catch{}}}
finally{for(const hash of hashes)await owner.query('UPDATE airs.sessions SET revoked_at=now() WHERE token_hash=$1',[hash]).catch(()=>{});await getDatabase().close().catch(()=>{});await owner.end().catch(()=>{});}
