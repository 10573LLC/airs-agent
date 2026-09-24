#!/usr/bin/env bash
set -euo pipefail

ACCOUNT_ID="${AIRS_AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="us-east-2"
ROLE_NAME="AIRSAgentGitHubDeployRole"
STATE_BUCKET="airs-agent-tfstate-${ACCOUNT_ID}"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

test "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT_ID" || {
  echo "Refusing: authenticated AWS account does not match AIRS_AWS_ACCOUNT_ID=$ACCOUNT_ID" >&2
  exit 2
}

if ! aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null; then
  aws s3api create-bucket \
    --bucket "$STATE_BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

aws s3api put-public-access-block \
  --bucket "$STATE_BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$STATE_BUCKET" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
fi

sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" infra/bootstrap/github-oidc-trust.json > /tmp/airs-github-trust.json
sed "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" infra/bootstrap/github-deploy-policy.json > /tmp/airs-github-policy.json

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document file:///tmp/airs-github-trust.json
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document file:///tmp/airs-github-trust.json >/dev/null
fi

POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/AIRSAgentGitHubDeployPolicy"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  # IAM retains at most five managed-policy versions. Delete every old
  # non-default version before creating the next version so repeated,
  # idempotent bootstrap runs never hit that quota.
  for OLD in $(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query "Versions[?IsDefaultVersion==\`false\`].VersionId" --output text); do
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD"
  done

  VERSION_ID=$(aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document file:///tmp/airs-github-policy.json \
    --set-as-default \
    --query 'PolicyVersion.VersionId' \
    --output text)

  # The prior default is now non-default; keep only the new default.
  for OLD in $(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query "Versions[?IsDefaultVersion==\`false\`].VersionId" --output text); do
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD"
  done
  echo "Updated deployment policy to version $VERSION_ID"
else
  aws iam create-policy \
    --policy-name AIRSAgentGitHubDeployPolicy \
    --policy-document file:///tmp/airs-github-policy.json >/dev/null
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"

echo "AIRS AWS bootstrap complete"
echo "Account: $ACCOUNT_ID"
echo "State: s3://$STATE_BUCKET"
echo "Role: arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"
