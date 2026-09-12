# AIRS Agent on AWS ECS/Fargate

This directory documents the AWS deployment contract for the existing AIRS Agent application. It does not replace local Docker Compose.

## Verified application contract

- Single Node/Nitro HTTP service.
- Container port: `3000`.
- Public ALB health endpoint: `GET /api/public/health`.
- PostgreSQL is required at runtime through `DATABASE_URL`.
- The health endpoint returns HTTP 200 only when the runtime role, required schema and authentication configuration pass readiness checks.
- Runtime secrets include `DATABASE_URL` and `SESSION_SECRET`.
- Map style/attribution are Vite build-time values, not runtime secrets.
- Database migrations are ledger-backed and run through `npm run db:migrate`.
- The production app image runs as the unprivileged `node` user.

## Amazon Location map key

Created and verified active on 2026-09-12 in `us-east-1`:

- Name: `airs-agent-prod-maps`
- ARN: `arn:aws:geo:us-east-1:854465560193:api-key/airs-agent-prod-maps`
- Allowed action: `geo-maps:GetTile` only
- Resource: `arn:aws:geo-maps:us-east-1::provider/default`
- Allowed referer: `https://app.airsagent.com/*`
- Expiration: never (deactivate or rotate through the console when needed)
- Tag: `Project=AIRS`

