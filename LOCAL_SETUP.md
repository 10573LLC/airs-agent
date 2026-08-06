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

## 4b. First platform administrator (operator-only)

The AIRS Agent platform owner is **not** an agency account. Provision it with the
one setup command below; it validates the environment, applies nothing it does not
have to, and prints a single-use activation URL to your terminal only.

```bash
export AIRS_BOOTSTRAP_DATABASE_URL="postgresql://USERNAME:PASSWORD@localhost:5432/airs_agent"
export AIRS_PUBLIC_BASE_URL="http://localhost:3000"
npm run platform-admin:setup -- --email wflack@anconisonpmg.com
```

### Windows PowerShell

```powershell
$env:AIRS_BOOTSTRAP_DATABASE_URL="postgresql://USERNAME:PASSWORD@localhost:5432/airs_agent"
$env:AIRS_PUBLIC_BASE_URL="http://localhost:3000"
npm run platform-admin:setup -- --email wflack@anconisonpmg.com
```

Or use the wrapper, which also clears the connection string from the session afterwards:

```powershell
.\scripts\platform-admin-setup.ps1 -Email wflack@anconisonpmg.com
.\scripts\platform-admin-setup.ps1 -Email wflack@anconisonpmg.com -ApplyMigrations
.\scripts\platform-admin-setup.ps1 -Email wflack@anconisonpmg.com -NewLink
```

If your PostgreSQL runs in the bundled Docker container, the host URL is the same
(`localhost:5432`), and the operator role is the database owner/superuser — **not**
`airs_app`. The bootstrap routines are deliberately not executable by the
application role.

What the command does, in order, exiting non-zero on the first failure:

1. confirms `AIRS_BOOTSTRAP_DATABASE_URL` and `AIRS_PUBLIC_BASE_URL` are set;
2. connects and reports the PostgreSQL version;
3. confirms migrations through `0011_platform_administration.sql` are applied
   (add `--apply-migrations` to run `npm run db:migrate` — the established runner —
   when they are not);
4. confirms the `anconison-platform` organization and the `platform_admin` role exist;
5. confirms `platform_admin` holds **no** incident, resource, map, observation,
   airspace, personnel, qualification or aircraft permission;
6. reports whether the address already exists as an account, membership,
   invitation, agency user record or active session (aggregates only);
7. stops with "already provisioned" if a platform membership exists — no duplicate
   account and no duplicate membership is ever created;
8. reuses a still-valid pending invitation (tokens are stored hashed and cannot be
   reprinted; pass `--new-link` to revoke it and mint a fresh one), and revokes and
   replaces expired or unusable ones;
9. creates exactly one pending, single-use, expiring invitation, sending only the
   token's SHA-256 hash to the database;
10. prints the activation URL and its expiry to the terminal, then closes the
    connection.

Useful flags: `--report-only` (all checks, issues nothing), `--ttl <seconds>`
(300–604800, default 259200 = 72 h), `--new-link`, `--apply-migrations`.

The command is idempotent: repeated runs never produce a second account, a second
membership, or a second usable invitation.

The recipient opens the URL, sets a password (PBKDF2-SHA256), and thereafter signs
in normally at `/auth`. The token appears in no log, no audit record and no file —
if it scrolls out of the buffer, run again with `--new-link`. Never commit a real
database URL or activation URL.

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

## Running the Stage 8 (Awareness) verification

Stage 8 needs PostGIS, because observations resolve against the same geography
plane as the Common Operating Picture.

```bash
# 1. schema 0001 -> 0010 plus demo organizations, on an empty database
for f in db/migrations/*.sql db/seed/demo_orgs.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done

# 2. SQL assertions (includes db/tests/awareness_observations_rls.sql, 99 of them)
npm run db:test              # 408 assertions total

# 3. TypeScript suites
export TEST_DATABASE_URL="postgres://airs_app:localdev@127.0.0.1:5432/airs"
export TEST_ADMIN_DATABASE_URL="$DATABASE_URL"
npm test                     # 7 files, 124 passed, 4 skipped
```

### Repeatable runs (no rebuild between runs)

Steps 2 and 3 can be repeated against the same database indefinitely. Each
TypeScript suite tags its fixtures with a per-run identifier and removes them in
`afterAll` via `tests/support/fixtures.ts`; the SQL suites build and assert
against their own fixtures. After any cycle the database is back to the seeded
state (2 organizations, no accounts, memberships, observations, audit events or
trusted-agency rows).

