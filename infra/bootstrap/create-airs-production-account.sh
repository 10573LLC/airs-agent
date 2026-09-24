#!/usr/bin/env bash
set -euo pipefail

MANAGEMENT_ACCOUNT_ID="509581811007"
ACCOUNT_NAME="AIRS Production"
ACCOUNT_EMAIL="${1:-developer+airs-prod@10573llc.com}"
MEMBER_ROLE="OrganizationAccountAccessRole"

test "$(aws sts get-caller-identity --query Account --output text)" = "$MANAGEMENT_ACCOUNT_ID" || {
  echo "Run this only from the 10573 LLC Organizations management account." >&2
  exit 2
}

ROOT_ID=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
OU_ID=$(aws organizations list-organizational-units-for-parent \
  --parent-id "$ROOT_ID" \
  --query "OrganizationalUnits[?Name=='Production'].Id | [0]" \
  --output text)

if [ "$OU_ID" = "None" ] || [ -z "$OU_ID" ]; then
  OU_ID=$(aws organizations create-organizational-unit \
    --parent-id "$ROOT_ID" \
    --name Production \
    --tags Key=Owner,Value=10573LLC \
    --query 'OrganizationalUnit.Id' \
    --output text)
fi

ACCOUNT_ID=$(aws organizations list-accounts \
  --query "Accounts[?Name=='$ACCOUNT_NAME' && State=='ACTIVE'].Id | [0]" \
  --output text)

if [ "$ACCOUNT_ID" = "None" ] || [ -z "$ACCOUNT_ID" ]; then
  REQUEST_ID=$(aws organizations create-account \
    --email "$ACCOUNT_EMAIL" \
    --account-name "$ACCOUNT_NAME" \
    --role-name "$MEMBER_ROLE" \
    --tags Key=Owner,Value=10573LLC Key=Application,Value=AIRS-Agent Key=Environment,Value=Production \
    --query 'CreateAccountStatus.Id' \
    --output text)

  echo "Creating AIRS Production member account..."
  while true; do
    STATE=$(aws organizations describe-create-account-status \
      --create-account-request-id "$REQUEST_ID" \
      --query 'CreateAccountStatus.State' \
      --output text)
    case "$STATE" in
      SUCCEEDED)
        ACCOUNT_ID=$(aws organizations describe-create-account-status \
          --create-account-request-id "$REQUEST_ID" \
          --query 'CreateAccountStatus.AccountId' \
          --output text)
        break
        ;;
      FAILED)
        aws organizations describe-create-account-status --create-account-request-id "$REQUEST_ID"
        exit 3
        ;;
      *)
        sleep 10
        ;;
    esac
  done
fi

CURRENT_PARENT=$(aws organizations list-parents --child-id "$ACCOUNT_ID" --query 'Parents[0].Id' --output text)
if [ "$CURRENT_PARENT" != "$OU_ID" ]; then
  aws organizations move-account \
    --account-id "$ACCOUNT_ID" \
    --source-parent-id "$CURRENT_PARENT" \
    --destination-parent-id "$OU_ID"
fi

echo "$ACCOUNT_ID" > infra/aws-account-id.txt
echo "AIRS Production account: $ACCOUNT_ID"
echo "Root email: $ACCOUNT_EMAIL"
echo "Production OU: $OU_ID"

for attempt in $(seq 1 60); do
  if CREDS=$(aws sts assume-role \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${MEMBER_ROLE}" \
    --role-session-name airs-bootstrap \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
    --output text 2>/dev/null); then
    read -r ACCESS_KEY SECRET_KEY SESSION_TOKEN <<< "$CREDS"
    AIRS_AWS_ACCOUNT_ID="$ACCOUNT_ID" \
    AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
    AWS_SESSION_TOKEN="$SESSION_TOKEN" \
      bash infra/bootstrap/aws-bootstrap.sh
    echo "AIRS_PRODUCTION_ACCOUNT_READY=$ACCOUNT_ID"
    exit 0
  fi
  sleep 10
done

echo "Account exists, but the member access role was not assumable yet." >&2
echo "Re-run this script; it is idempotent." >&2
exit 4
