# AIRS Agent — Architecture

Status legend: **IMPLEMENTED** = exists and runs in this repository. **NOT YET IMPLEMENTED** = design only.

## 1. Goal and constraints

AIRS Agent is an incident-based airspace coordination platform for public-safety agencies.
Hard constraints driving every decision below:

- Must be exportable and operable outside Lovable (Docker + plain PostgreSQL).
- React + TypeScript frontend; portable TypeScript backend; PostgreSQL database.
- No proprietary builder-only database, auth, workflow engine, or connector on any essential path.
- Any managed service must sit behind an adapter interface.
- Every record belongs to an organization tenant; access denied by default.

## 2. Stack (IMPLEMENTED)

| Layer | Choice | Portability note |
| --- | --- | --- |
| UI | React 19 + TypeScript + Tailwind | Standard; no builder runtime |
| Routing / SSR | TanStack Start (Vite) | Open source; builds to a plain Node server (`.output/server/index.mjs`) |
| API | HTTP routes under `src/routes/api/**` | Standard `Request`/`Response`; framework-swappable |
| Database | PostgreSQL 16, raw SQL migrations | No ORM lock-in, no vendor extensions (no PostGIS required) |
| DB access | `pg` driver behind `DatabaseAdapter` | Any Postgres host |
| Mapping | MapLibre GL (**NOT YET IMPLEMENTED**) | Open source; style URL is configuration |
| Tests | Vitest + executable SQL isolation test | Standard |

TanStack Start is chosen because it is a plain open-source Vite framework. Lovable's preview runs it,
but so does `node .output/server/index.mjs` in the Docker image. It is the one framework-level
decision that would need a rewrite only if you wanted a different React meta-framework.

## 3. Repository structure

```text
db/
  migrations/0001_init.sql        schema, grants, RLS policies
  migrations/0002_roles_seed.sql  roles, permissions, role_permissions
  seed/demo_orgs.sql              Albany PD + Albany County tenants
  tests/rls_isolation.sql         executable tenant-isolation proof
src/
  lib/rbac/roles.ts               role + permission catalogue (mirrors SQL)
  lib/rbac/authorize.ts           default-deny decision function
  lib/adapters/types.ts           DB / Auth / Realtime / Storage / Audit contracts
  lib/adapters/postgres.server.ts PostgreSQL DatabaseAdapter (sets tenant context)
  lib/adapters/index.server.ts    env-driven adapter selection
  routes/api/public/health.ts     health endpoint (real DB probe)
  routes/index.tsx                stage-1 foundation status page
tests/authorize.test.ts           9 authorization tests
Dockerfile, docker-compose.yml, .env.example
```

## 4. Request path (design, partially implemented)

```text
Browser (React)
  -> HTTP route / server function
     -> AuthAdapter.verify(credential)          NOT YET IMPLEMENTED
     -> build Principal { userId, orgId, roles }
     -> authorize(principal, {resourceOrgId, permission})   IMPLEMENTED
     -> DatabaseAdapter.withTenant({orgId,userId}, fn)      IMPLEMENTED
          SET LOCAL airs.org_id / airs.user_id
          -> SQL executed as role airs_app under RLS        IMPLEMENTED
     -> AuditSink.record(...)                               contract only
```

Authorization is enforced **twice**: in application code (explicit permission check) and in the
database (RLS). A bug in one layer does not by itself leak cross-tenant data.

## 5. Multi-tenancy

Single database, shared schema, `org_id` on every tenant-owned table, PostgreSQL row-level security
with `FORCE ROW LEVEL SECURITY` and a non-owner application role (`airs_app`). Tenant identity comes
from the session GUC `airs.org_id`, set per transaction — never from client input.

Cross-agency sharing is explicit and revocable: `airs.incident_shares` grants a partner org read
(or contribute) access to a single incident; revocation sets `revoked_at` and the RLS predicate
immediately stops matching. Verified live — see BUILD_AUDIT.md §7.

## 6. Authentication (NOT YET IMPLEMENTED)

Design: session cookie issued by the app, backed by an `AuthAdapter`.
- `AUTH_DRIVER=local` — email + Argon2id password hash stored in Postgres, TOTP second factor. Fully self-hosted.
- `AUTH_DRIVER=oidc` — standard OIDC authorization-code + PKCE against the agency IdP (Entra ID, Okta, Keycloak).

No proprietary auth service. `airs.users.external_subject` holds the IdP subject when OIDC is used.

## 7. Roles and permissions (IMPLEMENTED)