Two requirements for this to work:
- `TEST_ADMIN_DATABASE_URL` must point at the fixture owner (the role that owns
  the `airs` schema). Cleanup deletes append-only rows and needs that privilege.
- Do not re-enable Vitest file parallelism. `vitest.config.ts` sets
  `fileParallelism: false` on purpose: the suites share the two demo
  organizations, and concurrent files would race on shared-row restoration.

If the suite ever fails on a count assertion, that is a cleanup regression, not
a flake — check `afterAll` ran rather than rebuilding the database.


## Bootstrapping the platform administrator (2026-08-05)

The first Anconison platform administrator is created out of band, by an operator with a database
owner connection. The application cannot do this for itself by design.

```bash
export AIRS_BOOTSTRAP_DATABASE_URL=postgres://postgres:...@localhost:5432/airs
export APP_BASE_URL=https://your-deployment.example.gov

# Optional dry run: what already exists for these addresses?
npm run bootstrap:platform-admin -- --report-only --check owner@example.gov

# Issue the single-use link (default lifetime 72 hours)
npm run bootstrap:platform-admin -- --email owner@example.gov --ttl 259200
```

The command prints one activation link. Deliver it out of band and do not paste it into tickets,
chat, screenshots or version control — it is a credential until it is redeemed or expires. Running
the command again revokes the previous pending link.

The recipient opens the link, sets a display name and a password of at least 12 characters, and is
signed in as `platform_admin` of the Anconison platform organization. From then on they
authenticate normally at `/auth`. If an account for that address already exists, the CLI prints an
`/invite/...` link instead and the recipient signs in first.

---

## 9. Windows (verified sequence) — Windows Bootstrap Hardening

This is the sequence actually used to activate the first real platform administrator
on Windows with Docker Desktop. It requires **no host-installed `psql`**.

1. **Install Git for Windows.** Keep the default checkout behaviour; the
   repository ships a `.gitattributes` that forces LF for every `*.sh` file, so
   the PostgreSQL container init scripts never arrive as CRLF
   (`/bin/sh^M: bad interpreter`).
2. **Install Node.js 22+.**
3. **Install Docker Desktop.**
4. **Install and initialize WSL 2** (`wsl --install`), then confirm Docker Desktop
   is using the WSL 2 backend.
5. **Clone the repository.**
   ```powershell
   git clone https://github.com/anconison/airs-agent.git
   cd airs-agent
   ```
6. **Install dependencies.**
   ```powershell
   npm install
   ```
   Do **not** run `npm audit fix` (especially `--force`) automatically — review each
   advisory first; it can silently change major versions of build-critical packages.
7. **Configure the three required local database passwords** in `.env`
   (copy from `.env.example`): `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`,
   `MAINTENANCE_DB_PASSWORD`. Never commit `.env`.
8. **Start the database service only.**
   ```powershell
   docker compose up -d db
   ```
9. **Run migrations without host `psql`.**
   ```powershell
   npm run db:migrate
   ```
   The runner uses a local `psql` when one is on `PATH`; otherwise it detects the
   running Compose `db` service and applies each migration in order through
   `docker compose exec -T db psql -v ON_ERROR_STOP=1`. If neither is available it
   prints an actionable error and exits nonzero — it never starts or deletes
   containers for you.
10. **Start the application service.**
    ```powershell
    docker compose up -d app
    ```
11. **Generate (or replace) the platform-admin invitation.**
    ```powershell
    $env:AIRS_BOOTSTRAP_DATABASE_URL = "postgres://airs_owner:<POSTGRES_PASSWORD>@localhost:5432/airs"
    $env:AIRS_PUBLIC_BASE_URL = "http://localhost:3000"
    npm run platform-admin:setup -- --help
    npm run platform-admin:setup -- --email wflack@anconisonpmg.com
    # replace an exposed/unusable link:
    npm run platform-admin:setup -- --email wflack@anconisonpmg.com --new-link
    ```
12. **Activate the account** by opening the one-time URL printed in that terminal
    and setting a password. The account does not exist until activation completes.
13. **Sign in** at `http://localhost:3000/auth`.
14. **Stop containers without deleting data.**
    ```powershell
    docker compose stop        # or: docker compose down   (keeps the volume)
    ```

