import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {loadMigrations,buildLedgerBootstrapScript,buildMigrationScript,VERIFICATION_FILES} from './lib/migrate-plan.mjs';
const name='airs-friend-check-'+randomBytes(5).toString('hex');
const call=(args,input)=>{const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw Error(r.stderr);return r.stdout;};
const sql=text=>call(['exec','-i',name,'psql','-h','127.0.0.1','-X','-v','ON_ERROR_STOP=1','-U','airs_owner','-d','airs','-At'],text);
try{
 call(['run','-d','--name',name,'-e','POSTGRES_USER=airs_owner','-e','POSTGRES_DB=airs','-e','POSTGRES_PASSWORD='+randomBytes(24).toString('hex'),'postgis/postgis:16-3.5-alpine']);
 for(let i=0;i<40;i++){try{sql('SELECT 1');break;}catch{await new Promise(r=>setTimeout(r,500));}}
 sql(buildLedgerBootstrapScript());for(const m of loadMigrations())sql(buildMigrationScript(m));
 sql(readFileSync('db/seed/demo_orgs.sql','utf8'));for(const file of VERIFICATION_FILES)sql(readFileSync(file,'utf8')); 
 console.log('PASS: reciprocal friendship, associate denial, no private-row exposure, outsider denial, expiry, unsharing and revocation.');
}finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'});}


