# AIRS Ohio deployment — 2026-10-01

## Target and scope

Account **578856792953** (`10573_LLC_Management`), **us-east-2**. User explicitly selected this account and region. AIRS resources were recreated from the recorded original topology; the old account and unrelated TRACE resources were not modified. This is infrastructure/application duplication, not a claim that an old-account database dump or Cognito user export was performed. Earlier user guidance reported no existing agency/user data; fresh migrations were applied without demo fixtures.

Application: https://app.airsagent.com/auth

CloudFormation stacks: `airs-agent-prod-foundation` and `airs-agent-prod-runtime`, both protected from deletion. Public resource metadata is in `ohio-deployment.json`; it contains secret ARNs, never secret values. Generate templates with `node deploy/aws/build-foundation.mjs` and `node deploy/aws/build-runtime.mjs deploy/aws/ohio-deployment.json`. Always verify STS account and explicitly select us-east-2 before changes. Runtime creation defaults to zero tasks and disabled scheduling; the deployed parameters are **DesiredCount=2, ScheduleState=ENABLED**.

## Network

VPC `vpc-0363a653c82717957`, 10.20.0.0/16.

| Placement | Public | Private |
|---|---|---|
| us-east-2a | subnet-0b00907e3d3d4198e, 10.20.0.0/20 | subnet-041eb62bd816d9a26, 10.20.128.0/20 |
| us-east-2b | subnet-09de32da23d65ca56, 10.20.16.0/20 | subnet-08ecbba0eda28ed91, 10.20.144.0/20 |

NAT gateways `nat-04a25ee7f42763a47` (2a) and `nat-05cb095901af892dd` (2b), both available; private routes use the NAT in the same zone. Tasks have no public IPs.

| Security group | Inbound |
|---|---|
| ALB sg-08afd21e5cbc9d779 | TCP80/443 from internet; 80 redirects to HTTPS |
| ECS sg-05b165d6a7397c557 | TCP3000 only from ALB group |
| Endpoints sg-095282eb04ef26352 | TCP443 only from ECS group |
| Database sg-03d1d33e4f3b031a4 | TCP5432 only from ECS group |

All four interface endpoints are available, have Private DNS enabled, use both private subnets, and attach only endpoint group sg-095282eb04ef26352:

| Service suffix | Endpoint |
|---|---|
| ecr.api | vpce-0938bb7fbc0ab84a0 |
| ecr.dkr | vpce-017697902893e5617 |
| logs | vpce-0b4ed1e0fafc53fc8 |
| secretsmanager | vpce-06ea52e831cd222c7 |

S3 gateway endpoint `vpce-05b93790e4ad99f95` is available on the private route tables. Original-account S3 endpoint was preserved. Security-group display names are provided by Name tags; CloudFormation generated the physical group names.

## Database and credentials

RDS `airs-agent-prod-db`, PostgreSQL16.15, db.t4g.small, encrypted gp3, 20GiB expandable to100GiB, single-AZ2b, private, deletion protection, seven-day backups and PostgreSQL CloudWatch logging. Endpoint `airs-agent-prod-db.cp8c828kkueu.us-east-2.rds.amazonaws.com`. Database `airs_agent`.

17 migrations applied and ledger verified: no pending migration/checksum conflict. Separate `airs_app` and `airs_maintenance` credentials in Secrets Manager. Both roles lack superuser, RLS bypass, role/database creation and replication rights. TLS verifies the official Ohio RDS bundle. Password-free URLs use injected PGPASSWORD. Web task cannot read the RDS master password and has no AWS task role. Credentials/client secret/session key are not committed.

Initial bootstrap revision1 failed with PostgreSQL42501 while explicitly altering privileged role flags; all migrations had already committed. Revision2 verifies the roles already lack those privileges and only assigns LOGIN/password. Rerun succeeded exit0 without reapplying migrations. Bootstrap task `a070f969bfc84ab78d90b6a709345a5d`.

Initial encrypted snapshot `airs-agent-prod-initial-schema-20261001` verified available. Automated point-in-time recovery was available. A restore drill has not yet been completed.

## Runtime and HTTPS

ECR `578856792953.dkr.ecr.us-east-2.amazonaws.com/airs-agent`, immutable tags, scan on push.

- Web `web-20261001-ohio`: sha256:62726a5e85369991147be677a8503bac3285fda44b48e710ddd544c741d9c747
- Ops `ops-20261001-ohio`: sha256:936ab8912e94cf6afb6ff2355d65ca1328463922be230cfcbbdc1df54e16d960

