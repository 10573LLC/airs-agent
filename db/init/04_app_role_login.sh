#!/bin/sh
# Container-only bootstrap: give the unprivileged application role a login
# password taken from the APP_DB_PASSWORD environment variable. No secret is
# ever committed to the repository.
set -e
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set for the db container}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
ALTER ROLE airs_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
SQL
