#!/bin/sh
# Production database bootstrap for the explicit one-off ECS migration task.
# Secrets arrive through ECS/Secrets Manager environment variables and are never printed.
set -eu

: "${AIRS_BOOTSTRAP_DATABASE_URL:?missing owner connection}"
: "${PGPASSWORD:?missing RDS owner password}"
: "${APP_DB_PASSWORD:?missing app role password}"
: "${MAINTENANCE_DB_PASSWORD:?missing maintenance role password}"

export DATABASE_URL="$AIRS_BOOTSTRAP_DATABASE_URL"

# The RDS-managed owner password is supplied through PGPASSWORD. The URL stays
# password-free so it is safe to pass as a normal ECS environment value.
npm run db:migrate

# Migrations create the runtime roles without application passwords. Enable
# login only after the canonical ledger-backed migration set succeeds.
psql "$AIRS_BOOTSTRAP_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=maintenance_password="$MAINTENANCE_DB_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE airs_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('ALTER ROLE airs_maintenance LOGIN PASSWORD %L', :'maintenance_password') \gexec
SQL

npm run db:migrate:status
echo "AIRS_PRODUCTION_DATABASE_BOOTSTRAP_SUCCESS"
