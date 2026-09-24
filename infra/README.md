# AIRS Agent AWS production infrastructure

Organization management account: `509581811007`  
Workload account: dedicated **AIRS Production** member account (created before deployment)  
Primary region: `us-east-2` (Ohio)

AIRS production workloads do **not** run in the AWS Organizations management account. The management account is used only to create/govern the dedicated member account. TRACE will receive a separate production member account and separate infrastructure.

## Account bootstrap

From the 10573 LLC Organizations management account, run:

```sh
bash infra/bootstrap/create-airs-production-account.sh
```

The default member-account root email is `developer+airs-prod@10573llc.com`. You may pass another unique mailbox/address as the first argument.

The script is idempotent. It:

1. verifies that the caller is in management account `509581811007`;
2. creates/reuses a **Production** OU;
3. creates/reuses the **AIRS Production** member account;
4. moves the member account into the Production OU;
5. assumes `OrganizationAccountAccessRole` in that member account; and
6. runs `aws-bootstrap.sh` there.

The member-account bootstrap creates its own private Terraform-state bucket, GitHub OIDC provider, repository-scoped deployment role, and AIRS deployment policy. No long-lived AWS keys are stored in GitHub.

The script prints:

`AIRS_PRODUCTION_ACCOUNT_READY=<12-digit-account-id>`

That member account ID is the value supplied to the GitHub production deployment workflow.

## Production topology

- two Availability Zones
- public ALB subnets
- private ECS/RDS subnets
- same-AZ NAT gateways for private workload egress and Cognito OAuth/JWKS traffic
- S3 gateway endpoint
- ECS/Fargate web service and dedicated maintenance service
- one-off Fargate ops task for ledger-backed migrations/database bootstrap
- private PostgreSQL 16 RDS, Multi-AZ by default, forced TLS, encrypted storage, 14-day backups, and deletion protection
- immutable ECR images with lifecycle cleanup
- Secrets Manager for runtime credentials
- Cognito user pool with invitation-only administration and required TOTP MFA
- ACM certificate request for `app.airsagent.com`
- CloudWatch logs with explicit retention
- cost alerts only; no automatic production shutdown

## GitHub authentication

GitHub Actions authenticates into the dedicated AIRS member account through AWS OIDC. The trust policy allows only:

`repo:10573LLC/airs-agent:ref:refs/heads/main`

Pull-request checks never receive AWS credentials. The production workflow also verifies the STS account ID and Terraform has a second account-ID guard.

## Deployment sequence

1. Review and merge PR #2 to `main` only after all pull-request checks pass.
2. Run **AIRS Production Deploy** with the AIRS member account ID and `activate_services=false`.
3. The workflow provisions the foundation, requests ACM, builds/pushes immutable runtime and ops images, and runs the one-off RDS migration/bootstrap task while the public services remain stopped.
4. Read the workflow handoff for the ACM DNS-validation CNAME and ALB DNS hostname.
5. Add the ACM validation CNAME in Cloudflare as DNS-only and wait for ACM status `ISSUED`.
6. Add `app.airsagent.com` as a DNS-only CNAME to the ALB hostname.
7. Run **AIRS Production Deploy** again with the same account ID and `activate_services=true`.
8. The workflow refuses activation unless ACM is `ISSUED`, enables HTTPS plus HTTP-to-HTTPS redirect, starts the application and maintenance services, and waits for ECS stability.
9. Validate `https://app.airsagent.com/api/public/health`, Cognito/TOTP login, tenant/RLS isolation, audit behavior, maintenance, mapping, and the operational acceptance scenarios before production approval.

## Database bootstrap

The ops image contains `psql`; the normal runtime image does not. RDS manages the owner password in Secrets Manager. The migration task receives that password only as `PGPASSWORD`, uses a password-free owner URL with `sslmode=verify-full`, applies the canonical migration ledger, assigns independent generated passwords to `airs_app` and `airs_maintenance`, and verifies zero pending migrations.

Production never runs `db/seed/demo_orgs.sql`.

## TLS

The image downloads the official AWS RDS global CA bundle at build time. Production PostgreSQL URLs use:

`sslmode=verify-full&sslrootcert=/app/certs/rds-global.pem`

The application service remains at desired count zero until HTTPS activation.

## Cost posture

The default Terraform budget is USD 100/month as an **alert threshold**, not a spending cap. Forecasted 50%, actual 80%, and actual 100% notifications go to `developer@10573llc.com` by default.

Two NAT gateways and Multi-AZ RDS are deliberate production-resilience choices. Change those choices deliberately, not as an incidental cost workaround.

## Management-account cleanup

The earlier Fargate canary proved `us-east-2` works, and it was deleted. A temporary AIRS Terraform bucket/OIDC role/policy were also created in management account `509581811007` before the dedicated-member-account decision. Leave those untouched until the AIRS member account bootstrap is verified. They can then be removed in a separate, explicitly approved cleanup step.
