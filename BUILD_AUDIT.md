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
---

## Foundation Portability Verification — 2026-07-29

Environment: Linux sandbox, Node 22 / npm 10.9.4 / bun 1.3.3, PostgreSQL **17.9** (only server
binary available here — PostgreSQL 16 is the documented target and was NOT exercised),
**no Docker daemon**, no network install from a clean cache.

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| `@lovable.dev/vite-tanstack-config` removed from `package.json` | VERIFIED | absent from devDependencies | `bun remove @lovable.dev/vite-tanstack-config`; `rg -i lovable package.json` → 0 hits | none |
| Removed from lockfile | VERIFIED | `rg -ci lovable bun.lock` → 0 | `bun.lock` | lockfile is bun-format; no `package-lock.json` is committed |
| Builder registry mirror URLs removed from lockfile | VERIFIED | all resolutions now `https://registry.npmjs.org/` | `bun.lock` | re-resolution from a clean cache NOT executed (no clean network install here) |
| Portable Vite/TanStack config replaces it | VERIFIED | `vite.config.ts` uses `vite`, `@tanstack/react-start/plugin/vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `vite-tsconfig-paths`, `nitro/vite` | `vite.config.ts` | dev-time builder preview/HMR bridge plugins are gone by design |
| Production build without builder services | VERIFIED | `✓ built in 315ms`, output `.output/server/index.mjs` (Nitro `node-server`) | `npm run build` | build ran with a warm `node_modules`, not from a clean install |
| No source file references the builder | VERIFIED | `src/lib/lovable-error-reporting.ts` deleted; `__root.tsx` meta replaced with AIRS Agent metadata | `rg -in lovable src public *.ts *.json *.toml README.md` → 0 hits | see "Remaining occurrences" below |
| Automated unit tests | VERIFIED | 14/14 passing (9 authorize, 5 role parity) | `npm run test` | no integration/HTTP tests yet |
| Migrations on a brand-new empty database | VERIFIED | fresh cluster + empty `airs` DB, all files applied, exit 0 | `psql -f db/migrations/0001_init.sql -f db/migrations/0002_roles_seed.sql -f db/seed/demo_orgs.sql` | executed on PostgreSQL 17.9, not 16 |
| Migrations self-contained (no manual pre-created objects) | VERIFIED | `0001_init.sql` creates `pgcrypto`, role `airs_app`, schema, tables, policies | `db/migrations/0001_init.sql` | needs a superuser (or `pgcrypto` pre-installed + `CREATEROLE`) to apply |
| Forced RLS on all 9 tenant tables, CRUD matrix | VERIFIED | **47/47 checks PASS**, incl. no-context deny, APD↔County isolation both directions, `org_id` move denied, partner read-only, revocation, audit immutability | `psql -f db/tests/rls_matrix.sql` | test rolls back; it does not run in CI yet |
| Superuser / owner bypass behaviour documented | VERIFIED | matrix check 47 records `bypass` when the runner is a superuser; `FORCE` binds the table owner | `db/tests/rls_matrix.sql`, `SECURITY.md` | app must never connect as owner/superuser — enforced only by configuration |
| Nine roles consistent between TypeScript and SQL | VERIFIED | parity test compares keys, display names, permission keys and all 34 grants | `npm run test` (`tests/role-parity.test.ts`), `db/tests/role_parity.sql` (9/14/34) | TS side is compared against the seed file; live-DB comparison is a separate SQL script |
| Health endpoint against a real database | VERIFIED | `HTTP/1.1 200 {"status":"ok","database":"reachable"}` from the built server connecting as `airs_app` | `node .output/server/index.mjs` + `curl localhost:3000/api/public/health` | PostgreSQL 17.9 |
| Docker image build | NOT VERIFIED | no Docker daemon in this environment | `docker compose build` / `docker compose up --build` | must be run by you; see LOCAL_SETUP.md §4 |
| `docker-compose.yml` correctness | PARTIALLY VERIFIED | reviewed and corrected: init SQL now mounted as **individual files** (mounted directories are ignored by the postgres entrypoint, so migrations previously never ran), owner role renamed `airs_owner`, app connects as `airs_app`, credentials required from `.env`, persistent volume, db healthcheck, `depends_on: service_healthy` | `docker-compose.yml` | not executed |
| Dockerfile hardening | PARTIALLY VERIFIED | non-root `USER node`, `HEALTHCHECK` on `/api/public/health`, `NITRO_PRESET=node-server`, chowned copies | `Dockerfile` | not executed |
| `.dockerignore` | VERIFIED (file created) | excludes `node_modules`, `.git`, `.env*`, build output, tool dirs | `.dockerignore` | effect not observed (no build run) |
| No secrets committed | VERIFIED | repo-wide scan for password/secret/key/token/DSN patterns returned only placeholders, docs and env-var *names* | `rg -in "(password\|secret\|api[_-]?key\|token\|private[-_]key\|postgres://[^ ]*:[^ @]*@)" .` | `LOCAL_SETUP.md` documents the throwaway local password `localdev` (intentional, local-only) |
| `.gitignore` / `.env.example` | VERIFIED | `.env`, `.env.*` ignored (`!.env.example`); example contains `CHANGE_ME` placeholders only | `.gitignore`, `.env.example` | none |
| Clean install from GitHub on a new machine | NOT VERIFIED | this sandbox is the working tree, not a fresh clone, and has a pre-populated package cache | `git clone …` → `npm install` (see LOCAL_SETUP.md §0) | must be run by you |
| Commit to `anconison/airs-agent` | BLOCKED | I cannot execute git commands; commits are produced by the platform sync of this change set | — | commit hash is visible in the repo after sync, not obtainable here |

### Remaining occurrences of "lovable" in the repository

| Location | Kind | Operational dependency? |
| --- | --- | --- |
| `AGENTS.md` (`<!-- LOVABLE:BEGIN -->` block) | Documentation/metadata for the editor sync | No |
| `.lovable/project.json`, `.workspace/` | Builder metadata, not read by application code or the build | No |
| `BUILD_AUDIT.md`, `ARCHITECTURE.md`, `LOCAL_SETUP.md`, this file | Documentation | No |

No operational builder dependency remains in install, build, test, run or deploy paths.

---

# Lovable Editor Compatibility Repair — 2026-07-30 (UTC)

## 1. Exact original error

The editor reported **"Build unsuccessful" / "Build error"** with no compiler diagnostic, because
no compilation ever failed. `npm install`, `npm run build`, `npm run build:dev`, `npm run test`
(14/14) and the built Node server all succeeded locally, and the Vite dev server logged a clean
start with no errors:

```
VITE v8.1.5  ready in 2327 ms  →  http://localhost:8080/   (ssr) connected.
```

The failure was therefore **not a compile error but a missing build artifact**: the editor's build
step looks for a Cloudflare Worker bundle at `dist/server` + `dist/client`, and after the
portability stage the build wrote a Node server to `.output/` instead. With `dist/` absent the
pipeline had nothing to deploy and reported the build as unsuccessful.

## 2. Root cause

Confirmed by inspecting the removed preset (`npm pack @lovable.dev/vite-tanstack-config@2.8.1`,
`package/dist/index.js`). When the sandbox environment variables `LOVABLE_SANDBOX=1` /
`DEV_SERVER__PROJECT_PATH` are present, the preset **forces** this Nitro configuration:

```js
nitroOpts.preset = "cloudflare-module";
nitroOpts.output = { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" };
nitroOpts.cloudflare = { nodeCompat: true, deployConfig: true };
```

The Stage-2 portable `vite.config.ts` hard-coded `preset: "node-server"` (output `.output/`) for
every environment. Both markers are set in the editor sandbox (verified: `LOVABLE_SANDBOX=1`,
`DEV_SERVER__PROJECT_PATH=/dev-server`), so the editor build produced the wrong artifact layout.

## 3. Files changed

| Path | Change |
| --- | --- |
| `vite.config.ts` | Build target is now environment-aware. Default is unchanged (`node-server` → `.output/`). When `LOVABLE_SANDBOX=1` or `DEV_SERVER__PROJECT_PATH` is set, and only then, the Nitro preset becomes `cloudflare-module` with `output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" }` and `cloudflare: { nodeCompat: true, deployConfig: true }`. An explicit `NITRO_PRESET` still overrides both. |
| `BUILD_AUDIT.md`, `LOCAL_SETUP.md`, `CHANGELOG.md` | This documentation. |

No database, RLS, Docker, test or other documentation file was modified. No application source
file was touched.

## 4. Packages restored or removed

**None.** No package was added, restored or removed. `@lovable.dev/vite-tanstack-config` and its
transitive builder plugins remain absent from `package.json`, `bun.lock` and `node_modules`.
`npm install` reported `added 1 package, removed 1 package, changed 7 packages` — ordinary semver
drift within existing public dependencies, no builder package.

| Question | Answer |
| --- | --- |
| Does any builder-specific dependency remain? | **No.** The repair is pure standard Vite/Nitro configuration reading two environment variables. |
| Is it development-only? | Not applicable — no dependency exists. The env-var branch is inert outside the editor: neither variable is set on a developer machine, in CI, or in the Docker image. |
| Is builder code imported by application source? | No. `rg -in lovable src/` → 0 hits. |
| Is anything required after cloning outside the editor? | No. A fresh clone builds `node-server` → `.output/` with public npm packages only. |

## 5. Verification results

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm install` | **PASS** (exit 0) |
| Tests | `npm run test` | **PASS** — 14/14 (`tests/authorize.test.ts` 9, `tests/role-parity.test.ts` 5) |
| Portable production build | `NITRO_PRESET=node-server npm run build` | **PASS** — `✓ built in 458ms`, `.output/server/index.mjs` present |
| Portable server boots | `PORT=3111 node .output/server/index.mjs` + `curl /api/public/health` | **PASS** — HTTP 503 `{"status":"degraded","database":"unconfigured"}` (expected with no `DATABASE_URL`; returns 200 `{"status":"ok","database":"reachable"}` when the DSN is set, per the Stage-2 verification) |
| Editor build | `npm run build:dev` inside the sandbox | **PASS** — exit 0; generated `dist/client/`, `dist/server/index.mjs`, `dist/server/wrangler.json`, `dist/nitro.json`, `.wrangler/deploy/config.json` |
| Editor preview | Vite dev server on `:8080` | **PASS** — HTTP 200, no errors in the dev-server log |

## 6. Remaining portability limitation

- The `cloudflare-module` branch is exercised only inside the editor sandbox; it is dead code in a
  clone. It is retained solely so the hosted preview keeps building.
- `dist/` and `.wrangler/` are git-ignored, so the Worker artifact never enters the repository.
- Unchanged from Stage 2: the Docker image build is still **NOT VERIFIED** (no Docker daemon here),
  a clean clone-and-install on a new machine is still unverified, and PostgreSQL was exercised on
  17.9 rather than the documented 16 target.
- Non-operational builder metadata (`AGENTS.md` block, `.lovable/`, `.workspace/`) still exists and
  is read by no install, build, test, run or deploy path.

## Authentication and Authorization Enforcement — completion, 2026-07-30

Environment: PostgreSQL 17.9 on 127.0.0.1:5599, database `airs`, application role `airs_app`
(no SUPERUSER, no BYPASSRLS), Node 22, vitest 4.1.10.

### Commands executed and results

| Command | Result |
| --- | --- |
| `psql "$DATABASE_URL" -f db/migrations/0004_org_context_guard.sql` | exit 0 |
| `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/auth_rls.sql` | exit 0 — 59/59 assertions, "AUTH-RLS: all assertions passed" |
| `TEST_DATABASE_URL=… TEST_ADMIN_DATABASE_URL=… npx vitest run` | exit 0 — 39/39 tests (3 files) |
| `npx vitest run` (no database) | exit 0 — 14 passed, 25 skipped |
| `npx tsgo --noEmit` | exit 0 — no diagnostics |
| Playwright: `/auth`, `/console`, `/invite/<token>` | all render; unauthenticated invite shows the sign-in prompt; no page errors |

### Verification table

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Invitation acceptance route | **VERIFIED** | Renders; org/role read-only from the server-validated row | `src/routes/invite/$token.tsx` | Signed-in acceptance verified at service level, not in-browser |
| Invitation is single-use | **VERIFIED** | Replay returns `invitation_used` | `tests/auth-integration.test.ts` | — |
| Invitation expiry / revocation / resend | **VERIFIED** | `invitation_expired`, `invitation_revoked`, rotated token invalidates the old one | `tests/auth-integration.test.ts` | — |
| Recipient binding | **VERIFIED** | Non-recipient gets `invitation_wrong_recipient`; preview masks the address | `tests/auth-integration.test.ts` | — |
| Identity-plane forced RLS | **VERIFIED** | 59 assertions as `airs_app`, incl. FORCE RLS on all 7 identity tables | `db/tests/auth_rls.sql` | Superusers bypass RLS by design |
| Default deny with no context | **VERIFIED** | 0 rows on all tables; inserts rejected by policy | `db/tests/auth_rls.sql` §2a | — |
| Cross-tenant read/write denial | **VERIFIED** | Org B invisible by known id; UPDATE/DELETE affect 0 rows; inserts rejected | `db/tests/auth_rls.sql` §2d | — |
| Unapproved / malformed GUC denied | **VERIFIED** | Malformed `airs.org_id` → NULL context; unrelated GUC grants nothing | `db/tests/auth_rls.sql` §2b | — |
| Non-active membership grants nothing | **VERIFIED** | invited / suspended / revoked / non-member all yield NULL context | `db/tests/auth_rls.sql` §2e, migration 0004 | — |
| Context does not leak across pooled reuse | **VERIFIED** | Context gone after COMMIT and after ROLLBACK on the same backend | `db/tests/auth_rls.sql` §3 | — |
| Password hashing | **VERIFIED** | PBKDF2-SHA256 210k, per-hash salt, wrong password rejected | `tests/auth-integration.test.ts` | No MFA, no lockout threshold |
| Session lifecycle | **VERIFIED** | Sign-in, resolve, sign-out, expiry; token never stored in clear text | `tests/auth-integration.test.ts` | No refresh/rotation |
| Permission denial is enforced and audited | **VERIFIED** | `visual_observer` → `forbidden`, deny row with the acting user | `tests/auth-integration.test.ts` | — |
| Client-supplied org id rejected | **VERIFIED** | `not_a_member` at the app layer, NULL context at the DB layer | `tests/auth-integration.test.ts`, migration 0004 | — |
| Audit append-only, secret-free | **VERIFIED** | UPDATE/DELETE affect 0 rows; no token/password strings in detail | `tests/auth-integration.test.ts`, `db/tests/auth_rls.sql` | No retention/purge job yet |
| Suite runs without a database | **VERIFIED** | 14 passed, 25 skipped | `npx vitest run` | DB tests need `TEST_DATABASE_URL` + `TEST_ADMIN_DATABASE_URL` |
| Documentation updated | **VERIFIED** | Dated sections added | `SECURITY.md`, `DATABASE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `BUILD_AUDIT.md` | — |
| Signed-in browser walkthrough | **NOT VERIFIED** | Editor dev server has no `DATABASE_URL`; `/console` renders the generic "Session required" state | — | Run locally per `LOCAL_SETUP.md` to exercise the signed-in UI |

## Authentication and Authorization Enforcement — closure verification, 2026-08-02

Validation-and-documentation pass only. No authentication feature was added, no existing work was
redesigned, and no Incident Room Lifecycle work was started.

Environment: fresh PostgreSQL **17.9** cluster (`initdb`, port 5433, database `airs_closure`,
created for this pass and not reused from any earlier run). Migration/fixture role: `postgres`
(cluster owner/superuser). Application/test role: `airs_app` — `rolsuper = f`, `rolbypassrls = f`
(`select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'airs%'` → `airs_app|f|f`).
Node 22, npm, vitest 4.1.10.

### Command results

| # | Exact command | Exit code | Result |
| --- | --- | --- | --- |
| 1 | `npm install` | 0 | `added 1 package, removed 1 package, and changed 6 packages in 3s`; two `npm notice operation is not supported.` lines (sandbox filesystem notice, not a dependency problem). `git status` shows **no change** to `package.json` or `package-lock.json`. No dependency altered. |
| 2a | `npx vitest run` (no database) | 0 | 14 passed, 25 skipped (3 files: 1 skipped) |
| 2b | `TEST_DATABASE_URL=… TEST_ADMIN_DATABASE_URL=… npx vitest run` | 0 | 39 passed, 0 failed, 0 skipped |
| 3 | `npx tsgo --noEmit` | 0 | 0 diagnostics |
| 4 | `npm run build` (portable; `LOVABLE_SANDBOX`/`DEV_SERVER__PROJECT_PATH` unset) | 0 | `.output/` — server entry `.output/server/index.mjs`, client assets `.output/public/assets` (+ `favicon.ico`, `robots.txt`), `.output/nitro.json`. No warnings beyond Nitro's informational preview/deploy hints. |
| 5 | `npm run build:dev` (editor) | 0 | `dist/` — `dist/server/` **present** (`dist/server/index.mjs`), `dist/client/` **present** (`assets`, `_headers`, `favicon.ico`, `robots.txt`), deployment config artifact `dist/server/wrangler.json` **present** (plus `dist/nitro.json`, `.wrangler/deploy/config.json`). Informational note only: `[nitro] Using auto generated worker name: airs-agent`. |
| 6 | Preview `curl -o /dev/null -w '%{http_code}'` on `:8080` | 0 | `/` 200 · `/auth` 200 · `/console` 200 · `/invite/test-invalid-token` 200 |
| 7a | `psql … -f db/migrations/0001_init.sql` (fresh DB) | 0 | applied |
| 7b | `… 0002_roles_seed.sql` | 0 | applied |
| 7c | `… 0003_auth.sql` | 0 | applied |
| 7d | `… 0004_org_context_guard.sql` | 0 | applied |
| 7e | `… db/seed/demo_orgs.sql` | 0 | Albany Police Department + Albany County seeded |
| 7f | `psql … -f db/tests/auth_rls.sql` | 0 | **59/59** assertions, `AUTH-RLS: all assertions passed` |
| 7g | `psql … -f db/tests/rls_matrix.sql` | 0 | tenant CRUD matrix passed |
| 7h | `psql … -f db/tests/role_parity.sql` | 0 | `role model parity: 9 roles, 14 permissions, 34 grants` |
| 7i | live-DB `npx vitest run` against the fresh database | 0 | 39/39 (25 authentication integration tests included) |

Test-count breakdown (item 2): foundation tests **14** (`tests/authorize.test.ts` 9,
`tests/role-parity.test.ts` 5) — unchanged in count and all passing; authentication integration
tests **25** (`tests/auth-integration.test.ts`). Live-database totals: 39 passed / 0 failed /
0 skipped. No-database totals: 14 passed / 0 failed / 25 skipped.

Build portability: the portable build emits a plain Node server started with
`node .output/server/index.mjs`. No Lovable package is present in `package.json`, and no Lovable
runtime service is required to run it. The `cloudflare-module` branch is entered only when the
editor sandbox environment variables are present.

### Preview verification (item 6)

Preview started successfully (Vite dev server, `:8080`). Playwright load of each route, console and
page-error listeners attached:

- `/auth` — renders "Sign in" form. No console errors, no page errors.
- `/console` — unauthenticated access is **denied**, not silently rendered: the page shows the
  "Session required" state with a "Go to sign in" link. No console errors, no page errors.
- `/invite/test-invalid-token` — renders the session-gated prompt ("Sign in with the account this
  invitation was sent to…"). No console errors, no page errors.

**The editor preview has no `DATABASE_URL`.** Server functions therefore cannot reach a database,
so `/console` also reports the generic server-side failure text alongside the deny state. No
database-backed sign-in or organization session was exercised in the browser; interactive
signed-in UI behaviour therefore remains **PARTIALLY VERIFIED** (service-level only).

### Closure status corrections

| Item | Status | Evidence | Why not VERIFIED |
| --- | --- | --- | --- |
| Interactive signed-in user interface | **PARTIALLY VERIFIED** | Routes render, deny states correct; flows proven by `tests/auth-integration.test.ts` | No database-backed browser sign-in session was exercised |
| MFA | **PARTIALLY VERIFIED** (not implemented) | Password-only local adapter; adapter seam allows an OIDC/MFA driver | No second factor exists |
| Rate limiting | **PARTIALLY VERIFIED** (not implemented) | — | No throttle on sign-in or invitation endpoints |
| Account lockout | **PARTIALLY VERIFIED** (not implemented) | — | No failed-attempt threshold |
| Password-reset delivery | **PARTIALLY VERIFIED** (not implemented) | — | No mail transport; invitation tokens are delivered out of band |
| CSRF protection | **PARTIALLY VERIFIED** | Same-origin server functions + `SameSite=Lax`, `HttpOnly`, `Secure` in production | No per-request CSRF token |
| Docker runtime | **PARTIALLY VERIFIED** | `Dockerfile`, `docker-compose.yml` reviewed; non-root user | No Docker daemon available; image never built or run |
| Clean-clone verification | **PARTIALLY VERIFIED** | `npm install` clean in place; lockfile unchanged | No fresh `git clone` into an empty directory was installed and built |
| Fresh empty-database reproduction | **VERIFIED** | New cluster, 0001→0004 + seed, 59/59 RLS assertions, 39/39 tests | PostgreSQL 17.9, not the documented 16 target |
| Foundation tests unchanged | **VERIFIED** | 14/14 pass, same two suites | — |
| Portable + editor builds | **VERIFIED** | `.output/server/index.mjs`; `dist/server` + `dist/client` + `dist/server/wrangler.json` | Worker artifact path is only exercised inside the sandbox |

### Note recorded during this pass

`db/tests/auth_rls.sql` must be run with the migration/owner DSN (as `npm run db:test` does).
Invoking it directly as `airs_app` fails while creating fixtures — FORCE RLS rejecting an
unprivileged `INSERT INTO airs.accounts` — which is correct behaviour. Documented in
`LOCAL_SETUP.md`; no code or test was changed.

## Stage 5 — Incident Room Lifecycle (2026-08-02)

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Incident room data model | COMPLETE | 3 tables, forced RLS, immutability triggers | `db/migrations/0005_incident_rooms.sql` | payload tables (airspace, telemetry) arrive in later stages |
| Lifecycle states + transitions | COMPLETE | draft→scheduled→active⇄paused→closing→closed→archived, server-enforced | `src/lib/incidents/lifecycle.ts`, `incidents.server.ts` | no scheduled auto-activation; expiration closes only |
| Immutable ownership | VERIFIED | `UPDATE ... SET org_id` rejected as `airs_app` | `db/tests/incident_rls.sql` | — |
| Participation + access levels | COMPLETE | invite/accept/approve/restrict/revoke/remove/withdraw | `src/lib/incidents/participation.server.ts` | invitation delivery (email) not implemented; token returned once in the UI |
| Trusted-agency eligibility | COMPLETE | approved-only; no emergency bypass | `src/lib/incidents/trust.server.ts` | partner organizations are selected by ID (no directory endpoint yet) |
| Closure revokes sharing | VERIFIED | closure revokes grants + expires invitations in one transaction | `closeIncident` in `src/lib/incidents/incidents.server.ts` | — |
| Partner isolation under RLS | VERIFIED | 26 assertions as unprivileged `airs_app` | `npm run db:test` (82 ok, exit 0) | — |
| Role/permission parity | VERIFIED | 9 roles / 23 permissions / 52 grants on both sides | `db/tests/role_parity.sql`, `tests/role-parity.test.ts` | — |
| Time-based expiration | IMPLEMENTED, NOT SCHEDULED | `airs.expire_incident_state()` audits every change | `db/migrations/0005_incident_rooms.sql` | no scheduler/endpoint wired yet; must be invoked by cron |
| Typecheck | PASS | no errors | `bunx tsgo --noEmit` | — |
| Unit tests | PASS | 14 passed, 25 integration skipped without `DATABASE_URL` | `npx vitest run` | integration suite not exercised in this run |

## Stage 5A — Branding Integration and Incident Expiration Operations (2026-08-05)

Scope was limited to (1) integrating the approved brand package and Anconison design system,
(2) making `airs.expire_incident_state()` invocable in a portable, secure way, and
(3) revalidating the foundation, authentication and incident-lifecycle stages. No incident-room
feature was redesigned or expanded.

### Verification table

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Brand masters installed | VERIFIED | 10 transparent masters, 7 web icons, 4 manifest icons; alpha channel present on every master | `npm run brand:verify` → "Brand asset verification OK" | artwork is used as delivered; no derivative marks were produced |
| Transparency rules honoured | VERIFIED | emblem/horizontal masters carry a real alpha channel; white-/black-test files are proofs and are never referenced by the app | `scripts/verify-brand-assets.mjs`, `src/components/brand/assets.ts` | no automated contrast check on arbitrary backgrounds |
| Design system tokens | COMPLETE | OKLCH navy / blue / gold sampled from the emblem, exposed as Tailwind v4 `@theme` tokens | `src/styles.css` | tokens cover surface, text, accent and status only |
| Reusable brand components | COMPLETE | `BrandMark`, `BrandLockup`, `BrandHorizontal`, `AppHeader`, `AppFooter`, `PageShell`, `PageHeading`, `SectionCard`, `StatusPill` | `src/components/brand/` | applied to `/`, `/auth`, `/incidents`; other routes inherit shell only |
| PWA icons + manifest | COMPLETE | favicon (16/32/ico), apple-touch-icon, 192/512 maskable-capable icons, manifest wired in the document head | `public/site.webmanifest`, `src/routes/__root.tsx` | not audited by Lighthouse |
| Expiration runner (portable) | VERIFIED | single sweep behind advisory lock 8421701; returns counters only | `src/lib/incidents/expiration.server.ts` | one sweep per invocation; no partial/batched mode |
| Standalone scheduler script | VERIFIED | ran green as the owner role and as the RLS-enforced `airs_app` role | `npm run incidents:expire` → `{"status":"ok",...}` | needs `DATABASE_URL`; no built-in retry |
| HTTP scheduler endpoint | VERIFIED | GET 405; POST without token 401; POST with wrong token 401; POST with correct token 200 + counters; 503 when the secret is unset | `src/routes/api/public/cron/expire-incidents.ts`, tested against `node .output/server/index.mjs` | bearer token only (no mTLS / IP allowlist) |
| Endpoint fails closed | VERIFIED | secret absent or shorter than 24 chars → 503 `scheduler_secret_not_configured`, sweep never runs | same file | — |
| Constant-time token compare | COMPLETE | `timingSafeEqualString` used for the bearer comparison | `src/lib/incidents/expiration.server.ts` | — |
| In-database scheduling option | COMPLETE | optional pg_cron schedule, applied only when the extension exists | `db/scheduler/pg_cron.sql` | pg_cron not installed in the verification cluster; SQL reviewed, not executed |
| Container scheduling option | COMPLETE | dedicated `expiration-scheduler` service in the compose stack | `docker-compose.yml` | no Docker daemon available; compose file reviewed, not run |
| Expiration behaviour proof | VERIFIED | 21 new assertions: overdue invitations/participations expire, tokens destroyed, overdue rooms self-close and revoke partners, retention window marked, not-yet-due rows untouched, access never granted, every change audited, second sweep is a no-op | `db/tests/expiration.sql` via `npm run db:test` | — |
| Full SQL suite | VERIFIED | 104 assertions ok, exit 0 (was 82; +21 expiration, +1 harness) | `npm run db:test` | PostgreSQL 17.9, not the documented 16 target |
| Authentication stage intact | VERIFIED | 39/39 tests pass against a live database (14 unit + 25 integration) | `TEST_DATABASE_URL=… TEST_ADMIN_DATABASE_URL=… npx vitest run` | — |
| Incident lifecycle intact | VERIFIED | all 26 incident RLS assertions still pass unchanged | `db/tests/incident_rls.sql` | — |
| Typecheck | PASS | 0 diagnostics | `npx tsgo --noEmit` | — |
| Portable build | VERIFIED | `.output/server/index.mjs` (21,693 bytes) produced with the builder env vars unset, then booted and served traffic on port 3123 | `npx vite build` with `LOVABLE_SANDBOX` / `DEV_SERVER__PROJECT_PATH` unset | — |
| Editor build | VERIFIED | `dist/server` + `dist/client` produced | `LOVABLE_SANDBOX=1 npm run build` | Worker artifact path is only exercised inside the sandbox |
| No builder dependency added | VERIFIED | brand assets are static files in `public/`; the runner, endpoint, script and scheduler are stock Node/psql/Postgres | `package.json`, `vite.config.ts` | — |

### Operational note

`INCIDENT_EXPIRY_TOKEN` must be at least 24 characters. It is read from the environment only, is
never logged, and is absent from the repository. With it unset the endpoint is disabled rather than
open — the script and pg_cron paths remain available for operators who prefer no HTTP surface.

### Still PARTIALLY VERIFIED after Stage 5A

Docker runtime (no daemon available), pg_cron path (extension not installed), clean-clone install,
interactive signed-in UI in the editor preview, and the authentication gaps recorded in Stage 4
(MFA, rate limiting, account lockout, password-reset delivery, per-request CSRF token).
