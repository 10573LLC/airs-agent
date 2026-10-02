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
  if(cfg.enableExerciseAgents) {
    const r=template.Resources;
    template.Parameters.ExerciseAgentsEnabled={Type:'Number',Default:0,AllowedValues:[0,1]};
    r.ExerciseSeed={Type:'AWS::SecretsManager::Secret',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Name:'airs-agent-staging/exercise-seed',GenerateSecretString:{PasswordLength:48,ExcludePunctuation:true}}};
    r.ExerciseLogs={Type:'AWS::Logs::LogGroup',Properties:{LogGroupName:'/ecs/airs-agent-staging-responders',RetentionInDays:14}};
    r.ExerciseExecutionRole=structuredClone(r.WebExecutionRole);
    r.ExerciseExecutionRole.Properties.RoleName='airs-agent-staging-responders-execution-role';
    for(const statement of r.ExerciseExecutionRole.Properties.Policies[0].PolicyDocument.Statement) {
      if(statement.Action==='secretsmanager:GetSecretValue')statement.Resource=[{Ref:'AppPassword'},{Ref:'ExerciseSeed'}];
      if(Array.isArray(statement.Action)&&statement.Action.includes('logs:PutLogEvents'))statement.Resource=`arn:aws:logs:${cfg.region}:${cfg.account}:log-group:/ecs/airs-agent-staging-responders:*`;
    }
    r.ExerciseTask=structuredClone(r.WebTask);
    r.ExerciseTask.Properties.Family='airs-agent-staging-responders';
    r.ExerciseTask.Properties.ExecutionRoleArn={'Fn::GetAtt':['ExerciseExecutionRole','Arn']};
    const container=r.ExerciseTask.Properties.ContainerDefinitions[0];
    container.Name='responders';delete container.PortMappings;delete container.HealthCheck;
    container.Command=['node','.exercise-agent/runner.mjs'];
    container.Environment=container.Environment.filter(e=>['NODE_ENV','DB_DRIVER','DATABASE_URL'].includes(e.Name));
    container.Environment.push({Name:'AUTH_DRIVER',Value:'local'});
    container.Secrets=[{Name:'PGPASSWORD',ValueFrom:{Ref:'AppPassword'}},{Name:'EXERCISE_SEED',ValueFrom:{Ref:'ExerciseSeed'}}];
    if(cfg.exerciseModelSecretArn) {
      if(!cfg.exerciseModelSecretArn.startsWith(`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:airs-agent-staging/exercise-model-`)) throw Error('Separate staging model secret required');
      container.Environment.push({Name:'EXERCISE_INTELLIGENCE',Value:'openai'},{Name:'EXERCISE_MODEL',Value:'gpt-4.1-mini'});
      container.Secrets.push({Name:'EXERCISE_OPENAI_API_KEY',ValueFrom:cfg.exerciseModelSecretArn});
      r.ExerciseExecutionRole.Properties.Policies[0].PolicyDocument.Statement.find(s=>s.Action==='secretsmanager:GetSecretValue').Resource.push(cfg.exerciseModelSecretArn);
    }
    container.LogConfiguration.Options['awslogs-group']='/ecs/airs-agent-staging-responders';
    r.ExerciseService={Type:'AWS::ECS::Service',DependsOn:['ExerciseLogs'],Properties:{ServiceName:'airs-agent-staging-responders',Cluster:cfg.foundation.Cluster,LaunchType:'FARGATE',DesiredCount:{Ref:'ExerciseAgentsEnabled'},TaskDefinition:{Ref:'ExerciseTask'},NetworkConfiguration:structuredClone(r.Service.Properties.NetworkConfiguration),DeploymentConfiguration:{MinimumHealthyPercent:0,MaximumPercent:100}}};
    const bootstrapStatements=r.BootstrapExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
    bootstrapStatements.find(s=>s.Action==='secretsmanager:GetSecretValue').Resource.push({Ref:'ExerciseSeed'});
    r.ExerciseProvisionTask=structuredClone(r.BootstrapTask);
    r.ExerciseProvisionTask.Properties.Family='airs-agent-staging-provision-responders';
    const provision=r.ExerciseProvisionTask.Properties.ContainerDefinitions[0];
    provision.Command=['node','.exercise-agent/runner.mjs','--provision'];
    provision.Environment=structuredClone(container.Environment);
    provision.Secrets=[...structuredClone(container.Secrets).filter(s=>s.Name!=='EXERCISE_OPENAI_API_KEY'),{Name:'ADMIN_DB_PASSWORD',ValueFrom:`${cfg.foundation.MasterSecretArn}:password::`}];
    template.Outputs.ExerciseProvisionTask={Value:{Ref:'ExerciseProvisionTask'}};
    template.Outputs.ExerciseTask={Value:{Ref:'ExerciseTask'}};
  }
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
