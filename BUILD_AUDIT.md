# BUILD_AUDIT.md

Factual record of what exists in this repository. Never overwrite prior stage sections; append a new
dated section for each build stage.

---

# Stage 1 — Foundation & Architecture — 2026-07-29 (UTC)

## 1. Requested requirements

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Connect project to a GitHub repository the user controls | CANNOT COMPLETE (agent cannot authorize GitHub on the user's behalf; user action required) |
| 2 | React + TypeScript frontend | COMPLETE |
| 3 | PostgreSQL database | COMPLETE |
| 4 | Backend structured with standard APIs and portable TypeScript | PARTIALLY COMPLETE |
| 5 | No essential feature dependent on Lovable-specific services | COMPLETE |
| 6 | No proprietary builder-only DB / auth / workflow engine / connector | COMPLETE |
| 7 | Temporary managed services replaceable through an adapter | COMPLETE (contracts defined; only DB has an implementation) |
| 8 | Capable of running through Docker outside Lovable | PARTIALLY COMPLETE (files written, build not executed here) |
| 9 | MapLibre GL for future mapping | NOT STARTED (documented decision only; no package installed) |
| 10 | Every record belongs to an organization tenant | COMPLETE (except global reference tables, see §6) |
| 11 | Access denied by default unless permissions explicitly allow | COMPLETE (DB + library layer) |
| 12 | No decorative buttons / placeholder workflows | COMPLETE |
| 13 | Do not build the full application in stage 1 | COMPLETE |
| 14 | Present architecture for review (13 listed topics) | COMPLETE (ARCHITECTURE.md + chat response) |
| 15 | Initial orgs are completely separated tenants | COMPLETE |
| 16 | Demo orgs: Albany Police Department, Albany County | COMPLETE |
| 17 | Initial role model with the nine named roles | COMPLETE |
| 18 | No application pages beyond project structure | COMPLETE |
| 19 | Identify requirements that cannot be met without platform dependency | COMPLETE (§3) |
| 20 | Create BUILD_AUDIT.md | COMPLETE (this file) |
| 21 | Create ARCHITECTURE.md, DATABASE.md, SECURITY.md, LOCAL_SETUP.md, CHANGELOG.md | COMPLETE |
| 22 | Docs saved in the repository (not only chat) | COMPLETE in this workspace; reaches GitHub only after requirement 1 |

## 2. Implementation evidence

### Files created
| Path | Purpose |
| --- | --- |
| `db/migrations/0001_init.sql` | Schema `airs`, 12 tables, grants, RLS policies, session-context functions |
| `db/migrations/0002_roles_seed.sql` | 9 roles, 14 permissions, 34 role-permission grants |
| `db/seed/demo_orgs.sql` | Albany PD + Albany County tenants, default retention policies |
| `db/tests/rls_isolation.sql` | Executable cross-tenant isolation proof |
| `src/lib/rbac/roles.ts` | Role/permission catalogue (TypeScript mirror of SQL) |
| `src/lib/rbac/authorize.ts` | Default-deny authorization decision function |
| `src/lib/adapters/types.ts` | `DatabaseAdapter`, `AuthAdapter`, `RealtimeAdapter`, `ObjectStorageAdapter`, `AuditSink` |
| `src/lib/adapters/postgres.server.ts` | PostgreSQL adapter; opens a transaction and sets `airs.org_id`/`airs.user_id` |
| `src/lib/adapters/index.server.ts` | Env-driven adapter registry (`DB_DRIVER`) |
| `src/routes/api/public/health.ts` | `GET /api/public/health`; real DB probe, 200/503 |
| `tests/authorize.test.ts` | 9 authorization tests |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Portable packaging and configuration |
| `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `LOCAL_SETUP.md`, `CHANGELOG.md`, `BUILD_AUDIT.md` | Documentation |

### Files modified
| Path | Change |
| --- | --- |
| `src/routes/index.tsx` | Replaced template placeholder with a stage-1 status page rendered from `src/lib/rbac/roles.ts`. No buttons, no mock data. |
| `package.json` | Added `pg`; dev `@types/pg`, `vitest`; scripts `test`, `test:run`, `db:migrate`, `db:seed` |

### Database objects created
Tables: `organizations`, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`,
`incidents`, `incident_shares`, `aircraft`, `airspace_operations`, `audit_events`, `retention_policies`.
Functions: `airs.current_org_id()`, `airs.current_user_id()`. Role: `airs_app`. Index:
`audit_events_org_time_idx`. RLS enabled + forced on all 9 tenant tables with 15 policies.

### API routes / backend functions created
- `GET /api/public/health` (`src/routes/api/public/health.ts`) — the only endpoint. Returns
  `{status, database}`; no tenant data.

### Authorization rules created
- Database: 15 RLS policies (see DATABASE.md table). Default deny where no policy exists.
- Application: `authorize()` in `src/lib/rbac/authorize.ts`; partner orgs restricted to
  `incident.read` / `airspace.read` on actively shared incidents.

### Environment variables added
`DATABASE_URL`, `DB_DRIVER` (consumed by code today); `AUTH_DRIVER`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `REALTIME_DRIVER`, `VITE_MAP_STYLE_URL` (declared, not yet consumed).

### Third-party services / packages used
- `pg` 8.x (PostgreSQL driver, MIT). `@types/pg`, `vitest` (dev only). `postgres:16-alpine`,
  `node:22-alpine` container images. No SaaS, no managed service, no connector.

## 3. Platform dependencies

| Dependency | Why present | Can the app run without it? | Replacement | Impact if removed |
| --- | --- | --- | --- | --- |
| Lovable (editor/preview host) | Development environment for this build | Yes | Any editor + `npm run dev` | None on runtime |
| `@lovable.dev/vite-tanstack-config` (devDependency, `vite.config.ts`) | Template's Vite preset for the preview | Not as-is: `vite.config.ts` imports it | Replace with an equivalent stock TanStack Start + Tailwind Vite config (~30 lines) | Build config only; no application logic. **This is the one file to change before a clean external build.** |
| `src/lib/lovable-error-reporting.ts`, `src/lib/error-capture.ts`, `src/lib/error-page.ts` | Template error surfacing wired into `__root.tsx` / `server.ts` | Yes | Delete and use plain error boundaries | Error reporting nicety only |
| Lovable Cloud | **NOT ENABLED** — deliberately avoided | n/a | n/a | n/a |
| Supabase | **NOT USED**. No `@supabase/*` package, no generated client | n/a | n/a | n/a |
| Third-party authentication | **NOT USED**. Adapter contract only | n/a | Local credentials or agency OIDC | n/a |
| Third-party storage | **NOT USED**. `ObjectStorageAdapter` contract only | n/a | Local disk or S3-compatible | n/a |
| Third-party real-time services | **NOT USED**. Planned default is Postgres LISTEN/NOTIFY | n/a | Redis pub/sub adapter | n/a |
| Proprietary connectors | **NOT USED** | n/a | n/a | n/a |
| Builder-generated functions | None on any essential path | n/a | n/a | n/a |
| Undocumented external services | None | n/a | n/a | n/a |
| Cloudflare Workers runtime (Lovable preview/deploy target) | The hosted preview executes SSR in a Worker | Yes — the Dockerfile runs the same build on Node | Keep server code to standard Node/Web APIs | Would only matter if Worker-only APIs were adopted |

### Requirement that cannot be met without user action
**GitHub connection.** The agent cannot authorize a GitHub account or create a repository under the
user's control. The user must connect it from the Lovable editor (Plus menu -> GitHub -> Connect
project). Until then all files above exist in the Lovable workspace only.

