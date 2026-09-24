# AIRS Agent AWS production infrastructure

Primary region: `us-east-2` (Ohio)

This deployment intentionally preserves the production architecture that was prepared in the earlier AWS account before ECS/Fargate `RunTask` was blocked. The new traditional AWS account changes the account/control-plane path, not the AIRS application architecture.

## Account model

- new traditional 10573 LLC AWS account = Organizations management account
- AIRS Production = dedicated member account
- TRACE Production will later use a separate member account
- AIRS workload resources live only in AIRS Production

Create a unique monitored root email alias for the AIRS member account, then from management-account CloudShell:

```sh
git clone https://github.com/10573LLC/airs-agent.git
cd airs-agent
git checkout task/aws-prod-us-east-2-20260923
bash infra/bootstrap/create-airs-production-account.sh aws-airs@10573llc.com
```

The script creates/reuses the `Production` OU, creates/reuses the `AIRS Production` member account, assumes `OrganizationAccountAccessRole`, and bootstraps GitHub OIDC plus Terraform state inside the AIRS account.

It prints:

`AIRS_PRODUCTION_ACCOUNT_READY=<12-digit-account-id>`

## Preserved AIRS production topology

```text
Internet
   |
 HTTPS :443
   v
Application Load Balancer
(public subnets in two AZs)
   |
 HTTP :3000 -- SG reference only
   v
ECS/Fargate AIRS service
(private subnets, desired count 2)
   |
 PostgreSQL :5432 -- SG reference only
   v
RDS PostgreSQL 16
(private DB subnets)
```

The deployment keeps the same operational model as the blocked account:

- two public and two private subnets across two Availability Zones
- same-AZ NAT gateways for private-task outbound internet access, including Cognito OAuth/JWKS traffic
- private interface endpoints for ECR API, ECR Docker, CloudWatch Logs, and Secrets Manager
- S3 gateway endpoint for ECR image layers
- ALB with HTTPS and HTTP-to-HTTPS redirect
- ECS/Fargate application service at 0.5 vCPU / 1 GiB, desired count 2
- separate 0.25 vCPU / 0.5 GiB maintenance service
- one-off ops/migration Fargate task
- private PostgreSQL 16 RDS `db.t4g.small`, Single-AZ, 20 GiB gp3, autoscaling to 100 GiB
- encrypted RDS storage, forced TLS, 7-day backups, and deletion protection
- immutable ECR repository
- Secrets Manager runtime credentials
- Cognito invitation-only sign-in with required TOTP MFA
- Amazon Location browser map key restricted to `https://app.airsagent.com/*`
- CloudWatch log retention of 30 days

## Cost monitoring

This account does not rely on promotional credits. The architecture is therefore monitored, not silently redesigned.

The default AWS Budget is USD 75/month and sends:

- a forecast alert at 40% (about the lower end of the user's management range)
- an actual-cost alert at 80%
- an actual-cost alert at 100%

These are notifications only. They never stop AIRS automatically.

The preserved topology contains several always-on billable components, especially NAT gateways, interface endpoints, ALB, RDS, and Fargate. It can exceed USD 75/month depending on runtime and traffic. If actual spend starts moving outside the desired USD 30–75 management range, cost reductions will be proposed explicitly rather than changing the architecture without approval.

## Security groups

- ALB: inbound 80/443 from the internet; outbound 3000 only to the AIRS ECS security group
- ECS: inbound 3000 only from the ALB security group
- RDS: inbound 5432 only from the ECS security group
- VPC endpoints: inbound 443 only from the ECS security group
- RDS remains `Public access: No`
- ECS tasks remain in private subnets with public IP assignment disabled

## Database bootstrap

The ops image contains `psql`; the normal runtime image does not. RDS manages the owner password in Secrets Manager. The one-off migration task:

1. connects using the RDS-managed owner credential;
2. applies the canonical ledger-backed migrations;
3. assigns independent generated LOGIN passwords to `airs_app` and `airs_maintenance`;
4. verifies migration status;
5. allows the live ECS services to start only after successful completion.

Production never runs `db/seed/demo_orgs.sql`.

## Deployment sequence

1. Review and merge PR #2 to `main` after checks pass.
2. Run **AIRS Production Deploy** with the AIRS member account ID and `activate_services=false`.
3. Provision the infrastructure with live services stopped.
4. Build and push immutable runtime/ops images.
5. Run the production migration/bootstrap task.
6. Add the ACM validation CNAME in Cloudflare and wait for ACM to report `ISSUED`.
7. Point `app.airsagent.com` to the ALB as DNS-only.
8. Run **AIRS Production Deploy** again with `activate_services=true`.
9. Wait for both the AIRS application and maintenance ECS services to stabilize.
10. Validate health, Cognito/TOTP login, tenant/RLS isolation, audit behavior, maintenance, mapping, and the operational acceptance scenarios.
