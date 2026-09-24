# AIRS Agent AWS production infrastructure

Primary region: `us-east-2` (Ohio)

This deployment assumes the traditional AWS account model:

- the new 10573 LLC account is the AWS Organizations **management account**
- **AIRS Production** is a separate member account
- TRACE will later receive its own member account
- AWS Organizations itself has no additional charge; only resources running inside the accounts are billed

## Cost-conscious launch profile

The initial AIRS production profile is intentionally lean because this account does not have promotional credits:

- one AIRS Fargate task, not two
- 0.25 vCPU / 1 GiB task size
- the maintenance runner is a sidecar in the same Fargate task instead of a second always-on service
- ECS uses a public IPv4 address for outbound access, but its security group permits inbound port 3000 **only from the ALB**
- no NAT gateways and no paid interface VPC endpoints
- PostgreSQL 16 RDS starts as `db.t4g.micro`, Single-AZ, 20 GiB gp3, 7-day backups
- RDS remains private, encrypted, TLS-only, and deletion-protected
- CloudWatch log retention is 30 days and Container Insights is disabled initially
- one public ALB provides HTTPS, health checks, and stable routing
- monthly budget alert defaults to USD 75; it is an alert, not a shutdown mechanism

The lean profile is appropriate for launch/validation and low traffic. Multi-AZ RDS, a second application task, private ECS subnets with NAT, and richer observability can be enabled later when availability requirements justify their cost.

## Create the AIRS member account

After the new traditional AWS account is fully activated, secure the management-account root user with MFA and create an AWS Organization with all features enabled.

Create a unique, monitored root email alias such as `aws-airs@10573llc.com`, then from management-account CloudShell:

```sh
git clone https://github.com/10573LLC/airs-agent.git
cd airs-agent
git checkout task/aws-prod-us-east-2-20260923
bash infra/bootstrap/create-airs-production-account.sh aws-airs@10573llc.com
```

The script creates/reuses a `Production` OU, creates/reuses the `AIRS Production` member account, assumes `OrganizationAccountAccessRole`, and bootstraps GitHub OIDC plus Terraform state inside the AIRS account.

It prints:

`AIRS_PRODUCTION_ACCOUNT_READY=<12-digit-account-id>`

Creating the organization, OU, and member account does not itself create workload charges.

## Production topology

Internet → HTTPS ALB → one ECS/Fargate task → private RDS PostgreSQL.

The ECS task contains two containers:

- `app`: AIRS Node/Nitro service on port 3000
- `maintenance`: the incident-expiration runner using the dedicated `airs_maintenance` database role

The task receives a public IPv4 address only for outbound internet/AWS API access. Its security group does not permit inbound internet traffic; port 3000 accepts traffic only from the ALB security group. RDS remains in private subnets and accepts PostgreSQL only from the ECS security group.

Avoiding NAT gateways is deliberate: AWS charges NAT Gateway by the hour plus data processing.

## Deployment sequence

1. Review and merge PR #2 to `main` after checks pass.
2. Run **AIRS Production Deploy** with the AIRS member account ID and `activate_services=false`.
3. The workflow provisions the foundation, requests ACM, builds/pushes immutable images, and runs the database migration/bootstrap task while the live AIRS service remains stopped.
4. Add the ACM validation CNAME in Cloudflare and wait for ACM to report `ISSUED`.
5. Point `app.airsagent.com` to the ALB as DNS-only.
6. Run **AIRS Production Deploy** again with `activate_services=true`.
7. Validate health, Cognito/TOTP login, tenant/RLS isolation, audit behavior, maintenance, mapping, and the operational acceptance scenarios.

## Scaling later

When AIRS has real production demand, increase availability deliberately:

- `desired_count = 2`
- `db_multi_az = true`
- increase RDS class from `db.t4g.micro`
- move ECS back to private subnets and add per-AZ egress if the risk/cost tradeoff warrants it
- enable Container Insights or other monitoring when the operational value justifies the telemetry cost

Fargate has no upfront cost and bills requested CPU/memory while tasks run; 0.25 vCPU supports 0.5–2 GiB memory.
