import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error Deployment helpers are deliberately plain Node JavaScript.
import { stagingFoundation } from '../deploy/aws/build-staging.mjs';
// @ts-expect-error Deployment helpers are deliberately plain Node JavaScript.
import { stagingRuntime } from '../deploy/aws/build-staging-runtime.mjs';
// @ts-expect-error Deployment helpers are deliberately plain Node JavaScript.
import { runtimeTemplate } from '../deploy/aws/build-runtime.mjs';

const production = JSON.parse(readFileSync('deploy/aws/foundation.cloudformation.json', 'utf8'));
describe('isolated staging infrastructure', () => {
  it('isolates network, data, identity and registry without mutating production', () => {
    const original = JSON.stringify(production);
    const stage = stagingFoundation(production, 'https://staging.airsagent.com');
    const r = stage.Resources;
    expect(JSON.stringify(production)).toBe(original);
    expect(JSON.stringify(stage)).not.toMatch(/airs-agent-prod|app\.airsagent\.com|10\.20\./);
    expect(r.Vpc.Properties.CidrBlock).toBe('10.30.0.0/16');
    expect(r.Database.Properties.PubliclyAccessible).toBe(false);
    expect(r.Database.Properties.StorageEncrypted).toBe(true);
    expect(r.Database.Properties.DBInstanceIdentifier).toBe('airs-agent-staging-db');
    expect(r.Repository.Properties.RepositoryName).toBe('airs-agent-staging');
    expect(r.UserPool.Properties.MfaConfiguration).toBe('ON');
    expect(r.UserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
    expect(r.UserPoolClient.Properties.CallbackURLs).toEqual(['https://staging.airsagent.com/auth/callback']);
    expect(r.DatabaseSecurityGroup.Properties.SecurityGroupIngress[0].SourceSecurityGroupId).toEqual({Ref:'EcsSecurityGroup'});
  });
  it('rejects the live origin and imported physical network resources', () => {
    expect(() => stagingFoundation(production, 'https://app.airsagent.com')).toThrow();
    expect(() => stagingFoundation(production, 'http://staging.airsagent.com')).toThrow();
    expect(() => stagingFoundation({...production, leaked: 'vpc-0363a653c82717957'}, 'https://staging.airsagent.com')).toThrow();
  });
  it('keeps staging runtime secrets, images and execution roles separate', () => {
    const live=JSON.parse(readFileSync('deploy/aws/ohio-deployment.json','utf8'));
    const cfg={...live,environment:'staging',publicBaseUrl:'https://staging.airsagent.com',certificateArn:'staging-certificate',oidcSecretArn:'staging-oidc-secret',foundation:Object.fromEntries(Object.keys(live.foundation).map(k=>[k,`staging-${k}`]))};
    cfg.foundation.Cluster='airs-agent-staging';
    cfg.foundation.DatabaseEndpoint='airs-agent-staging-db.example.test';
    cfg.foundation.RepositoryUri='578856792953.dkr.ecr.us-east-2.amazonaws.com/airs-agent-staging';
    cfg.webImage=cfg.opsImage=cfg.maintenanceImage=cfg.foundation.RepositoryUri+'@sha256:'+'a'.repeat(64);
    const template=stagingRuntime(cfg,live);
    expect(template.Resources.AlertsEmail).toBeUndefined();
    expect(template.Parameters.DesiredCount.Default).toBe(0);
    expect(template.Parameters.DesiredCount.AllowedValues).toEqual([0,1]);
    expect(JSON.stringify(template)).not.toContain('airs-agent-prod');
    expect(JSON.stringify(template)).toContain('repository/airs-agent-staging');
    expect(()=>stagingRuntime({...cfg,foundation:{...cfg.foundation,Vpc:live.foundation.Vpc}},live)).toThrow('production Vpc');
    expect(runtimeTemplate(live).Resources.Service.Properties.ServiceName).toBe('airs-agent-prod');
    const exercise=stagingRuntime({...cfg,enableExerciseAgents:true},live);
    expect(exercise.Parameters.ExerciseAgentsEnabled.Default).toBe(0);
    expect(exercise.Resources.ExerciseTask.Properties.ContainerDefinitions[0].PortMappings).toBeUndefined();
    expect(JSON.stringify(exercise.Resources.ExerciseExecutionRole)).not.toContain(cfg.foundation.MasterSecretArn);
    expect(exercise.Resources.ExerciseTask.Properties.ContainerDefinitions[0].Secrets.map((s:any)=>s.Name)).toEqual(['PGPASSWORD','EXERCISE_SEED']);
    expect(exercise.Resources.WebTask.Properties.ContainerDefinitions[0].Environment).toContainEqual({Name:'AUTH_DRIVER',Value:'oidc'});
    const secret=`arn:aws:secretsmanager:${cfg.region}:${cfg.account}:secret:airs-agent-staging/exercise-model-test`;
    const intelligent=stagingRuntime({...cfg,enableExerciseAgents:true,exerciseModelSecretArn:secret},live);
    expect(JSON.stringify(intelligent.Resources.ExerciseTask)).toContain(secret);
    expect(JSON.stringify(intelligent.Resources.ExerciseExecutionRole)).toContain(secret);
    for(const id of ['WebTask','WebExecutionRole','ExerciseProvisionTask','BootstrapExecutionRole']) expect(JSON.stringify(intelligent.Resources[id])).not.toContain(secret);
    expect(()=>stagingRuntime({...cfg,enableExerciseAgents:true,exerciseModelSecretArn:'arn:wrong-account-or-production-secret'},live)).toThrow();
  });
});
