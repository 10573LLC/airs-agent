# AIRS Agent — Local setup

Requirements: Node.js 22+ (or Bun), Docker (optional), PostgreSQL 16 (or use Docker).

## 1. Clone and install

```bash
git clone <your-github-repo-url> airs-agent
cd airs-agent
npm install        # or: bun install
cp .env.example .env
```

## 2. Database

With Docker:

```bash
docker compose up -d db     # applies db/migrations/* and db/seed/* on first start
```

Without Docker, against an existing PostgreSQL:

```bash
createdb airs
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_roles_seed.sql
psql "$DATABASE_URL" -f db/seed/demo_orgs.sql
```

Give the app role a login for local use:

```sql
ALTER ROLE airs_app LOGIN PASSWORD 'localdev';
-- then: DATABASE_URL=postgres://airs_app:localdev@localhost:5432/airs
```

Never connect the application as a superuser or as the schema owner — RLS would be bypassed.

## 3. Run

```bash
npm run dev        # http://localhost:8080
npm run test       # vitest
npm run build      # production build to .output/
```

Verify the database wiring:

```bash
curl localhost:8080/api/public/health
# {"status":"ok","database":"reachable"}  (503 when DATABASE_URL is unset/unreachable)
```

Verify tenant isolation:

```bash
psql "$DATABASE_URL" -f db/tests/rls_isolation.sql
```

## 4. Full stack in Docker

```bash
docker compose up --build     # app on :3000, postgres on :5432
```

The image runs `node .output/server/index.mjs` — no Lovable services involved.
**NOT YET VERIFIED:** the Docker build has not been executed in this environment (no Docker daemon
available during stage 1). Treat `docker compose up --build` as unproven until you run it once.

## 5. Environment variables

See `.env.example`. `DATABASE_URL` and `DB_DRIVER` are the only ones consumed by code today;
the rest are placeholders for adapters that are not yet implemented.
## Foundation Portability Verification — 2026-07-29

### 0. Clean install from GitHub only (new machine, no builder session)

```bash
# 1. clone                        [NOT VERIFIED here — this sandbox is the working tree]
git clone https://github.com/anconison/airs-agent.git && cd airs-agent
# 2. install                      [NOT VERIFIED from a clean cache]
npm install --legacy-peer-deps
# 3. environment
cp .env.example .env && ${EDITOR:-nano} .env
# 4. PostgreSQL 16                [VERIFIED on 17.9 locally; 16 NOT VERIFIED]
docker run -d --name airs-pg -e POSTGRES_USER=airs_owner -e POSTGRES_PASSWORD=localdev \
  -e POSTGRES_DB=airs -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgres://airs_owner:localdev@localhost:5432/airs
# 5. migrations                   [VERIFIED]
npm run db:migrate
# 6. seed                         [VERIFIED]
npm run db:seed
psql "$DATABASE_URL" -c "ALTER ROLE airs_app LOGIN PASSWORD 'localdev'"
# 7. tests                        [VERIFIED — 14/14 unit, 47/47 RLS]
npm run test && npm run db:test
# 8. build                        [VERIFIED]
npm run build
# 9. start                        [VERIFIED]
DATABASE_URL=postgres://airs_app:localdev@localhost:5432/airs PORT=3000 node .output/server/index.mjs
# 10. health                      [VERIFIED — 200 {"status":"ok","database":"reachable"}]
curl -s localhost:3000/api/public/health
```

### Docker — NOT VERIFIED

No Docker daemon exists in the build environment. Verify independently:

```bash
cp .env.example .env   # set POSTGRES_PASSWORD and APP_DB_PASSWORD
docker compose build
docker compose up -d
docker compose ps           # app container must report (healthy)
curl -s localhost:3000/api/public/health
```

The app image runs as the non-root `node` user and has a container `HEALTHCHECK`. Database init
files are mounted individually into `/docker-entrypoint-initdb.d/` (mounted *directories* are
ignored by the postgres entrypoint — the previous compose file therefore never applied migrations).

## Build targets (why `vite.config.ts` branches)

`vite.config.ts` selects a Nitro preset from the environment. Nothing needs to be installed or
configured for this — it is stock Vite/Nitro configuration and no builder package is a dependency.

