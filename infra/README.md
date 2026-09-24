# AIRS Agent AWS production infrastructure

Target AWS account: `509581811007`  
Primary region: `us-east-2` (Ohio)

This directory is the reproducible production deployment definition for AIRS Agent. It does not reuse or modify the legacy AWS account.

## Production topology

- two Availability Zones
- public ALB subnets
- private ECS/RDS subnets
- same-AZ NAT gateways for private workload egress and Cognito OAuth/JWKS traffic
- S3 gateway endpoint
- ECS/Fargate web service and dedicated maintenance service
- one-off Fargate ops task for ledger-backed migrations/database bootstrap
- private PostgreSQL 16 RDS, Multi-AZ by default, forced TLS, encrypted storage, 14-day backups and deletion protection
- immutable ECR images
- Secrets Manager for runtime credentials
- Cognito user pool with invitation-only administration and required TOTP MFA
- ACM certificate request for `app.airsagent.com`
- CloudWatch logs with explicit retention
- cost alerts only; no automatic production shutdown

TRACE must use its own application stack, database, secrets, task roles and security groups.

## GitHub authentication

GitHub Actions authenticates through AWS OIDC. There are no long-lived AWS access keys in GitHub.

The production role is:

`arn:aws:iam::509581811007:role/AIRSAgentGitHubDeployRole`

Its trust policy is restricted to the `main` branch of `10573LLC/airs-agent`. Pull-request checks do not receive AWS credentials.

## One-time bootstrap

The OIDC provider and role already exist. From an authenticated management shell in account `509581811007`:

```sh
bash infra/bootstrap/aws-bootstrap.sh
```

The script:

1. verifies the target account;
2. creates/locks down the private Terraform state bucket if needed;
3. creates or updates the AIRS deployment policy;
4. attaches it to the existing deployment role; and
5. tightens the role trust policy to the repository's `main` branch.

It does not deploy AIRS.

## Deployment sequence

1. Merge reviewed infrastructure/application changes to `main`.
2. Run **AIRS Production Deploy** with `activate_services=false`.
3. The workflow creates the foundation, requests ACM, builds/pushes immutable runtime and ops images, and runs the one-off RDS migration/bootstrap task.
4. Read the workflow handoff for the ACM DNS validation CNAME and ALB DNS hostname.
5. Add the ACM validation CNAME in Cloudflare (DNS only) and wait for ACM status `ISSUED`.
6. Add `app.airsagent.com` as a DNS-only CNAME to the ALB hostname.
7. Run **AIRS Production Deploy** again with `activate_services=true`.
8. The workflow refuses activation unless ACM is `ISSUED`, enables HTTPS/HTTP redirect, starts the application and maintenance services, and waits for ECS stability.
9. Validate `https://app.airsagent.com/api/public/health`, Cognito/TOTP login, tenant/RLS behavior and the operational acceptance scenarios before production approval.

## Database bootstrap

The ops image contains `psql`; the normal runtime image does not. RDS manages the owner password in Secrets Manager. The migration task receives that password only as `PGPASSWORD`, uses a password-free owner URL with `sslmode=verify-full`, applies the canonical migration ledger, assigns independent generated passwords to `airs_app` and `airs_maintenance`, and verifies zero pending migrations.

Production never runs `db/seed/demo_orgs.sql`.

## TLS

The image downloads the official AWS RDS global CA bundle at build time. All production PostgreSQL URLs use:

`sslmode=verify-full&sslrootcert=/app/certs/rds-global.pem`

The application service remains at desired count zero until HTTPS activation.

## Cost posture

The default Terraform budget is USD 100/month as an alerting threshold, not a spending cap. Forecasted 50%, actual 80%, and actual 100% notifications go to `developer@10573llc.com` by default.

Two NAT gateways and Multi-AZ RDS are intentionally selected for production resilience. Change those choices deliberately, not as an incidental cost workaround.