Nine roles, fourteen permissions, defined once in `src/lib/rbac/roles.ts` and mirrored in
`db/migrations/0002_roles_seed.sql`. Role assignment is per tenant (`airs.user_roles.org_id`).
`authorize()` returns `allowed:false` unless a rule explicitly grants access; partner orgs are
additionally limited to `incident.read` and `airspace.read` on shared incidents.

## 8. Real-time (NOT YET IMPLEMENTED)

`RealtimeAdapter` contract exists. Planned default: PostgreSQL `LISTEN`/`NOTIFY` fanned out over the
app's own WebSocket/SSE endpoint — zero extra infrastructure, no third-party realtime service.
Alternative adapter: Redis pub/sub for multi-instance deployments. Tenant and incident scoping is
applied server-side before any message is emitted; channels are never trusted from the client.

## 9. Mapping (NOT YET IMPLEMENTED)

MapLibre GL JS with a configurable style URL (`VITE_MAP_STYLE_URL`). Agencies may self-host tiles
(OpenMapTiles/Protomaps) with no API key. Airspace geometry is stored as GeoJSON in `jsonb`, so no
PostGIS dependency exists today; PostGIS can be added later for spatial deconfliction queries.

## 10. Adapters and connectors

Every external capability is an interface in `src/lib/adapters/types.ts`
(`DatabaseAdapter`, `AuthAdapter`, `RealtimeAdapter`, `ObjectStorageAdapter`, `AuditSink`).
Only `DatabaseAdapter` has an implementation today. Future integrations (LAANC/UAS Facility Maps,
CAD/RMS, Remote ID feeds) get their own adapter interface plus an HTTP client — no builder connectors.

## 11. Data retention (schema only)

`airs.retention_policies` stores per-tenant retention windows (incidents, audit, telemetry).
`airs.incidents.retain_until` is the enforcement hook. The purge job is **NOT YET IMPLEMENTED**.

## 12. Audit logging (schema only)

`airs.audit_events` is append-only by construction: RLS grants INSERT and SELECT within the tenant
and defines no UPDATE or DELETE policy, so modification is impossible for `airs_app`. Application
wiring (`AuditSink`) is **NOT YET IMPLEMENTED**.

## 13. Portability risks

See BUILD_AUDIT.md §3 for the full dependency register. Summary of where lock-in could creep in:
1. Enabling Lovable Cloud would introduce Supabase auth/DB coupling — deliberately not enabled.
2. Lovable-generated helper modules (`src/lib/lovable-error-reporting.ts`, `error-capture.ts`,
   `@lovable.dev/vite-tanstack-config`) are preview-only conveniences; they must stay out of business logic.
3. Cloudflare-Worker-only APIs in the Lovable preview runtime — avoided by keeping server code to
   standard Node/Web APIs.
4. Any future use of a builder connector or managed realtime service without an adapter.
## Foundation Portability Verification — 2026-07-29

The build toolchain no longer contains any builder-specific package. `vite.config.ts` composes the
standard plugin set directly: `@tailwindcss/vite`, `vite-tsconfig-paths`, `tanstackStart` (with
client import protection and `src/server.ts` as the SSR entry), `nitro/vite`, `@vitejs/plugin-react`.

The Nitro deployment preset is `node-server` by default and configurable with `NITRO_PRESET`, so
`npm run build` produces `.output/server/index.mjs`, runnable with plain `node` on any host, in the
Docker image, or on any Node PaaS. Cloudflare/Workers output remains available via
`NITRO_PRESET=cloudflare-module` but is not required.

Remaining builder artifacts (`AGENTS.md` banner, `.lovable/`, `.workspace/`) are metadata and
documentation only; nothing in install, build, test, run or deploy reads them.

## Request path with authentication (2026-07-30)

```
browser
  |  TanStack server function (src/lib/api/auth.functions.ts)
  |    reads the httpOnly airs_session cookie, never a client-supplied identity
  v
withAuthorized()  src/lib/auth/authorize.server.ts
  |  AuthAdapter.resolve(token)      src/lib/auth/local-adapter.server.ts
  |  resolveMembership(ctx, orgId)   active membership only
  |  authorize(principal, request)   pure, default deny  src/lib/rbac/authorize.ts
  v
DatabaseAdapter.withContext({ airs.org_id, airs.user_id, airs.account_id })
  |  SET LOCAL inside a transaction -> discarded on COMMIT/ROLLBACK (pool safe)
  v
PostgreSQL as airs_app under FORCE ROW LEVEL SECURITY
  |  airs.current_org_id() re-checks the membership (migration 0004)
  v
recordAudit() in the same transaction  -> airs.audit_events
```

Portability is unchanged: the auth driver is selected by `AUTH_DRIVER` behind the `AuthAdapter`
contract (`local` today, OIDC later), and no Lovable-specific service is on this path.