| Environment | Detected by | Preset | Output | Run with |
| --- | --- | --- | --- | --- |
| Your machine, CI, Docker (**default**) | neither variable set | `node-server` | `.output/` | `node .output/server/index.mjs` |
| Hosted Lovable editor preview only | `LOVABLE_SANDBOX=1` or `DEV_SERVER__PROJECT_PATH` set | `cloudflare-module` | `dist/client` + `dist/server` | managed by the editor |

Force either target explicitly with `NITRO_PRESET`, which overrides the detection:

```bash
NITRO_PRESET=node-server npm run build      # portable Node build (what the Dockerfile does)
```

After cloning this repository outside Lovable, neither variable exists, so `npm run build` always
produces the portable Node server. `dist/` and `.wrangler/` are git-ignored and never committed.

## Running the authentication tests (2026-07-30)

```bash
# 1. schema + demo organizations
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/airs"
npm run db:migrate      # 0001 -> 0004
npm run db:seed

# 2. give the unprivileged application role a login
psql "$DATABASE_URL" -c "ALTER ROLE airs_app LOGIN PASSWORD 'choose-a-password';"

# 3. RLS proofs (matrix + role parity + identity plane)
npm run db:test

# 4. unit + integration tests
export TEST_DATABASE_URL="postgres://airs_app:choose-a-password@127.0.0.1:5432/airs"
export TEST_ADMIN_DATABASE_URL="$DATABASE_URL"
npm test
```

`npm test` without `TEST_DATABASE_URL` still runs the unit suites and skips the database-backed
tests. The application itself must be started with `DATABASE_URL` pointing at the **airs_app**
role — never at a superuser or the table owner, or RLS would be bypassed.

### Which role runs which suite (2026-08-02)

`db/tests/auth_rls.sql` builds its fixtures **before** it does `SET ROLE airs_app`, so it must be
invoked with the migration/owner DSN (`$DATABASE_URL`, as `npm run db:test` does). Running it
directly as `airs_app` fails at the fixture stage with
`new row violates row-level security policy for table "accounts"` — that is FORCE RLS working as
designed, not a defect. The assertions themselves still execute as `airs_app`; the script asserts
that role has neither SUPERUSER nor BYPASSRLS.

## Running the expiration sweep locally

The sweep runs as the dedicated `airs_maintenance` role, never as the application role. Give that
role a password once (already handled inside the compose stack by
`db/init/05_maintenance_role_login.sh`):

```bash
psql "$OWNER_DATABASE_URL" -c "ALTER ROLE airs_maintenance LOGIN PASSWORD 'choose-one';"
export AIRS_MAINTENANCE_DATABASE_URL="postgres://airs_maintenance:choose-one@localhost:5432/airs"
npm run maintenance:expire-incidents   # structured JSON log, exits 0
```

Exit code 0 means the sweep ran, or that another runner held the lock. Exit code 1 means a
configuration, connection or database failure; the reason is printed as JSON on stderr and, when the
connection succeeded, recorded as `maintenance.expiration_failed`.

Point it at the application role to see the privilege boundary working:

```bash
AIRS_MAINTENANCE_DATABASE_URL="postgres://airs_app:…@localhost:5432/airs" \
  npm run maintenance:expire-incidents
# → {"event":"maintenance.expiration_failed","errorClass":"database",
#    "message":"permission denied for function record_maintenance_event"}  (exit 1)
```

Scheduling options, all equivalent and all optional:

```
crontab            */5 * * * * cd /srv/airs && npm run maintenance:expire-incidents
systemd timer      same command, OnUnitActiveSec=5min
Kubernetes         CronJob running node scripts/expire-incident-state.mjs
docker compose     the bundled expiration-scheduler service
in-database        psql -f db/scheduler/pg_cron.sql   (only where pg_cron exists)
```

To exercise the optional HTTP path, enable it and set a secret of at least 24 characters:

```bash
export AIRS_MAINTENANCE_ENDPOINT_ENABLED=true
export AIRS_MAINTENANCE_SECRET="$(openssl rand -hex 32)"
npm run build && node .output/server/index.mjs
curl -X POST -H "authorization: Bearer $AIRS_MAINTENANCE_SECRET" \
  http://localhost:3000/api/maintenance/expire-incidents
```

Left disabled it answers 404; enabled without a secret it answers 503. Both are by design.

Review recent runs at any time:

```bash
psql "$AIRS_MAINTENANCE_DATABASE_URL" -c "SELECT * FROM airs.maintenance_expiration_status()"
``` Verify brand assets any time with
`npm run brand:verify`.
