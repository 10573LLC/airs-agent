// Generate a separate staging foundation. Never submit or update a stack here.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function stagingFoundation(productionTemplate, publicBaseUrl) {
  const url = new URL(publicBaseUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.hostname === 'app.airsagent.com') {
    throw new Error('Staging requires its own HTTPS origin');
  }
  // The input has no physical resource IDs: all foundation dependencies are
  // stack-local references. Reject drift before deriving a separate topology.
  const input = JSON.stringify(productionTemplate);
  if (/\b(?:vpc|subnet|sg)-[0-9a-f]{8,}\b/.test(input)) throw new Error('Foundation contains external network resources');
  let template = JSON.parse(input
    .replaceAll('airs-agent-prod', 'airs-agent-staging')
    .replaceAll('10.20.', '10.30.')
    .replaceAll('Production', 'Staging')
    .replaceAll('https://app.airsagent.com', url.origin));
  const r = template.Resources;
  r.Repository.Properties.RepositoryName = 'airs-agent-staging';
  r.UserPoolDomain.Properties.Domain = { 'Fn::Sub': 'airs-agent-staging-${AWS::AccountId}-${AWS::Region}' };
  r.UserPoolClient.Properties.ClientName = 'airs-agent-staging-web';
  r.Database.Properties.DBInstanceClass = 'db.t4g.micro';
  for (const resource of Object.values(r)) {
    if (resource.Type === 'AWS::Logs::LogGroup') resource.Properties.RetentionInDays = 7;
  }
  template.Description = 'AIRS isolated staging foundation: separate VPC, private database, ECS, repository and invitation-only Cognito. No production resources imported.';
  if (JSON.stringify(template).includes('airs-agent-prod') || JSON.stringify(template).includes('app.airsagent.com')) throw new Error('Production reference survived staging generation');
  return template;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, destination] = process.argv.slice(2);
  if (!origin || !destination) throw new Error('Usage: node deploy/aws/build-staging.mjs https://staging.airsagent.com OUTPUT.json');
  const source = new URL('./foundation.cloudformation.json', import.meta.url);
  if (new URL(pathToFileURL(destination)).href === source.href) throw new Error('Cannot overwrite production template');
  writeFileSync(destination, JSON.stringify(stagingFoundation(JSON.parse(readFileSync(source, 'utf8')), origin), null, 2) + '\n');
}
