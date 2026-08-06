# AIRS Agent

Secure, incident-based airspace coordination for public-safety agencies.

AIRS Agent lets separate agencies open temporary incident rooms, share approved airspace
information, coordinate drone and crewed-aircraft operations, and end that sharing when the
incident closes.

**Status:** foundation only. No authentication and no application features yet — see
`BUILD_AUDIT.md` for the verified state of every claim.

## Stack

- React 19 + TypeScript
- TanStack Start (Vite 8, Nitro `node-server` build output)
- PostgreSQL 16 with forced row-level security for tenant isolation
- Docker / docker compose for packaging

No hosted builder service is required to install, test, build, run or deploy this repository.

## Quick start

```sh
git clone https://github.com/anconison/airs-agent.git
cd airs-agent
npm install
cp .env.example .env        # then edit DATABASE_URL
npm run db:migrate && npm run db:seed
npm run test
npm run build && node .output/server/index.mjs
```

Full instructions: `LOCAL_SETUP.md`. Architecture: `ARCHITECTURE.md`. Schema: `DATABASE.md`.
Security posture and known gaps: `SECURITY.md`.

## Windows

Windows clones need Git, Node.js 22+, Docker Desktop and WSL 2 — but **not** a
host-installed `psql`. `npm run db:migrate` uses a local `psql` when present and
otherwise applies migrations through the running Docker Compose `db` service.
`.gitattributes` forces LF for all `*.sh` files so the container init scripts do
not fail with `/bin/sh^M: bad interpreter`; `npm run check:line-endings` enforces it.

Full verified sequence: `LOCAL_SETUP.md` §9. `docker compose down -v` deletes local
database data — use `docker compose stop` to shut down without data loss.

## Migrations

`npm run db:migrate` applies only pending migrations, tracked in the persistent ledger
`airs_migrations.applied_migrations` (SHA-256 checksummed, advisory-locked, one transaction per
migration). Use `-- --dry-run` to preview, `npm run db:migrate:status` for state, and
`npm run db:migrate:adopt` once on a pre-ledger existing database. See `DATABASE.md` and
`LOCAL_SETUP.md` (Windows recovery procedure).

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
