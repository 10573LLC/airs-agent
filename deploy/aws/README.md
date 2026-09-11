# AIRS Agent on AWS ECS/Fargate

This directory documents the AWS deployment contract for the existing AIRS Agent application. It does not replace local Docker Compose.

## Verified application contract

- Single Node/Nitro HTTP service.
- Container port: `3000`.
- Public ALB health endpoint: `GET /api/public/health`.
- PostgreSQL is required at runtime through `DATABASE_URL`.
- The health endpoint returns HTTP 200 only when PostgreSQL is reachable.
- Runtime secrets include `DATABASE_URL` and `SESSION_SECRET`.
- Map style/attribution are Vite build-time values, not runtime secrets.
- Database migrations are ledger-backed and run through `npm run db:migrate`.
- The production app image runs as the unprivileged `node` user.

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

Create three dedicated groups in `airs-agent-prod-vpc`:

1. `airs-agent-prod-alb-sg`
   - inbound TCP 443 from `0.0.0.0/0`
   - optional TCP 80 only for HTTP -> HTTPS redirect
   - outbound TCP 3000 to `airs-agent-prod-app-sg`

2. `airs-agent-prod-app-sg`
   - inbound TCP 3000 from `airs-agent-prod-alb-sg` only
   - outbound TCP 5432 to `airs-agent-prod-db-sg`
   - outbound HTTPS 443 as required for AWS service endpoints and external integrations

3. existing `airs-agent-prod-db-sg`
   - inbound TCP 5432 from `airs-agent-prod-app-sg` only
   - remove workstation/public CIDR ingress after ECS connectivity is established

Do not expose PostgreSQL to the Internet.

## Private subnet egress

This VPC intentionally has no NAT Gateway. Fargate tasks therefore need VPC endpoints for AWS control-plane dependencies used by the task:

- `com.amazonaws.us-east-1.ecr.api` (Interface)
- `com.amazonaws.us-east-1.ecr.dkr` (Interface)
- `com.amazonaws.us-east-1.logs` (Interface)
- `com.amazonaws.us-east-1.secretsmanager` (Interface)
- S3 Gateway endpoint (already present; ECR image layers depend on S3)

Attach an endpoint security group allowing TCP 443 from `airs-agent-prod-app-sg`. Enable private DNS on the interface endpoints.

If AIRS requires arbitrary outbound Internet integrations in production, add a controlled egress design (for example NAT Gateway) rather than making application tasks public.

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

Because the health route checks PostgreSQL, an app task is not put into service when its database is unreachable.

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
- `AIRS_DB_ADAPTER=postgres`
- `AIRS_AUTH_ADAPTER=oidc` when the production identity provider is configured
- `AIRS_APP_RELEASE=<immutable image/commit identifier>`

Secrets must come from AWS Secrets Manager through the ECS task definition; never put them in the image or GitHub:

- `DATABASE_URL`: application-role PostgreSQL URL (use `airs_app`, not the RDS master user)
- `SESSION_SECRET`: production session signing secret
- OIDC client secret when OIDC is enabled

The RDS-managed master credential is for administration/migration/bootstrap only. The application should not run as the RDS master user.

## Database bootstrap

The existing schema creates `airs_app` as `NOLOGIN`, and local Docker bootstrap separately grants that role LOGIN with `APP_DB_PASSWORD`. RDS does not run `db/init/*.sh`, so production bootstrap must explicitly:

1. connect with the RDS managed master credential;
2. run the canonical ledger-backed migrations (`npm run db:migrate`);
3. set a generated production password on `airs_app` and grant LOGIN;
4. create/update the `DATABASE_URL` secret using `airs_app`;
5. run `npm run db:migrate:status` and the repository validation suite before starting the ECS service.

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

1. Create the four required interface VPC endpoints and endpoint SG.
2. Create ALB and application security groups.
3. Change DB SG ingress to app-SG-only after connectivity is available.
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