Retrieve the value from [Amazon Location → API keys → airs-agent-prod-maps](https://us-east-1.console.aws.amazon.com/location/api-keys/home?region=us-east-1#/describe/airs-agent-prod-maps), then choose **Show API key value**. AWS retains the key; its value is not stored in this repository. The browser map key is visible to app users when included in the release bundle, so its map-only scope and website restriction must remain in place. It grants no access to AIRS application records.

Key creation alone does not connect the application. Release image configuration, live map verification and the spending alert remain pending.

## Production topology

```text
Internet
   |
 HTTPS :443
   v
Application Load Balancer (public subnets, 2 AZs)
   |
 HTTP :3000 -- SG reference only
   v
ECS/Fargate AIRS service (private subnets, desired count 2)
   |
 PostgreSQL :5432 -- SG reference only
   v
RDS PostgreSQL airs-agent-prod-db (private DB subnets)
```

The RDS instance must remain `Public access: No`.

## Security groups

Use these groups in `airs-agent-prod-vpc`:

1. `airs-agent-prod-alb-sg`
   - inbound TCP 443 from `0.0.0.0/0`
   - optional TCP 80 only for HTTP -> HTTPS redirect
   - outbound TCP 3000 to `airs-agent-prod-ecs-sg`

2. existing `airs-agent-prod-ecs-sg` (`sg-07a78a461afe48931`)
   - inbound TCP 3000 from `airs-agent-prod-alb-sg` only
   - outbound TCP 5432 to `airs-agent-prod-db-sg`
   - outbound HTTPS 443 as required for AWS service endpoints and external integrations

3. existing `airs-agent-prod-db-sg`
   - add inbound TCP 5432 from `airs-agent-prod-ecs-sg`
   - review existing rules separately; do not delete unrelated rules

Do not expose PostgreSQL to the Internet.

## Private subnet egress

The two private subnets have same-zone public NAT gateways for the Cognito OAuth token exchange. AWS service traffic continues to use these existing endpoints:

- `com.amazonaws.us-east-1.ecr.api` (Interface)
- `com.amazonaws.us-east-1.ecr.dkr` (Interface)
- `com.amazonaws.us-east-1.logs` (Interface)
- `com.amazonaws.us-east-1.secretsmanager` (Interface)
- S3 Gateway endpoint (already present; ECR image layers depend on S3)

The interface endpoints use `airs-agent-prod-vpce-sg` (`sg-015b957cf8d311ba7`), allowing TCP 443 only from `airs-agent-prod-ecs-sg`, with private DNS enabled in both private subnets.

NAT `nat-068125ce423f7e283` serves private subnet `subnet-00d0b10ff5a2e6f99` in us-east-1a through route table `rtb-098da863fe02296e4`. NAT `nat-0b87da52dccfee65a` serves `subnet-0ac15025453fee47d` in us-east-1b through `rtb-0d2bd5c6386d724ce`. Both default routes were verified Active. Preserve the S3 endpoint routes. Tasks still have public IP assignment disabled.

## Load balancer / target group

- ALB: Internet-facing, two public subnets.
- Target type: `ip` (required for Fargate/awsvpc).
- Target protocol/port: HTTP / 3000.
- Health path: `/api/public/health`.
- Success code: `200`.
- Recommended health interval: 30 seconds.
- Recommended timeout: 5 seconds.
- Healthy threshold: 2.
- Unhealthy threshold: 3.
- HTTPS listener: 443 with ACM certificate for `app.airsagent.com`.
- Redirect port 80 to 443 if port 80 is enabled.

Readiness also checks that the connection uses `airs_app` without superuser/BYPASSRLS privileges, the latest required schema is present, and the selected authentication driver is configured. It does not call Cognito on every probe.

## ECS service

- Cluster: `airs-agent-prod`.
- Launch type/capacity: Fargate.
- Platform: Linux/ARM64 is appropriate for the existing `db.t4g.small`/Graviton-oriented deployment, provided the ECR image is built for `linux/arm64`. Use Linux/X86_64 if the image pipeline builds amd64 instead; do not mix architectures.
- Container port: 3000.
- Desired count: 2 for production availability across two AZs.
- Public IP: disabled.
- Deployment circuit breaker with rollback: enabled.
- CloudWatch log group: `/ecs/airs-agent-prod` with an explicit retention policy.

Start sizing at 0.5 vCPU / 1 GiB for validation. Observe memory/CPU before production load and increase if required.

## Runtime environment and secrets

Non-secret environment:

- `NODE_ENV=production`
- `PORT=3000`
- `HOST=0.0.0.0`
- `DB_DRIVER=postgres`
- `AUTH_DRIVER=oidc` (required explicitly in production; no implicit local fallback)
- `AIRS_PUBLIC_BASE_URL=https://app.airsagent.com`
- `OIDC_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Z2QQLpc1v`
- `OIDC_DOMAIN=https://us-east-1z2qqlpc1v.auth.us-east-1.amazoncognito.com`
- `OIDC_CLIENT_ID=dfjqhlc2dc498nfu95hjeojpi`
- `AIRS_APP_RELEASE=<immutable image/commit identifier>`

Secrets must come from AWS Secrets Manager through the ECS task definition; never put them in the image or GitHub:

- `DATABASE_URL`: application-role PostgreSQL URL (use `airs_app`, not the RDS master user), with `?sslmode=verify-full&sslrootcert=/app/certs/rds-us-east-1.pem`
- `SESSION_SECRET`: randomly generated secret of at least 32 characters for encrypted OIDC transaction cookies; use the same secret on both tasks
- OIDC client secret when OIDC is enabled

The RDS-managed master credential is for administration/migration/bootstrap only. The application should not run as the RDS master user.

The image includes the public [AWS RDS us-east-1 CA bundle](https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem), downloaded 2026-09-12, SHA-256 `b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77`. Refresh and rebuild it when AWS rotates trust roots. Use the same verification parameters in the ops and maintenance connection URLs. Never use `rejectUnauthorized=false` or `sslmode=no-verify`. See [AWS PostgreSQL TLS guidance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html).

## Cognito login and invitations

The application now implements Cognito authorization-code login with S256 PKCE, state and nonce, encrypted ten-minute transaction cookies and RS256 signature/issuer/audience/expiry verification. The design follows [Cognito authorization](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html) and [token exchange](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html). Secrets and OAuth tokens stay on the server. Sessions use existing hashed opaque tokens in PostgreSQL, expire at the ID-token expiry (at most one hour), and can be revoked through the existing session controls. Refresh tokens are discarded. Cognito sign-out also clears the managed-login session in the browser.

Keep the pool invitation-only, with required TOTP MFA, email sign-in and authorization-code grant only. These pool controls are deployment requirements; an ID token does not itself prove that the pool still requires TOTP. `mfa_enrolled` in the legacy account model is not inferred from token claims. Disabling an AIRS account revokes access on the next request; disabling only a Cognito account does not invalidate an already-issued AIRS session before its expiry. Disable in both systems when immediate removal is required.

- Allowed callback: `https://app.airsagent.com/auth/callback`.
- Allowed logout: `https://app.airsagent.com/auth`.
- `/auth/login` starts login; `/auth/callback` verifies it and creates the AIRS session.
- Local password login, local recovery and local activation are disabled with `AUTH_DRIVER=oidc`.
- A Cognito account alone grants no organization membership. An AIRS invitation must match the authenticated, verified email and is consumed once. Roles come from the stored invitation, never from OIDC groups or request parameters.
- Existing accounts are matched by email for RLS lookup but must already have the exact same issuer and immutable subject. Email collisions with local accounts, changed subjects, and changed emails fail closed; linking/migration is an operator procedure, not automatic.
- Operators create invited users in Cognito and issue their AIRS agency invitations. Automatic Cognito user provisioning/email delivery is not implemented by the app. Temporary credentials and TOTP enrollment are handled on the managed login page. Ensure the Cognito account has a verified email; never mark an unverified recipient verified merely to bypass the check.

For the first administrator, use `admin@airsagent.com` in Cognito and run `npm run platform-admin:setup -- --email admin@airsagent.com` with the separate bootstrap connection. This creates the existing platform invitation, not a password or automatic privilege based on the email. Its activation page sends the recipient through Cognito and then the normal invitation acceptance. Run this operator command in a secure terminal: it prints a one-time URL, so do not run it with the standard ECS CloudWatch logging configuration. No production user, invitation or account has been created by this code change.

## Local validation

`npm ci --legacy-peer-deps`, `npm run typecheck`, `npm run build` and `npm run test:isolated` validate the checkout. The last command starts a uniquely named, disposable PostGIS 16 database on a loopback-only random port, applies the canonical ledger migrations, runs the SQL security suites and all unit/integration tests, then removes only its own container and volumes. It ignores operator database URLs. Docker must be running. Tests include Cognito claim/state/nonce/PKCE checks, account collision refusal, local-login bypass prevention, and invitation acceptance under forced RLS. These tests do not substitute for a live Cognito/TOTP acceptance test over the final HTTPS hostname.

## Database bootstrap

The existing schema creates `airs_app` as `NOLOGIN`, and local Docker bootstrap separately grants that role LOGIN with `APP_DB_PASSWORD`. RDS does not run `db/init/*.sh`, so production bootstrap must explicitly:

1. connect with the RDS managed master credential;
2. run the canonical ledger-backed migrations (`npm run db:migrate`);
3. set a generated production password on `airs_app` and grant LOGIN;
4. create/update the `DATABASE_URL` secret using `airs_app`;
5. run `npm run db:migrate:status` and readiness checks before starting the ECS service. Run fixture-based validation suites only against the disposable test database, never the production database.

Enable PostGIS on RDS using the migration operator. Do not run `db/seed/demo_orgs.sql` in production. Configure the separate `airs_maintenance` LOGIN credential and a scheduled maintenance task for incident expiry; do not use the RDS master account for that scheduler.

The Dockerfile has an explicit `ops` target containing `psql` for one-off ECS migration/bootstrap tasks. The default `runtime` target remains the smaller production application image.

Never bake database credentials into either image.

## ECR images

Repository: `airs-agent` in `us-east-1`.

The repository is immutable. Publish unique tags such as:

- `sha-<git-commit>` for the normal `runtime` target
- `ops-sha-<git-commit>` for the `ops` target

Do not depend on a mutable `latest` tag.

Example build shapes:

```sh
docker buildx build --platform linux/arm64 --target runtime -t <ECR>/airs-agent:sha-<commit> .
docker buildx build --platform linux/arm64 --target ops -t <ECR>/airs-agent:ops-sha-<commit> .
```

Pass `VITE_MAP_STYLE_URL` and `VITE_MAP_ATTRIBUTION` as build args when the production map provider is selected.

## DNS

Keep Cloudflare authoritative DNS. For the operational application, create `app.airsagent.com` pointing to the AWS ALB. The intended operational posture is DNS-only unless Cloudflare proxying is deliberately approved later. TLS terminates at the AWS ALB using ACM.

## Deployment order

1. Verify the existing interface endpoints, S3 endpoint and same-zone NAT gateways.
2. Create the ALB security group and add its TCP 3000 reference to the existing ECS group.
3. Add DB SG ingress from the ECS group.
4. Request/validate ACM certificate for `app.airsagent.com`.
5. Create ALB, target group, and HTTPS listener.
6. Create ECS task execution role and application task role with least privilege.
7. Build/push immutable runtime and ops images to ECR.
8. Bootstrap/migrate RDS with a one-off ops task.
9. Create application `DATABASE_URL` and `SESSION_SECRET` secrets.
10. Create ECS task definition and service with two private-subnet tasks.
11. Confirm ALB health checks, logs, database access, and application acceptance tests.
12. Create the Cloudflare DNS record for `app.airsagent.com`.
13. Run the Onondaga mutual-aid scenario end-to-end before production approval.
