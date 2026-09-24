# AIRS Agent AWS production infrastructure

Primary region: `us-east-2` (Ohio)

This deployment intentionally mirrors the production architecture that was prepared in the earlier AWS account before ECS/Fargate `RunTask` was blocked.

## Account model

For the current deployment, the new traditional AWS account itself is the AIRS production account. This matches the blocked-account setup and avoids adding Organizations/member-account complexity before it is needed.

TRACE will remain logically isolated with its own ECR, ECS, RDS, secrets, security groups, logs, and roles. It can be moved to a separate AWS account later if desired.

## One-time bootstrap

From CloudShell in the new traditional AWS account:

```sh
git clone https://github.com/10573LLC/airs-agent.git
cd airs-agent
git checkout task/aws-prod-us-east-2-20260923
git pull --ff-only
bash infra/bootstrap/aws-bootstrap.sh
```

The script discovers the current account ID automatically and creates only the deployment control plane:

- private encrypted/versioned Terraform-state bucket
- GitHub OIDC provider
- repository/main-branch-scoped `AIRSAgentGitHubDeployRole`
- AIRS deployment policy

It does **not** create the VPC, NAT gateways, RDS, ECS, ALB, Cognito, or any other workload resource.

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

- VPC CIDR `10.20.0.0/16`
- two public and two private subnets across two Availability Zones
- same-AZ NAT gateways for private-task outbound internet access
- interface endpoints for ECR API, ECR Docker, CloudWatch Logs, and Secrets Manager
- S3 gateway endpoint
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

This account does not rely on promotional credits. The architecture is monitored rather than silently redesigned.

The default AWS Budget target is USD 275/month. It sends a forecast alert at 75%, an actual-cost alert at 90%, and an actual-cost alert at 100%. The alerts never stop AIRS automatically.

The preserved topology has several always-on billable components, especially NAT gateways, interface endpoints, ALB, RDS, and Fargate. It can exceed USD 75/month depending on runtime and traffic. The USD 275 target is sized to the estimated steady-state production architecture with modest traffic and includes headroom above the expected baseline. Cost reductions will be proposed explicitly rather than changing the architecture without approval.

## Security groups

- ALB: inbound 80/443 from the internet; outbound 3000 only to AIRS ECS
- ECS: inbound 3000 only from the ALB
- RDS: inbound 5432 only from ECS
- VPC endpoints: inbound 443 only from ECS
- RDS remains `Public access: No`
- ECS tasks remain in private subnets with public IP assignment disabled

## Deployment sequence

1. Review and merge PR #2 to `main` after checks pass.
2. Run **AIRS Production Deploy** with this AWS account ID and `activate_services=false`.
3. Provision infrastructure with live services stopped.
4. Build and push immutable runtime/ops images.
5. Run the production migration/bootstrap task.
6. Add the ACM validation CNAME in Cloudflare and wait for ACM to report `ISSUED`.
7. Point `app.airsagent.com` to the ALB as DNS-only.
8. Run **AIRS Production Deploy** again with `activate_services=true`.
9. Wait for both AIRS application and maintenance ECS services to stabilize.
10. Validate health, Cognito/TOTP login, tenant/RLS isolation, audit behavior, maintenance, mapping, and the operational acceptance scenarios.
