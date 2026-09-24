#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
This repository is deployed from the AWS "projects" experience.

Do not create an Organizational Unit or member account with AWS Organizations CLI.
In the new AWS experience, create the AIRSProduction project in AWS Settings.
Each project already contains its own AWS account, while AWS manages the
organization management account and its human-access controls.

After opening the AIRSProduction project in the AWS Management Console:

  aws sts get-caller-identity --query Account --output text
  export AIRS_AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  bash infra/bootstrap/aws-bootstrap.sh

See infra/README.md.
EOF

exit 2