### Warnings

- `docker compose down -v` **deletes the local database volume** and every local
  account, membership, incident and audit row with it.
- Activation URLs must never be screenshotted, pasted into chat, or shared. They
  are single-use and expiring, but a leaked link is a live credential until used.
- If an activation URL is exposed, immediately re-run the setup command with
  `--new-link`; the previous pending invitation is revoked at once.
- Do not run `npm audit fix` automatically without reviewing the changes.

### Line-ending check

```bash
npm run check:line-endings   # fails when any tracked *.sh file contains CRLF
```
If a CRLF copy ever lands in a working tree: `git add --renormalize .`

# Migrations: pending-only execution and adoption

## Migration state: the persistent ledger

Migration state lives in its own schema, created by `db/ledger/0000_migration_ledger.sql`
before anything is inspected or applied:

| Column | Meaning |
| --- | --- |
| `version` | Four-digit migration version, primary key (`0001` … `0012`) |
| `filename` | Migration filename, unique |
| `checksum` | SHA-256 over the raw migration file bytes |
| `applied_at` | Timestamp of the successful transaction |
| `duration_ms` | Execution duration |
| `runner_version` | Migration-runner version (optional) |
| `app_release` | Application release / Git commit, from `AIRS_APP_RELEASE` (optional) |
| `adopted` | True when the row was recorded by the explicit adoption command |

Access model: `airs_app` has no read, write or execute access (schema USAGE revoked);
`airs_maintenance` has none either, so it can never modify migration state; the schema is
owned by the migration/database owner and sits outside the `airs` tenant schema. Applied rows
are immutable — a `BEFORE UPDATE OR DELETE` trigger raises `AIRS_LEDGER_IMMUTABLE`. No
application code references `airs_migrations`, so normal traffic never depends on it.

## Pending-only execution

`npm run db:migrate`:

1. ensures the ledger objects exist;
2. reads the ledger;
3. SHA-256 checksums every file in the one canonical manifest `db/migrations/manifest.txt`;
4. sorts by numeric version;
5. skips versions already recorded with a matching checksum;
6. applies only pending migrations, each in its own transaction that first takes the
   advisory lock `pg_advisory_xact_lock(4718152, 12)` and calls
   `airs_migrations.assert_pending(...)`;
7. records the ledger row inside that same transaction;
8. stops on the first SQL or ledger failure — a rolled-back migration leaves no ledger row and
   no later migration runs;
9. releases the lock with the transaction and exits cleanly.

A second run reports `Zero pending migrations` and exits 0. `relation already exists` is never
treated as evidence of a successful migration, and no migration file was made broadly
idempotent to hide missing state.

## Checksum immutability

If a recorded migration's file checksum changes, the runner stops immediately, prints the
version and filename, applies nothing further, and never rewrites the stored checksum. Restore
the original file or add a new forward migration.

## Concurrency

Every apply and the adoption transaction take the same transaction-scoped advisory lock with
`SET LOCAL lock_timeout` (default 30 s, `--lock-timeout-ms`). A second runner waits, then either
observes the migration already recorded and skips it, or exits with
`Migration already in progress` (exit 6). Partial application is impossible: the lock, the
migration body and the ledger insert share one transaction.

## Commands

```bash
npm run db:migrate                 # apply pending migrations only
npm run db:migrate -- --dry-run    # applied / pending / conflicts / execution path; changes nothing
npm run db:migrate:status          # ledger present, counts, highest version, conflicts,
                                   # adoption required, advisory-lock state
npm run db:migrate:adopt           # explicit, verified adoption of an existing database
```

No command prints a database URL or credential; all output passes through `redact()`.

## Existing-database adoption

Databases created before the ledger existed have migrations applied but no state. Adoption is
never automatic — `npm run db:migrate` refuses to replay and tells the operator to run
`npm run db:migrate:adopt` (exit 5). Adoption then: confirms the ledger is empty or absent;
confirms this is an existing AIRS Agent database; runs the full SQL assertion suite plus role
parity; verifies schemas, tables, RLS enablement and policies, functions, roles, the exact
platform organization (`anconison-platform` / `Anconison - AIRS Agent Platform` / `platform`),
`platform_admin` separation from operational permissions, and the Albany agency tenants; and
only then records `0001`–`0012` with their current checksums in one locked transaction. It never
executes migration SQL, prints a safe summary, and exits nonzero on any failure.