## 4. Portability status

| Item | Status | Notes |
| --- | --- | --- |
| Cloned from GitHub | NO | Repository not yet connected (requirement 1) |
| Installed locally | YES | `npm install` / `bun install`; all dependencies are public npm packages |
| Started locally | YES | `npm run dev` runs the app in this environment now |
| Connected to a local PostgreSQL database | YES | Migrations + seed + isolation test were executed against a local PostgreSQL 16 instance during this stage |
| Built for production | PARTIAL | `npm run build` uses `@lovable.dev/vite-tanstack-config`; it builds, but that devDependency should be swapped for a stock config before external builds |
| Deployed without Lovable | PARTIAL | Output is a standard Node server; blocked only by the Vite config dependency above and the absence of auth |
| Run through Docker | PARTIAL | `Dockerfile` + `docker-compose.yml` written and reviewed; **not executed** — no Docker daemon in this environment |

## 5. Security status

- **Tenant isolation:** shared-schema `org_id` + PostgreSQL RLS (`ENABLE` + `FORCE`), non-owner app
  role `airs_app`, per-transaction `SET LOCAL airs.org_id`. Verified live (§7).
- **Authentication:** none implemented. `AuthAdapter` contract only.
- **Authorization:** `authorize()` library, default deny, unit tested; not yet enforced on request
  paths because no data endpoints exist.
- **Default-deny behavior:** confirmed — with no session context a query returned 0 incidents.
- **Roles implemented:** all nine, in code and in the database.
- **Audit logging:** table exists and is immutable to the app role; no writes yet.
- **Known gaps:** no auth, no sessions, no audit writes, no retention purge, no rate limiting, no
  migration ledger, TLS handled outside the repo.
- **Planned but not operational:** authentication, real-time, mapping, audit sink, retention job.
- **No compliance claim.** CJIS / NIST / FedRAMP status: not assessed, not claimed.

## 6. Database status

- **Tables (12):** listed in §2 and DATABASE.md.
- **Primary keys:** `uuid` on all entity tables; `bigserial` on `audit_events`; `text` keys on
  `roles`/`permissions`; composite on `role_permissions`; `org_id` on `retention_policies`.
