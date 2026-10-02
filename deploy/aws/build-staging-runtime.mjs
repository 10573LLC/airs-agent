import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runtimeTemplate } from './build-runtime.mjs';

export function stagingRuntime(cfg, production) {
  if (cfg.environment !== 'staging' || cfg.publicBaseUrl !== 'https://staging.airsagent.com') throw new Error('Unexpected staging target');
  if (cfg.foundation.Cluster !== 'airs-agent-staging' || !cfg.foundation.DatabaseEndpoint.startsWith('airs-agent-staging-db.')) throw new Error('Staging foundation required');
  for (const [key, value] of Object.entries(cfg.foundation)) {
    if (production.foundation[key] === value) throw new Error(`Staging reused production ${key}`);
  }
  for (const key of ['certificateArn','oidcSecretArn','webImage','opsImage']) {
    if (!cfg[key] || cfg[key] === production[key]) throw new Error(`Separate staging ${key} required`);
  }
  for (const key of ['webImage','opsImage']) {
    if (!cfg[key].startsWith(`${cfg.foundation.RepositoryUri}@sha256:`)) throw new Error('Staging image must be pinned to its own registry digest');
  }
  const template = JSON.parse(JSON.stringify(runtimeTemplate(cfg))
    .replaceAll('airs-agent-prod','airs-agent-staging')
    .replaceAll('Production','Staging')
    .replaceAll('https://app.airsagent.com',cfg.publicBaseUrl)
    .replaceAll(':repository/airs-agent"',':repository/airs-agent-staging"'));
  delete template.Resources.AlertsEmail; // No external messages or subscriptions.
  template.Parameters.DesiredCount.AllowedValues = [0,1];
  template.Description = 'AIRS isolated staging runtime; bootstrap before enabling the single web task.';
  const serialized = JSON.stringify(template);
  if (serialized.includes('airs-agent-prod') || serialized.includes('https://app.airsagent.com')) throw new Error('Production reference survived');
  return template;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const production=JSON.parse(readFileSync(new URL('./ohio-deployment.json',import.meta.url),'utf8'));
  const output=process.argv[3];
  if (!output || /(?:^|[\\/])runtime\.cloudformation\.json$/.test(output)) throw new Error('Explicit staging output path required');
  writeFileSync(output,JSON.stringify(stagingRuntime(cfg,production),null,2)+'\n');
}