### Routes added

- `/auth` — sign-in; accepts an optional same-origin `?redirect=` path only.
- `/invite/$token` — invitation acceptance (`ssr: false`, `noindex`); organization and role are
  displayed read-only from the server-validated invitation.

## Brand and presentation layer (Stage 5A)

Brand artwork is static and portable: files live in `public/brand/airs-agent/` and are referenced
through a single registry, `src/components/brand/assets.ts`. No component hard-codes a path, so the
whole package can be re-pointed or re-issued in one place. Design tokens are Tailwind v4 `@theme`
variables in `src/styles.css`; components consume tokens, never literal colours.

`src/components/brand/` is the only place that knows what the product looks like:

```
BrandMark / BrandLockup / BrandHorizontal   the mark, at fixed safe sizes
AppHeader / AppFooter                       chrome shared by every route
PageShell / PageHeading / SectionCard       page skeleton
StatusPill                                  lifecycle and verification states
```

## Incident expiration maintenance (Stage 5B)

Maintenance is a separate plane from the application. All decision logic stays in the database, so
every invocation path produces identical behaviour and an identical audit trail:

```
airs.expire_incident_state()      Stage 5 sweep — unchanged by this stage
airs.run_incident_expiration()    maintenance entry point: advisory lock + sweep + audit record
airs.record_maintenance_event()   append-only operator audit (runner-side, survives a rollback)
airs.maintenance_expiration_status()  last success / last failure / runs in 24h
```

Runners are deliberately thin — connect, record start, call one function, log — so no rule can drift
between them:

```
npm run maintenance:expire-incidents   scripts/expire-incident-state.mjs — plain Node + pg driver;
                                       the primary path for cron, systemd, Kubernetes CronJob, CI
POST /api/maintenance/expire-incidents optional, off by default, operator-secret only
db/scheduler/pg_cron.sql               optional in-database schedule, no external caller at all
docker compose                         expiration-scheduler service wrapping the CLI runner
```

Privilege is separated from the application: the runner connects as `airs_maintenance` via
`AIRS_MAINTENANCE_DATABASE_URL`, and `airs_app` no longer holds `EXECUTE` on the sweep at all. See
SECURITY.md for the full privilege and endpoint model.

All paths take PostgreSQL advisory lock `8421701` first, so overlapping schedulers cannot run
concurrent sweeps; a caller that loses the race returns `skippedLocked: true` and exits cleanly.

## Field-level disclosure (Stage 6 closure)

Sharing is now decided on two independent axes, both owned by the originating organization:

1. **Row release** — `airs.resource_shares` / `airs.incident_assignments` decide whether a partner
   organization sees the record at all. Enforced by forced RLS in the database.
2. **Field release** — a *disclosure profile* on that same share decides which fields of the
   released row may be transmitted. Enforced twice: in the database by
   `airs.effective_disclosure()` / `airs.disclosure_allows()`, and in the service layer by
   `projectFields()` in `src/lib/resources/disclosure.ts`.

```text
request -> session -> membership -> role permission -> RLS row release
        -> effective_disclosure(resource) -> projectFields() -> response
```

The vocabulary is a fixed server-side allow-list of 60 field keys, 12 of which are marked sensitive
and belong to no partner profile at all. Profiles are cumulative — `summary` < `operational` <
`aviation` < `incident_command` — so widening never silently removes a field and narrowing takes
effect on the next read. `full` resolves to the full authorized record only for an explicitly
named recipient; for any other partner it resolves down to `incident_command`.

Projection **deletes** withheld properties rather than nulling them, so a partner cannot distinguish
"the owner has no value" from "the owner withheld the value". Unknown profiles and unknown field
keys fail closed to `summary`.

Portability note: the model is plain TypeScript plus plain SQL reference tables. No platform
service participates in the decision.

## Stage 8 — Manual Airspace Observations and Awareness Layer

The Awareness layer records what people report, as distinct from what sensors
and registries assert. An observation is a claim with a provenance, not a fact.

**Planes.** The layer is split so that no browser ever holds a decision:

```text
route (/awareness, /awareness/$observationId)
  -> src/lib/api/awareness.functions.ts   transport: Zod validation, session cookie
    -> src/lib/awareness/awareness.server.ts   session -> membership -> permission
                                               -> ownership -> validation
    -> PostgreSQL as airs_app (FORCE ROW LEVEL SECURITY)
    -> projection: field disclosure -> geographic precision -> freshness
    -> airs.audit_events (same transaction as the action)
```

The browser sends ids and validated fields only. It never sends an owner id, an
effective disclosure profile, an effective precision, a freshness value, a
relationship verdict or an access outcome; each of those is computed server-side
from the reader's own membership.

