#!/usr/bin/env bash
set -euo pipefail
ACCOUNT_ID="509581811007"
REGION="us-east-2"
ROLE_NAME="AIRSAgentGitHubDeployRole"
STATE_BUCKET="airs-agent-tfstate-${ACCOUNT_ID}"

test "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT_ID" || {
  echo "Refusing: wrong AWS account" >&2
  exit 2
}

if ! aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$STATE_BUCKET" --region "$REGION"     --create-bucket-configuration LocationConstraint="$REGION"
fi

aws s3api put-public-access-block --bucket "$STATE_BUCKET" --public-access-block-configuration   BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$STATE_BUCKET" --server-side-encryption-configuration   '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/AIRSAgentGitHubDeployPolicy"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  aws iam create-policy --policy-name AIRSAgentGitHubDeployPolicy     --policy-document file://infra/bootstrap/github-deploy-policy.json >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"

echo "AIRS AWS bootstrap complete"
echo "State: s3://$STATE_BUCKET"
echo "Role: arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"
