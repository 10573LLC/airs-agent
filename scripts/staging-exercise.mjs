import { spawn } from 'node:child_process';

const host=process.env.STAGING_DB_HOST;
if (!host || !/^airs-agent-staging-db\.[a-z0-9]+\.us-east-2\.rds\.amazonaws\.com$/.test(host)) throw new Error('Refusing non-staging database');
function connection(role,key) {
  const password=process.env[key];
  // RDS manages the master password length; application passwords are 48 chars.
  if (!password || password.length<(key==='ADMIN_DB_PASSWORD'?16:32)) throw new Error('Missing staging credential');
  const url=new URL(`postgresql://${role}@${host}:5432/airs_agent`);
  url.password=password;
  url.searchParams.set('sslmode','verify-full');
  url.searchParams.set('sslrootcert','/app/deploy/aws/us-east-2-bundle.pem');
  return url.toString();
}
const env={...process.env,AUTH_DRIVER:'local',NODE_ENV:'test',
  TEST_DATABASE_URL:connection('airs_app','APP_DB_PASSWORD'),
  TEST_ADMIN_DATABASE_URL:connection('postgres','ADMIN_DB_PASSWORD')};
env.DATABASE_URL=env.TEST_DATABASE_URL;
delete env.PGPASSWORD;
const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/framework-operational-exercise.test.ts','--reporter=dot'],{env,stdio:'inherit'});
child.on('error',()=>{console.error('Staging exercise could not start');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