## Docker initialization

A fresh `docker compose up -d db` runs `db/init/00_apply_migrations.sh`, which reads the same
`db/migrations/manifest.txt`, applies each migration in order and records it in the same ledger
with the same SHA-256 rule. There is exactly one migration-order list. Starting the application
afterwards reports zero pending migrations. All shell files are LF-only and enforced by
`npm run check:line-endings`.

## Transactions

One transaction per migration: `BEGIN` → advisory lock → pending guard → migration SQL with
`ON_ERROR_STOP=1` → ledger row → `COMMIT`. The runner strips each migration's own top-level
`BEGIN;`/`COMMIT;` so it cannot commit early; nested `BEGIN`/`END` inside plpgsql blocks are
untouched. No current AIRS Agent migration requires running outside a transaction (none uses
`CREATE INDEX CONCURRENTLY`, `CREATE DATABASE`, or `ALTER TYPE ... ADD VALUE` outside a block);
any future one must be documented here explicitly.


## Live Windows recovery: adopting an existing database

Use this exact sequence on an installation whose migrations `0001`–`0012` are already applied but
which has no migration ledger.

> **Do not** run `docker compose down -v`. **Do not** recreate the database. **Do not** rerun old
> migrations manually. **Do not** edit migration checksums. **Do not** mark migrations applied
> without verification. The existing database, its data and the platform administrator account
> must remain intact.

```powershell
# 1. Pull the migration-ledger update
git pull origin main

# 2. Keep the existing Docker volume - start only the database
docker compose up -d db

# 3. Confirm the database is healthy
docker compose ps
npm run db:migrate:status        # expect: ledger absent, adoption required

# 4. Run the explicit adoption command (verifies, then records 0001-0012)
npm run db:migrate:adopt

# 5. Migration status
npm run db:migrate:status        # expect: ledger present, 12 applied, highest 0012, 0 pending

# 6. Normal migration run
npm run db:migrate               # expect: "Zero pending migrations."

# 7-8. SQL assertion suite
npm run db:test

# 9-10. Sign in as the platform administrator and confirm the tenant renders as
#       "Anconison - AIRS Agent Platform"
```

If adoption exits nonzero, nothing was recorded: fix the reported drift first and re-run. If a
checksum conflict is reported, restore the original migration file — never edit the ledger.

## Database image: PostgreSQL 16 + PostGIS 3.5

The Docker Compose `db` service is pinned to `postgis/postgis:16-3.5-alpine`
(previously `postgres:16-alpine`). Migrations `0009_common_operating_picture.sql`
and `0010_awareness_observations.sql` require PostGIS; the plain image produced
`extension "postgis" is not available` (0009) and, once 0009 had failed,
`type public.geometry does not exist` (0010).

* PostgreSQL major version: **16** (unchanged - the existing data volume is reused)
* PostGIS: **3.5** (pinned tag, never `latest`)
* Volume, database name, roles, passwords, ports, health check and the
  manifest/ledger migration architecture are all unchanged.

### Upgrading an existing installation (Windows recovery)

Preserve the existing Docker volume. **Never run `docker compose down -v`.**

```
docker compose stop app expiration-scheduler   # stop the app first
docker compose stop db                         # stop only the database
docker compose pull db                         # postgis/postgis:16-3.5-alpine
docker compose up -d db                        # same named volume, same data
docker compose exec -T db psql -U airs_owner -d airs -c "CREATE EXTENSION IF NOT EXISTS postgis"
docker compose exec -T db psql -U airs_owner -d airs -c "SELECT postgis_full_version()"
docker compose exec -T db psql -U airs_owner -d airs -c "SELECT (SELECT count(*) FROM airs.users) AS users, (SELECT count(*) FROM airs.organizations) AS orgs, (SELECT count(*) FROM airs.memberships) AS memberships, (SELECT count(*) FROM airs.incidents) AS incidents, (SELECT count(*) FROM airs.audit_events) AS audit"
```

Confirm the counts match what the installation had before the container was
recreated, then repair the migration state:

```
npm run db:migrate:repair-legacy                                  # report only
npm run db:migrate:repair-legacy -- --confirm --backup-confirmed  # apply
npm run db:migrate:status                                         # expect 0 pending
docker compose up -d app expiration-scheduler
```