- **Foreign keys:** every `org_id -> airs.organizations(id) ON DELETE CASCADE`; plus `users`,
  `incidents`, `aircraft`, `incident_shares`, `airspace_operations`, `user_roles`, `audit_events`
  cross-references (see DATABASE.md).
- **Tenant ownership field:** `org_id` on all 9 tenant tables.
- **RLS rules:** 15 policies; no policy = no access.
- **Migrations:** `0001_init.sql`, `0002_roles_seed.sql` (both applied successfully to PostgreSQL 16).
- **Seed data:** 9 roles, 14 permissions, 34 grants, 2 organizations, 2 retention policies.
- **Tables lacking tenant isolation:** `roles`, `permissions`, `role_permissions` — global read-only
  reference data, no agency content, `SELECT`-only for the app role. Intentional.

## 7. Testing status

| Test | File | Verifies | Result |
| --- | --- | --- | --- |
| denies with no principal | `tests/authorize.test.ts` | unauthenticated request denied | PASS |
| denies a user with no roles for every permission | `tests/authorize.test.ts` | default deny across all 14 permissions | PASS |
| denies cross-tenant access even for agency admin | `tests/authorize.test.ts` | tenant boundary beats privilege | PASS |
| allows cross-tenant read only through an active share | `tests/authorize.test.ts` | share semantics | PASS |
| denies writes on shared resources | `tests/authorize.test.ts` | shares are read-only at library level | PASS |
| defines all nine roles | `tests/authorize.test.ts` | role model completeness | PASS |
| only grants permissions from the declared catalogue | `tests/authorize.test.ts` | no undeclared permissions | PASS |
| restricts system auditor to audit reads | `tests/authorize.test.ts` | least privilege | PASS |
| airspace supervisor may approve in own tenant | `tests/authorize.test.ts` | positive path | PASS |

Command: `bunx vitest run` -> **9 passed, 0 failed** (2026-07-29).

Database test — `db/tests/rls_isolation.sql`, executed against local PostgreSQL 16:

| Check | Expected | Observed | Result |
| --- | --- | --- | --- |
| no session context, incidents visible | 0 | 0 | PASS |
| Albany PD sees own incidents | 1 | 1 | PASS |
| Albany PD sees Albany County users | 0 | 0 | PASS |
| Albany PD sees other org rows | 1 (own only) | 1 | PASS |
| County sees incidents after share granted | 2 | 2 | PASS |
| County UPDATE of APD incident rows affected | 0 | 0 | PASS |
| County sees incidents after share revoked | 1 | 1 | PASS |

**No tests exist for:** the health endpoint, the PostgreSQL adapter's transaction handling, the
Docker build, the production build output, retention, audit writes, authentication (unimplemented).

## 8. Known gaps and next actions

- **Not completed:** GitHub connection (user action), MapLibre integration, authentication,
  real-time transport, audit writes, retention purge, any application screen.
- **Placeholder components:** none. The index route renders only real, source-derived role data.
- **Mock data:** none in the application. Demo tenants are real seed rows.
- **Buttons without working actions:** none — the stage-1 page has no controls.
- **Hard-coded values:** demo organization UUIDs in `db/seed/demo_orgs.sql` and in the SQL test
  (intentional, seed-only); default retention windows (365 / 2555 / 90 days).
- **Temporary decisions:** `@lovable.dev/vite-tanstack-config` retained for now; geometry stored as
  GeoJSON `jsonb` instead of PostGIS; migrations applied by filename order.
- **Security concerns:** the app is unauthenticated; do not expose it publicly or load real data.
- **Portability concerns:** Vite config dependency; unverified Docker build.
- **Recommended next build step:** connect GitHub, then implement the authentication adapter
  (local credentials first) plus session handling, wire `authorize()` and `AuditSink` into a first
  real endpoint (`POST /api/incidents`, `GET /api/incidents`), and replace the Vite config dependency.

## 9. Change log

- **Date/time:** 2026-07-29 (UTC) — **Stage:** Foundation & Architecture
- **Files added:** `db/migrations/0001_init.sql`, `db/migrations/0002_roles_seed.sql`,
  `db/seed/demo_orgs.sql`, `db/tests/rls_isolation.sql`, `src/lib/rbac/roles.ts`,
  `src/lib/rbac/authorize.ts`, `src/lib/adapters/types.ts`, `src/lib/adapters/postgres.server.ts`,
  `src/lib/adapters/index.server.ts`, `src/routes/api/public/health.ts`, `tests/authorize.test.ts`,
  `Dockerfile`, `docker-compose.yml`, `.env.example`, `ARCHITECTURE.md`, `DATABASE.md`,
  `SECURITY.md`, `LOCAL_SETUP.md`, `CHANGELOG.md`, `BUILD_AUDIT.md`
- **Files modified:** `src/routes/index.tsx`, `package.json`, `bun.lock`
- **Files removed:** none
- **Migrations added:** `0001_init.sql`, `0002_roles_seed.sql`
- **Packages added:** `pg`; dev: `@types/pg`, `vitest`
- **Packages removed:** none