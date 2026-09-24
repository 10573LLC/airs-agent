#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
AIRS now deploys directly into the authenticated traditional AWS account to
mirror the production architecture that was prepared in the previously blocked
AWS account.

Do not create an Organizations member account for the current deployment.

Run instead:

  bash infra/bootstrap/aws-bootstrap.sh

The script discovers the current AWS account ID automatically.
EOF

exit 2