Finally, sign in as the platform administrator to confirm the account still works.

### Legacy repair command

`npm run db:migrate:repair-legacy` never runs automatically. It:

1. requires `--confirm` **and** `--backup-confirmed`;
2. requires PostGIS to be available, otherwise prints the recreate procedure above;
3. probes every migration with concrete schema checks - tables, functions,
   extensions, permission counts, RLS policies and exact values - so a migration
   is never classified present from one table alone, and migration state is not
   assumed to be an uninterrupted prefix (the live state 0001-0008 present,
   0009/0010 missing, 0011/0012 present is detected exactly);
4. acquires the migration advisory lock and applies **only** the missing
   migrations 0009 and 0010, each in its own transaction, so a failure rolls the
   whole migration back and leaves no partial Stage 7/8 tables, permissions or
   policies, and no ledger entry;
5. runs the full SQL assertion suite, role parity (10 roles / 56 permissions /
   175 grants) and platform organization + platform administrator verification;
6. only then creates `airs_migrations.applied_migrations` and records 0001-0012
   with their current checksums. `relation already exists` is never treated as
   success, and no password, URL, token or connection string is ever printed.

A fresh Docker installation starts from the PostGIS image, enables PostGIS
before migration 0009, applies the canonical manifest and records every
migration in the ledger - with no host-installed PostGIS anywhere.

## Cumulative legacy-schema reconciliation (live Windows database, 2026-08-06)

Use this when `npm run db:migrate:repair-legacy` refuses because migrations are
only **partially** represented. That refusal is correct: the database is not
"missing whole migrations", it is missing individual objects of the cumulative
post-0012 schema. The reconciliation command repairs exactly those objects.

> **DO NOT use `docker compose down -v`.** It destroys the named volume and
> every account, organization, membership, incident, audit row and resource in
> it. Nothing in this procedure ever needs it.

The command is operator-only. It never runs automatically, never runs from
Docker initialization and is not a numbered production migration.

### Exact sequence

```powershell
# 1. keep the app stopped; the database container and volume stay up and intact
docker compose stop app expiration-scheduler

# 2. confirm the database is running on the PostGIS image, same volume
docker compose ps db
docker compose exec -T db psql -U airs_owner -d airs -c "SELECT postgis_full_version()"

# 3. verify a backup exists OUTSIDE the repository
docker compose exec -T db pg_dump -U airs_owner -d airs > C:\airs-backups\airs-pre-reconcile.sql
dir C:\airs-backups\airs-pre-reconcile.sql

# 4. report only - changes nothing
npm run db:reconcile-legacy

# 5. review the report: every missing object, every superseded object, the
#    expected actions and whether reconciliation is SAFE

# 6. execute (both flags are required)
npm run db:reconcile-legacy -- --confirm --backup-confirmed

# 7. migration status - expect zero pending and zero checksum conflicts
npm run db:migrate:status

# 8. full SQL assertion suite
npm run db:test

# 9. restart the app
docker compose up -d app expiration-scheduler

# 10. verify the platform administrator can still sign in (wflack@anconisonpmg.com)
# 11. verify /resources, /map and /awareness render
# 12. keep C:\airs-backups\airs-pre-reconcile.sql until step 10 and 11 pass
```

### What it does, and what it will never do

* Probes **94 canonical objects** of the post-0012 schema individually
  (tables, columns, functions, seeds, permissions, policies, forced RLS,
  indexes, extension, exact values).
* Creates only the objects that are genuinely absent, using the **current
  canonical migration text** transformed into idempotent form
  (`scripts/lib/idempotent-sql.mjs`) - so a reconciled database is identical to
  a freshly migrated one.
* Never drops a table, column, role or row; never truncates; never deletes.
  Only policies and triggers are dropped and immediately re-created from the
  same canonical definition inside the same transaction.
* Never recreates a **superseded** object (see below).
* Applies each unit in one advisory-locked transaction. A failure rolls the
  whole unit back and leaves **no ledger and no adoption state**.
* Creates the migration ledger and adopts 0001-0012 **only after** the full SQL
  suite, role parity (10 roles / 56 permissions / 175 grants),
  `db/repair/reconcile_verify.sql` and the platform administrator verification
  all passed.
