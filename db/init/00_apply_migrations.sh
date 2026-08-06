#!/bin/sh
# Fresh-database initialization for the Docker Compose `db` service.
#
# Reads the ONE canonical manifest (db/migrations/manifest.txt) that
# scripts/lib/migrate-plan.mjs reads, applies each migration in order inside its
# own transaction, and records it in the same persistent ledger
# (airs_migrations.applied_migrations) with the same SHA-256 checksum rule.
# Starting the application afterwards therefore reports zero pending migrations
# and never replays anything.
set -e

DB_DIR=/airs-db
PSQL="psql -v ON_ERROR_STOP=1 -q --username $POSTGRES_USER --dbname $POSTGRES_DB"

# PostGIS preflight. Migrations 0009/0010 require it; failing here with an
# actionable message is far better than failing mid-migration with
# `extension "postgis" is not available` or `type public.geometry does not exist`.
if ! $PSQL -tAc "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'" | grep -q 1; then
  echo "airs: FATAL - PostGIS is not available in this PostgreSQL image." >&2
  echo "airs: use postgis/postgis:16-3.5-alpine (see docker-compose.yml); the plain" >&2
  echo "airs: postgres:16-alpine image cannot run migrations 0009 and 0010." >&2
  exit 1
fi
echo "airs: enabling PostGIS before any migration runs"
$PSQL -c "CREATE EXTENSION IF NOT EXISTS postgis"
$PSQL -tAc "SELECT postgis_full_version()"

echo "airs: creating the migration ledger"
$PSQL -f "$DB_DIR/ledger/0000_migration_ledger.sql"

while IFS= read -r name; do
  case "$name" in ''|\#*) continue ;; esac
  file="$DB_DIR/migrations/$name"
  version=$(printf '%s' "$name" | cut -c1-4)
  checksum=$(sha256sum "$file" | cut -d' ' -f1)
  echo "airs: applying migration $version ($name)"
  # One transaction per migration: the file's own BEGIN/COMMIT plus the ledger
  # insert, which only runs when the migration itself succeeded.
  $PSQL -f "$file"
  $PSQL -c "SELECT airs_migrations.record_applied('$version', '$name', '$checksum', 0, 'docker-init', NULL, false);"
done < "$DB_DIR/migrations/manifest.txt"

echo "airs: all migrations applied and recorded in airs_migrations.applied_migrations"
