# AIRS Agent AWS production infrastructure

Target AWS account: `509581811007`
Primary region: `us-east-2` (Ohio)

This directory is the reproducible production deployment definition for AIRS Agent. It does not reuse the legacy AWS account.

## Guardrails

- GitHub authenticates with AWS OIDC; no long-lived AWS access keys.
- The GitHub role is repository-scoped to `10573LLC/airs-agent`.
- AIRS gets dedicated networking, database, secrets, task roles, security groups, ECR and logs.
- TRACE must use a separate application stack and database.
- Production database deletion protection stays enabled.
- Infrastructure changes are planned before apply.

## Bootstrap

The GitHub OIDC provider and `AIRSAgentGitHubDeployRole` already exist.
Run `infra/bootstrap/aws-bootstrap.sh` once from an authenticated shell in account 509581811007.
It creates private Terraform state storage and attaches the AIRS deployment policy to the existing role.

## Region

The new AWS organization currently permits normal workload deployment in `us-east-2`. The Fargate canary completed successfully there with exit code 0 and emitted `FARGATE_CANARY_SUCCESS`.