* Prints no passwords, URLs, tokens or connection strings.

### Superseded objects (reported, never recreated)

| Object | Verdict | Current equivalent |
| --- | --- | --- |
| `airs.has_permission` | never canonical | `airs.ctx()`, `airs.current_account_id()`, `airs.current_org_id()` + the TypeScript RBAC model |
| `airs.disclosure_profiles` | never canonical | `airs.disclosure_fields` + `airs.disclosure_profile_fields` + the profile CHECK constraints |

A historical probe demanded both. Neither is created by any migration in the
manifest, so a complete database used to be reported as `PARTIAL`. The probes
are now derived from `scripts/lib/canonical-schema.mjs`, which describes the
schema that must exist **after 0012**, not what an early migration once made.

### If the report says it is NOT safe

Stop. The report names the conflicting object and the migration that owns it.
Reconciliation only ever creates objects owned by 0008, 0009 and 0010; anything
else missing means the database is outside the supported legacy state and needs
an operator decision. Nothing was changed.

## SQL suite harness fix and reconciled-state completion (2026-08-06)

### The failure you saw

```
ERROR:  schema "pg_temp" does not exist
SELECT pg_temp.ok(...)
```

This was a **test-harness defect, not an AIRS schema defect**. The suites in
`db/tests/*.sql` are session-scoped: each creates its own temporary assertion
helpers (`pg_temp.ok`, `pg_temp.denied`) and then opens, commits and rolls back
its own transactions. PostgreSQL creates the per-session temporary schema
lazily, so a helper created inside a transaction that later rolls back
disappears with it. The old reconciliation/adoption runners wrapped whole files
in an extra `BEGIN; ... ROLLBACK;`, so the file's own intermediate `ROLLBACK;`
(`db/tests/auth_rls.sql`) destroyed the helpers the rest of the file called.
`npm run db:test` never wrapped the files, which is why the same SQL passed
there and failed during reconciliation.

### One canonical runner

`scripts/lib/sql-suite.mjs` is now the ONE implementation. It executes each
suite file byte-for-byte as `psql -v ON_ERROR_STOP=1 -f <file>` would, in its
own session, with **no runner-supplied transaction**. Files own their
transactions. It also statically refuses to run a file that would call a
temporary helper it never defines, or one destroyed by a rollback.

Used by all of:

| Command | Script |
| --- | --- |
| `npm run db:test` | `scripts/db-test.mjs` |
| `npm run db:migrate:adopt` | `scripts/db-migrate.mjs` |
| `npm run db:reconcile-legacy` | `scripts/db-reconcile-legacy.mjs` |
| `npm run db:migrate:repair-legacy` | `scripts/db-migrate-repair-legacy.mjs` |

A failing assertion is still a hard failure: the run stops at the first failing
file, names it, and **no ledger row is written**.

### Completion path for the current live Windows database

The reconciliation has already created every missing Stage 7 and Stage 8
object. The database is complete; only the ledger is empty. Finish it:

```powershell
npm run db:test                    # full suite, must pass end to end
npm run db:reconcile-legacy        # expect: "Nothing to reconcile"
npm run db:migrate:adopt           # verifies, then records 0001-0012
npm run db:migrate:status          # expect 12 applied, 0 pending, 0 conflicts
npm run db:migrate                 # expect: no pending migrations
```

`npm run db:migrate:adopt` refuses to record anything until, in order:
PostGIS is installed; every canonical object through 0012 exists; the full SQL
suite passes; `db/repair/reconcile_verify.sql` passes; role parity is exactly
10 roles / 56 permissions / 175 grants; the Anconison platform organization and
`wflack@anconisonpmg.com` verify. Only then are 0001-0012 recorded with their
current checksums. **No migration body is executed by adoption.**

Use `-- --admin-email you@example.com` to verify a different administrator.

### Prohibited actions

* **DO NOT use `docker compose down -v`.** It destroys the volume and all data.
* **DO NOT rerun historical migrations manually.** Adoption records them; it
  never replays them.
* **DO NOT rerun schema reconciliation merely to populate the ledger.** When
  nothing is missing, `db:reconcile-legacy` exits immediately and tells you to
  run `npm run db:migrate:adopt`.
* **DO NOT recreate objects that already exist.** Nothing in this path drops,
  replaces or truncates anything.