**Domain model.** `src/lib/awareness/model.ts` mirrors migration 0010 exactly —
observation types, source types, reliability and credibility scales, urgency,
verification lifecycle, freshness states, and the restricted-source field set.
`tests/awareness.test.ts` asserts the mirror, so the model cannot drift from the
schema without a failing test.

**Reader projection.** `projectForReader()` applies, in order: field disclosure
by profile (summary → operational → aviation → incident_command → full),
restricted-source stripping (`reporterIdentity`, `reporterContact`,
`internalNotes`, `internalCaseNumber`, `sourceDetail`, `classification`,
`declaredPrecision` never leave the owning organization), then geographic
precision reduction. A field that was withheld is absent from the payload, not
nulled and not blanked at the edge.

**Presentation.** `src/components/awareness-ui.tsx` renders absence explicitly
("Not released at your access level") rather than inventing a placeholder, and
derives every tone and label from a value the server already released.

**Map integration.** The awareness layer in `src/components/map/cop-map.tsx` is
fed from the same projection. Observations whose geography resolved to
`withheld` are counted in the layer summary and never placed on the map.

**Incident coupling.** `airs.terminate_incident_observations()` runs inside the
incident closure flow, so closing a room ends observation sharing with partner
agencies at the same moment it ends everything else.

## Test isolation architecture (Stage 8 closure)

The enforcement suites cannot use transaction-per-test: they exercise the real
service chain, which opens its own pooled connections as `airs_app`, so a
fixture transaction on the admin connection would be invisible to the code under
test. Instead each suite tags its fixtures with a per-run identifier and
`tests/support/fixtures.ts` deletes exactly those rows in foreign-key-safe order
from `afterAll` (which also runs after a failure). Suite files run sequentially
(`vitest.config.ts`, `fileParallelism: false`) because the two demo
organizations are shared state.


## Platform administration plane — IMPLEMENTED (2026-08-05)

AIRS Agent now distinguishes two planes of administration.

```text
platform plane                         agency plane
------------------------------------   ------------------------------------
organizations.org_kind = 'platform'    organizations.org_kind = 'agency'
Anconison - AIRS Agent Platform        Albany Police Department, Albany County
role: platform_admin                   the nine agency roles
permissions: org.manage, user.manage,  incident.*, resource.*, map.*,
             audit.read,               observation.*, airspace.*, ...
             retention.manage
owns: no incidents, no resources,      owns: all operational records
      no geography, no observations
```

Separation is structural, not conventional:

- a database trigger rejects `platform_admin` in any agency organization and rejects agency roles
  in the platform organization (`memberships`, `user_roles`, `invitations`);
- `platform_admin` is granted no operational permission at all, in SQL and in
  `src/lib/rbac/roles.ts`;
- `airs.current_org_id()` (migration 0004) still requires an ACTIVE membership, so a platform
  administrator who supplies an agency organization id gets NULL context and therefore no rows.

Bootstrap is operator-driven and offline: `npm run bootstrap:platform-admin` calls
`airs.bootstrap_platform_invitation()` over an operator connection, which the application role
cannot execute. The one-time token is generated in the CLI and reaches the database only as a
SHA-256 hash. The recipient completes `/activate/$token` (new account) or `/invite/$token`
(existing account) and from then on authenticates normally at `/auth`.

---

## Portable migration execution (Windows bootstrap hardening)

`npm run db:migrate` is a Node runner (`scripts/db-migrate.mjs`), not shell command
composition, so it behaves identically in PowerShell, bash and zsh.

Planning is pure and unit-tested (`scripts/lib/migrate-plan.mjs`,
`tests/db-migrate.test.ts`); execution is a thin `spawnSync` loop:

1. **Local `psql` on `PATH`** → one invocation with `-v ON_ERROR_STOP=1` and the
   ordered `-f` list, using `DATABASE_URL`.
2. **Otherwise, a running Compose `db` service** (detected with
   `docker compose ps --status running --services`) → one
   `docker compose exec -T db psql -v ON_ERROR_STOP=1 -U airs_owner -d airs`
   per migration, in `MIGRATION_FILES` order, each file piped on stdin; the loop
   stops at the first nonzero exit code.
3. **Neither** → an actionable error and exit code 1. The runner never starts,
   stops or deletes containers.

All printed output passes through `redact()`, so connection strings and
password-like values cannot reach logs or CI output. Nothing here depends on a
hosted builder service.

Line endings are pinned by the repository-root `.gitattributes` (`*.sh text eol=lf`),
enforced by `scripts/check-line-endings.mjs` and `tests/line-endings.test.ts`.

# Migration runner architecture

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