Images built from ae770836 plus Ohio CA/configuration changes. LinuxARM64, non-root. Build-only corporate CA mounted as a secret for APK download, without disabling TLS verification or adding that trust to the runtime image.

ECS cluster/service `airs-agent-prod`, web task definition `airs-agent-prod:1`, two512CPU/1024MiB Fargate tasks, one healthy target in each private AZ. Deployment circuit breaker with rollback enabled; 100% minimum healthy /200% maximum. No intentional outage or rollback drill performed yet.

ALB `airs-agent-prod-alb`, DNS `airs-agent-prod-alb-1960739078.us-east-2.elb.amazonaws.com`, target group `airs-agent-prod-web`, HTTPS with ACM certificate `b8c80d75-26d9-425d-915d-4a571539c978` (ISSUED). Cloudflare DNS-only CNAME app.airsagent.com, record `01be1f7b9f183945ca7b4b8d816f2b0e`, TTL300. Existing marketing and mail DNS unchanged.

## Authentication and maps

Cognito pool `us-east-2_7G9mvWY4g`, client `4m7j4tbq76eb6afb8mr0jge7ji`, domain `airs-agent-578856792953-us-east-2`. Invitation-only, email sign-in, mandatory authenticator MFA. Client-secret copy is stored in Secrets Manager. Real user onboarding does not automatically confer agency access.

Cognito invitation requested for admin@airsagent.com; AWS returned FORCE_CHANGE_PASSWORD. User must receive it, choose their own password, enroll TOTP and complete verified-email onboarding. Email was not marked verified by the operator. Platform invitation/acceptance remains to be completed securely after mailbox verification; never print an activation token to CloudWatch logs.

Ohio Location key `airs-agent-prod-maps`, tile-only scope for provider/default, approved referer https://app.airsagent.com/*. Included in the rebuilt web image. Verified style/tile/sprite/glyph200; actual tile403 with unrelated or absent referer. Style metadata alone is publicly retrievable; tile authorization is enforced. Preserve built-in AWS/HERE attribution. Authenticated map rendering remains part of live acceptance.

Monthly Location budget USD50, email admin@airsagent.com at actual spend>100%; HEALTHY. An alert, not a spending cap. See location-budget-ohio.json.

## Operations and verification

- Type checking passed; isolated verification passed436 tests/35files, all17 migrations and11 SQL security suites.
- Both production image checks passed: ops ledger, web readiness, managed login page, PKCE redirect, secure transaction cookie and invalid callback rejection.
- Live HTTPS health200 with database reachable; /auth200; /auth/login302 to Ohio Cognito; cookie Secure/HttpOnly/SameSite=Lax; invalid callback rejected back to sign-in.
- Browser displayed AIRS sign-in and Cognito login successfully.
- Maintenance task `3a2921d6395f4decbd953a3c800ea4c3` completed exit0. EventBridge `airs-agent-prod-expiration` enabled every5 minutes, private networking and scoped execution role.
- Logs retained30days at /ecs/airs-agent-prod, /ecs/airs-agent-prod-ops and /ecs/airs-agent-prod-maintenance.
- CPU, memory, unhealthy target, low database storage and maintenance-log failure alarms configured; all OK when checked. SNS airs-agent-prod-alerts email subscription is PENDING CONFIRMATION. Email delivery and alarm firing still need verification. Maintenance task-start failure/heartbeat monitoring is not yet covered by the log-failure alarm.

## Remaining launch gates

1. User receives Cognito email and completes password/MFA/verified email; issue and accept a secure platform invitation.
2. Real agency workflow: onboarding, cross-agency isolation, incident opening/coordination/closing, map attribution/rendering, logout and account disabling. Do not call this world-ready until these pass.
3. Confirm SNS email, test alert delivery, complete restore and deployment-rollback drills, and cover scheduler task-start failures/missing heartbeats.
4. Identify the initial invited pilot agencies and operational acceptance owner. No arbitrary agencies/users or demo incidents were inserted.

Before changing region, this task also created an empty ECS cluster and ECR repo named airs-agent-prod / airs-agent in the NEW account's us-east-1, plus ACM certificate15e9db36-cd6a-4ebe-9d9d-a71af04f8364. Its successful launch-check task exited0, temporary SG was removed and definition deregistered. Empty cluster/repository/certificate remain for deliberate cleanup; they are not the active deployment.
