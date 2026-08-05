#!/bin/sh
# Container-only bootstrap: give the dedicated maintenance role a login
# password taken from MAINTENANCE_DB_PASSWORD. Kept separate from the
# application password so the scheduler credential can be rotated on its own
# and never grants application access. No secret is committed to the repository.
set -e
: "${MAINTENANCE_DB_PASSWORD:?MAINTENANCE_DB_PASSWORD must be set for the db container}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
ALTER ROLE airs_maintenance LOGIN PASSWORD '${MAINTENANCE_DB_PASSWORD}';
SQL
