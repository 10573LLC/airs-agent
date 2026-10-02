import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error Deployment helpers are deliberately plain Node JavaScript.
import { stagingFoundation } from '../deploy/aws/build-staging.mjs';

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
});
