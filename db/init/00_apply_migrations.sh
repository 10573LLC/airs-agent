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
