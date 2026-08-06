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

---

# Stage 5B — Incident Expiration Operations

**Date:** 2026-08-05 · **Scope:** implement, secure, test and document the operational process that
invokes the existing `airs.expire_incident_state()`. No incident-room feature was added, redesigned
or expanded; the routine itself is unchanged. Branding, authentication and lifecycle work from
earlier stages is untouched.

### Verification table

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Dedicated maintenance role | VERIFIED | `airs_maintenance` created NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE; assertion "airs_maintenance is not superuser and cannot bypass RLS" passes | `db/migrations/0006_maintenance.sql`, `db/tests/incident_expiration.sql` | password is set outside the repo per deployment; not enforced by the migration |
| Least privilege for that role | VERIFIED | holds no privilege on any tenant table (`role_table_grants` count = 0 outside `maintenance_events`); may execute only the three maintenance functions | assertion "airs_maintenance holds no privilege on any tenant table" | connects over the same network path as the app; no separate network policy shipped |
| Application role can no longer sweep | VERIFIED | `EXECUTE` revoked from `airs_app`; direct call rejected with "permission denied for function expire_incident_state" | assertions 1–8 in `db/tests/incident_expiration.sql` | — |
| Separate maintenance connection | VERIFIED | runner reads `AIRS_MAINTENANCE_DATABASE_URL` only; never the app pool or app role | `src/lib/maintenance/expiration.server.ts`, `.env.example` | operator must actually point it at `airs_maintenance`; a misconfigured URL fails closed at first query |
| Portable CLI runner | VERIFIED | ran green as `airs_maintenance` (exit 0); permission-denied as `airs_app` (exit 1); configuration error unconfigured (exit 1) | `npm run maintenance:expire-incidents` → `scripts/expire-incident-state.mjs` | plain Node + `pg` only; no built-in retry or backoff |
| Scheduler independence | COMPLETE | cron / systemd / Kubernetes CronJob / compose service / pg_cron all documented against the same command | `LOCAL_SETUP.md`, `docker-compose.yml`, `db/scheduler/pg_cron.sql` | compose and pg_cron paths reviewed, not executed (no Docker daemon; extension absent) |
| Protected HTTP endpoint | VERIFIED | 404 when disabled, 405 non-POST, 401 anonymous, 401 session cookie, 401 wrong same-length secret, 400 secret in query, 503 unset/short secret, 429 immediate repeat, 200 correct secret | `tests/maintenance-expiration.test.ts` (10 authorization tests) | shared secret only — no mTLS, IP allowlist or signature scheme |
| Constant-time credential compare | COMPLETE | SHA-256 digests compared with `timingSafeEqual` | `timingSafeEqualString` in `src/lib/maintenance/endpoint.server.ts` | — |
| Secret never disclosed | VERIFIED | secret absent from every response body; rejected in query strings; stripped from audit metadata | assertion "never echoes the secret in a response body"; `airs.strip_sensitive_detail()` | server logs may contain driver errors (not the secret) |
| Maintenance audit events | VERIFIED | every run writes `maintenance.expiration_started` and `maintenance.expiration_completed`; failures write `maintenance.expiration_failed` after rollback | `airs.maintenance_events`, live test "closes the elapsed room and records a maintenance event" | records duration and counts only; no per-row detail |
| Audit trail is append-only | VERIFIED | UPDATE and DELETE rejected for the maintenance role; forced RLS with no UPDATE/DELETE policy | assertions "maintenance audit rows cannot be updated / deleted" | — |
| Maintenance audit isolated from tenants | VERIFIED | `airs_app` has neither SELECT nor INSERT; direct select rejected | assertions 4, 5, 8 in `db/tests/incident_expiration.sql` | no in-app System Auditor screen yet; read via `airs.maintenance_expiration_status()` |
| Correct rows expired, controls untouched | VERIFIED | overdue invitation, overdue participation, elapsed room and elapsed retention window all transitioned; in-window invitation, window-less room and terminal declined row unchanged | assertions in section 3 of `db/tests/incident_expiration.sql` | fixtures cover the four sweep branches, not every status permutation |
| Never grants access | VERIFIED | "sweep granted no new access" and "sweep created no incident room" | `db/tests/incident_expiration.sql` | — |
| Tokens destroyed on expiry | VERIFIED | `token_hash IS NULL` after invitation and participation expiry | same file | — |
| Idempotence | VERIFIED | second run returns all-zero counters; no room, participant or tenant audit row differs | assertions in section 4; live test "is idempotent" | — |
| Concurrency safety | VERIFIED | second concurrent runner returns `skipped_locked = true`, `ran = false`, zero counters, exits cleanly | live test "skips cleanly when another runner already holds the lock" (two real connections) | single global lock — no partitioned or batched sweeps |
| Failure handling | VERIFIED | failure recorded outside the sweep transaction with an error class, never a raw message; runner exits 1 | `expiration.server.ts`, `scripts/expire-incident-state.mjs`, CLI run as `airs_app` | no alerting or paging integration |
| Rate limiting | COMPLETE | one accepted HTTP invocation per `AIRS_MAINTENANCE_MIN_INTERVAL_MS` (default 30s) → 429 | assertion "accepts the correct secret, then rate-limits an immediate repeat" | in-process counter; a multi-instance deployment limits per instance (the DB advisory lock still serialises actual sweeps) |
| No secrets in the repository | VERIFIED | `.gitignore` covers `.env` and `.env.*` except `.env.example`; only placeholders committed | `.gitignore:35-37`, `.env.example` | — |
| Full SQL suite | VERIFIED | 126 assertions ok, exit 0 (was 104; 43 expiration assertions replace the previous 21) | `npm run db:test` | PostgreSQL 17.9, not the documented 16 target |
| Full TypeScript suite | VERIFIED | 53/53 passing against a live database (was 39) | `npx vitest run` with `TEST_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL`, `TEST_MAINTENANCE_DATABASE_URL` | — |
| Typecheck and builds | VERIFIED | `npx tsgo --noEmit` clean; portable build emits `.output/server/index.mjs`; editor build emits `dist/server` + `dist/client` | `npm run build`, `LOVABLE_SANDBOX=1 npm run build` | Worker path exercised only in the sandbox |
| Earlier stages intact | VERIFIED | foundation, authentication and incident-lifecycle suites all still green inside the totals above | `npm run db:test`, `npx vitest run` | — |
| Documentation | UPDATED | maintenance plane documented end to end | `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `LOCAL_SETUP.md`, `CHANGELOG.md` | — |

### Removed in this stage

`src/lib/incidents/expiration.server.ts`, `scripts/expire-incidents.mjs`,
`src/routes/api/public/cron/expire-incidents.ts`, `db/tests/expiration.sql` and the
`INCIDENT_EXPIRY_TOKEN` variable. Their behaviour is superseded by the maintenance plane, which runs
with strictly less privilege. The public `/api/public/cron/...` surface no longer exists.

### Honest limitations

1. The maintenance credential is a database password (or peer/IAM authentication). No secret manager
   integration is shipped.
2. The HTTP trigger is optional and off by default; the CLI runner is the supported primary path.
3. HTTP rate limiting is per process. Actual sweep serialisation is enforced by the database
   advisory lock, which is cluster-wide.
4. Docker and pg_cron scheduling were reviewed but not executed in this environment.
5. There is no in-app screen for maintenance history yet; `airs.maintenance_expiration_status()` is
   the read path.

## Stage 6 — Operational Resource Registry and Readiness Board

| Requirement | Status | Evidence | Limitation |
| --- | --- | --- | --- |
| Organization-owned resource registry | COMPLETE | `db/migrations/0007_resource_registry.sql`, `src/lib/resources/resources.server.ts` | detail fields are a fixed allow-list, no free-form JSON |
| Aircraft / vehicle / dock / launch-site / sensor subtypes | COMPLETE | `airs.resource_aircraft`, `_vehicles`, `_docks`, `_launch_sites`, `_sensors` | serial numbers and restricted notes redacted for partners |
| Personnel operational profiles | COMPLETE | `src/lib/resources/personnel.server.ts` | operational data only — no HR, payroll or medical fields |
| Qualifications and expiry | VERIFIED | `airs.qualification_is_current()`; expiry and revocation assertions | expiry sweep is per-organization and operator-invoked |
| Shifts and duty windows | VERIFIED | `airs.shift_guard()`; overlapping-shift assertion | no recurring-shift generator |
| Readiness states per category | VERIFIED | `airs.resource_category_statuses`, cross-category rejection assertion | — |
| Incident assignment without ownership transfer | VERIFIED | `src/lib/resources/assignments.server.ts`, assignment assertions | one live assignment per resource per room |
| Sharing classifications | VERIFIED | `originating_org_only` and `named_recipients` assertions | classification is per share, not per field |
| Revocation, expiry and closure end access | VERIFIED | `airs.terminate_incident_resource_access()` + closure assertions | — |
| Forced RLS and default deny | VERIFIED | `db/tests/resource_registry_rls.sql` — 52 assertions | run on PG 17.9, documented target is 16 |
| Earlier stages intact | VERIFIED | `npm run db:test` 178 assertions green; `tsgo` clean | Docker/pg_cron paths reviewed, not executed this stage |

## Stage 6 closure verification and disclosure hardening — 2026-08-12

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Fresh-database reproducibility | VERIFIED | cluster dropped and rebuilt from `db/migrations/0001…0008` + seed, no manual repair | `npm run db:migrate && npm run db:seed` | PostgreSQL 17.9, documented target is 16 |
| Full SQL suite | VERIFIED | 241 assertions ok, exit 0 (was 178; +63 disclosure assertions) | `npm run db:test` | disclosure suite runs as `airs_app`, asserted non-superuser |
| Full TypeScript suite | VERIFIED | 61/61 passing against a live database (was 53; +12 disclosure tests, 4 skipped need the maintenance URL) | `npx vitest run` with `TEST_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL` | — |
| Permission parity | VERIFIED | 9 roles / 38 permissions / 92 grants identical in SQL and TypeScript; disclosure adds no new permission and reuses `resource.share` | `db/tests/role_parity.sql`, `tests/role-parity.test.ts` | — |
| Typecheck | VERIFIED | no diagnostics | `npx tsgo --noEmit` | — |
| Both builds | VERIFIED | portable build and editor build both complete; `dist/server` + `dist/client` emitted | `npm run build`, `LOVABLE_SANDBOX=1 npm run build` | Worker path exercised only in the sandbox |
| Preview | VERIFIED | `/`, `/resources`, `/incidents` render, unique titles, zero console errors, unauthenticated view is default-deny ("Session required") | headless load of `http://localhost:8080` | — |
| Disclosure vocabulary parity | VERIFIED | 60 fields / 12 sensitive / 242 profile-grid rows identical in `airs.disclosure_fields` and `disclosure.ts` | `tests/disclosure.test.ts`, `db/tests/disclosure_projection.sql` | vocabulary is fixed; adding a field is a migration |
| Sensitive fields never partner-visible | VERIFIED | excluded from every partner profile and rejected inside a custom profile at both the trigger and the service layer | `disclosure_projection.sql` assertions | — |
| Receiving org cannot widen | VERIFIED | `airs_app` denied `INSERT` on both reference tables; cross-tenant profile change denied as `tenant_mismatch` | `disclosure_projection.sql` | — |
| Narrowing, revocation, closure end field disclosure | VERIFIED | narrowed profile applies to the next read; revoked share and closed room both resolve to zero disclosure | `disclosure_projection.sql` | — |
| Qualification expiry | VERIFIED | expired qualification stops being current the same day; partners see currency only, never the record | `disclosure_projection.sql` | expiry is evaluated per read, no notification |
| Documentation | UPDATED | disclosure model documented end to end | `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `CHANGELOG.md` | — |

### Honest limitations

1. Disclosure is per share and per assignment, not per individual recipient user.
2. The field vocabulary is fixed in migration `0008`; adding a field requires a migration plus the
   matching TypeScript key, and the parity tests fail until both exist.
3. Custom profiles are composed server-side only — there is no interface yet for building one.
4. There is no disclosure-history view; changes are recoverable from `airs.audit_events`, not from a
   dedicated screen.
5. Docker and pg_cron paths were reviewed, not executed, in this environment.

## Stage 7 closure verification (Common Operating Picture)

Environment: PostgreSQL 17.9, PostGIS 3.6.1, fresh empty database `airs_fresh`,
migrations `0001_init.sql` … `0009_common_operating_picture.sql` applied in order
as the owner role; application role `airs_app` (NOT superuser, NOT BYPASSRLS),
maintenance role `airs_maintenance` (same). Migration exit code 0, seed exit code 0.
No manual schema repair was performed.

| Verification item | Status | Evidence | Exact command or file | Remaining limitation |
| --- | --- | --- | --- | --- |
| Fresh database migrates cleanly | VERIFIED | 0001–0009 applied, exit 0 | `npm run db:migrate` against empty DB | sandbox-built PostGIS 3.6.1 |
| Forced RLS, no privileged app role | VERIFIED | `rolsuper=f`, `rolbypassrls=f` | `db/tests/rls_matrix.sql` | — |
| Full SQL assertion suite | VERIFIED | 359 assertions pass, 0 fail, 0 skipped, exit 0 | `npm run db:test` | count exceeds the earlier "309" figure because the matrix and parity scripts are included |
| Full TypeScript suite | VERIFIED | 6 files, 87 tests, 87 passed, 0 failed, 0 skipped, exit 0 | `npx vitest run` | 61 tests are database-backed; without `TEST_DATABASE_URL` they skip |
| Stage 7-specific TS tests | VERIFIED | 22 tests | `tests/map-geography.test.ts` (added this stage) | previously referenced but missing |
| Role/permission parity | VERIFIED | 9 roles, 44 permissions, 114 grants; SQL == TypeScript | `db/tests/role_parity.sql`, `tests/role-parity.test.ts` | — |
| Stage 7 permissions | VERIFIED | `map.read`, `map.feature.manage`, `map.operating_area.propose`, `map.operating_area.approve`, `map.position.report`, `map.precision.manage` | `src/lib/rbac/roles.ts` | `system_auditor` holds none; exactness is not a permission but an ownership/profile outcome |
| Owner receives exact geometry | VERIFIED | owner read returns the exact coordinate pair | `tests/map-geography.test.ts` | — |
| Partner reduced to profile ceiling | VERIFIED | `operational` partner receives `area_only` envelope; exact coordinates absent from the whole payload | same | `view_only` collapses to `withheld` |
| Withheld geometry omitted, not nulled | VERIFIED | `"geometry" in view === false` | same | — |
| Partner cannot widen precision or edit foreign geometry | VERIFIED | all three write attempts rejected; owner record unchanged | same | — |
| Unauthorized organization sees nothing | VERIFIED | third organization sees no features, areas or positions | same | — |
| Positions need BOTH incident participation and a resource share | VERIFIED | empty until `shareResource`, reduced afterwards | same | — |
| Invalid geometry rejected | VERIFIED | out-of-range point and unclosed ring both rejected | same + `db/tests/map_geography_rls.sql` | — |
| Revocation and closure end geography | VERIFIED | partner lists empty immediately after revoke and after close | same | — |
| Freshness from the server clock | VERIFIED | `airs.location_freshness()`; browser never asserts age | `db/migrations/0009` | — |
| Typecheck | VERIFIED | exit 0 | `npx tsgo --noEmit` | — |
| Portable production build + boot | VERIFIED | build exit 0, server answered 200 on `/`, `/map`, `/api/public/health` | `NITRO_PRESET=node-server npm run build` | — |
| Editor build | VERIFIED | exit 0, `cloudflare-module` preset | `LOVABLE_SANDBOX=1 npm run build` | — |
| `/map` configured-provider state | PARTIALLY VERIFIED | route renders, layer controls, feature/area/position lists, freshness labels, withheld markers | `src/routes/map.tsx` | no approved tile service is configured in this environment, so a live basemap canvas was not exercised end to end |
| `/map` missing-provider state | VERIFIED | explicit "Basemap not configured" notice, no third-party provider contacted, lists remain usable, no crash | `src/components/map/cop-map.tsx` | — |
| Silent provider selection removed | VERIFIED (defect fixed) | the previous OpenStreetMap raster fallback was removed; `VITE_MAP_STYLE_URL` is now actually read | `src/routes/map.tsx`, `.env.example` | operator must supply a style URL |
| Attribution | VERIFIED | MapLibre attribution control plus an always-visible `VITE_MAP_ATTRIBUTION` line | `src/components/map/cop-map.tsx` | text is operator-supplied |
| Keyboard-accessible layer controls | VERIFIED | native checkbox fieldset with a legend, reachable and toggleable by keyboard | `src/routes/map.tsx` | controls are presentation-only |
| Status not by colour alone | VERIFIED | every status pill carries text; withheld geography is stated in words | `src/routes/map.tsx` | — |
| Selected-feature non-colour indicator | NOT VERIFIED | the page has no map-selection concept in Stage 7 | — | selection is a later stage |
| Responsive layout | PARTIALLY VERIFIED | desktop and tablet/mobile grid collapse via `lg:` breakpoints | `src/routes/map.tsx` | no device-lab measurement was performed |

No Stage 8 work, external integration, telemetry, ADS-B, Remote ID, weather or
vendor connector was started. The only code changes were the missing Stage 7
test suite and the map-provider/layer-control defects listed above.

## Stage 8 — Manual Airspace Observations and Awareness Layer (closure, 2026-08-18)

Closure pass only. No new operational features, no map-click coordinate picker.

### 1. Test isolation defect

**Symptom.** After a TypeScript run, `npm run db:test` failed at
`db/tests/auth_rls.sql:229` with
`AUTH-RLS FAIL: org A context: sees the four org A memberships`. The database
had to be dropped and rebuilt before the SQL suite would pass again.

**Root cause (two independent faults).**
1. The database-backed TypeScript suites (`auth-integration`, `map-geography`,
   `awareness`) created accounts, users, memberships, organizations, incident
   rooms, resources, map features, observations and audit evidence and removed
   only a fraction of it. Residue accumulated linearly: after three runs the
   database held 8 organizations, 45 accounts, 45 observations and 285 audit
   events instead of the seeded 2/0/0/0.
2. One SQL assertion counted a whole table (`count(*) FROM airs.memberships = 4`)
   rather than the fixtures it had created, so any unrelated org A membership
   broke it.

**Fix.**
- Added `tests/support/fixtures.ts` with `cleanupRunFixtures()` and
  `ensureTrustedAgency()`. Every suite tags its accounts with a per-run token
  and, in `afterAll`, deletes every row reachable from that run's accounts,
  users and organizations in foreign-key-safe order across the awareness,
  resource, geography, incident and identity planes. Append-only triggers
  (audit events, observation annotations) are suspended for the duration of the
  delete via `session_replication_role = replica` on the fixture-owner
  connection only; application roles never run in that mode.
- Shared demo-org state is restored, not just fixture rows:
  `ensureTrustedAgency()` reports whether it created the Albany PD → Albany
  County trust approval, and only a run that created it removes it.
- Added `vitest.config.ts` with `fileParallelism: false`. This is a correctness
  requirement: concurrent suite files would let one suite's restoration of a
  shared demo row land while another suite still depends on it.
- `db/tests/auth_rls.sql` now asserts against the four fixture membership ids
  (`mship_a`, `mship_invited`, `mship_suspended`, `mship_revoked`) instead of a
  table-wide count. The assertion is strictly stronger: it proves the org A
  context sees each specific fixture row.

**Proof.** Three consecutive cycles of `db:test` + `vitest run` against the same
database, with a row census taken after each cycle:

| Cycle | SQL assertions | TypeScript | orgs | accounts | observations | memberships | audit events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 408 pass, exit 0 | 124 passed, 4 skipped, exit 0 | 2 | 0 | 0 | 0 | 0 |
| 2 | 408 pass, exit 0 | 124 passed, 4 skipped, exit 0 | 2 | 0 | 0 | 0 | 0 |
| 3 | 408 pass, exit 0 | 124 passed, 4 skipped, exit 0 | 2 | 0 | 0 | 0 | 0 |

`airs.trusted_agencies` returns to 0 rows after every cycle. The database is
byte-for-byte back to its seeded state; no rebuild is required between runs.
Before the fix, cycle 2 exited 3.

### 2. Verification results (this pass)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `tsc --noEmit` | exit 0, no diagnostics |
| SQL assertions | `npm run db:test` | 408/408, three times |
| TypeScript suite | `vitest run` | 7 files, 124 passed / 4 skipped, three times |
| Fresh migration chain | `0001 → 0010` + `db/seed/demo_orgs.sql` | exit 0 on an empty database (PostgreSQL 17.9 / PostGIS 3.6.1) |

The 4 skips are pre-existing and unrelated to Stage 8 (they gate on optional
environment).

### 3. Documentation closure

`BUILD_AUDIT.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`,
`LOCAL_SETUP.md`, `CHANGELOG.md` each carry a Stage 8 section titled
*Manual Airspace Observations and Awareness Layer*. `DESIGN_SYSTEM.md` was
created in this pass (it did not previously exist) and documents the token
layer, the awareness status palette and the disclosure-absence convention.

### 4. Stage 8 status

| Item | Status | Evidence | Limitation |
| --- | --- | --- | --- |
| Observation schema + forced RLS | COMPLETE | `db/migrations/0010_awareness_observations.sql` (7 tables) | — |
| Awareness RBAC | COMPLETE | 12 `observation.*` permissions in `src/lib/rbac/roles.ts` | — |
| Service layer | COMPLETE | `src/lib/awareness/awareness.server.ts` | — |
| Awareness interface | COMPLETE | `/awareness`, `/awareness/$observationId` | No map-click point picker (deferred by instruction) |
| Map awareness layer | COMPLETE | layer toggle in `src/routes/map.tsx` | Withheld reports are counted, never plotted |
| Dedicated SQL verification | VERIFIED | `db/tests/awareness_observations_rls.sql`, 99 assertions | — |
| Dedicated TS verification | VERIFIED | `tests/awareness.test.ts`, 41/41 | — |
| Repeatable test runs | VERIFIED | table above, three cycles, no rebuild | Requires the fixture-owner role for cleanup |
| Documentation | COMPLETE | seven documents | — |


---

# Platform Administration Bootstrap — 2026-08-05 (UTC)

Scope: create the secure bootstrap path for the first AIRS Agent platform administrator. No Stage 9
work, no operational features.

| Requirement | Status | Evidence | Limitation |
|---|---|---|---|
| Authentication not weakened | COMPLETE | no change to `local-adapter.server.ts` credential path; activation ends in a normal PBKDF2 sign-in | — |
| No seed/test credentials exposed | COMPLETE | no credential in repo; fixtures use placeholder hashes | — |
| Builder collaborator identity is not an app account | COMPLETE | accounts exist only in `airs.accounts`; no external identity is trusted | — |
| Pre-existing identity check | COMPLETE | `airs.platform_identity_report()`, run for every address by the CLI | Aggregates only, by design |
| No duplicate account / safe replacement | COMPLETE | bootstrap revokes pending invitations first; activation refuses when an account exists | — |
| One-time bootstrap invitation | COMPLETE | `airs.bootstrap_platform_invitation()`; single-use claim in `acceptInvitation()` | — |
| Top-level platform role | COMPLETE | `platform_admin` (migration 0011, `src/lib/rbac/roles.ts`) | New role: none existed |
| Platform org instead of Albany | COMPLETE | `anconison-platform` (`org_kind = 'platform'`) | Org context is required by the data model |
| Plane separation | COMPLETE | `airs.enforce_platform_role_scope()` trigger; zero operational permissions | — |
| Invitation expires | COMPLETE | `expires_at`, default 72 h, clamped 300 s .. 7 d | — |
| Invitation cannot be reused | COMPLETE | conditional `UPDATE ... WHERE status = 'pending'` | — |
| Audited | COMPLETE | `platform.bootstrap_invitation_created`, `invitation.accepted`, `auth.sign_in` | — |
| No secrets committed | COMPLETE | token generated in CLI, only its SHA-256 hash leaves the process | — |
| Forced RLS / isolation preserved | COMPLETE | no policy relaxed; 0011 adds a trigger and two revoked-from-PUBLIC routines | — |
| Unauthenticated users denied | VERIFIED | `/console` renders "Session required"; `db/tests/platform_admin_rls.sql` section 6 | — |
| Platform admin sees no agency records | VERIFIED (SQL) | `db/tests/platform_admin_rls.sql` section 5; `tests/authorize.test.ts` | Assertions authored this pass; execution needs a live database |
| Albany organizations untouched | COMPLETE | no change to `db/seed/demo_orgs.sql`; assertion in section 1 of the new SQL suite | — |
| Platform tenant display name is ASCII | COMPLETE | `Anconison - AIRS Agent Platform` in 0011 and 0012; `tests/platform-org-name.test.ts`, `db/tests/platform_org_name.sql` | Existing databases need migration 0012 applied |
| Typecheck | VERIFIED | `tsc --noEmit` exit 0 | — |
| Build | VERIFIED | `npm run build` exit 0 | — |
| TypeScript suite | VERIFIED | `vitest run` — 6 files, 59 passed, database-backed suites skipped without `DATABASE_URL` | Database-backed suites not executed in this environment |
| SQL suite | NOT RUN HERE | `npm run db:test` now includes `db/tests/platform_admin_rls.sql` | No PostgreSQL instance in the build environment; run locally |

---

# Stage 8.2 — Windows Bootstrap Hardening — 2026-08-06 (UTC)

Scope: three portability defects discovered during the verified Windows activation of
the first real platform administrator, plus documentation. No Stage 9 work, no new
operational features.

## 1. Requested requirements

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `.gitattributes` forcing LF for `*.sh` | COMPLETE | `.gitattributes` (`*.sh text eol=lf`, plus `text=auto eol=lf` default, `*.ps1 eol=crlf`, binary assets excluded) |
| 2 | Existing shell scripts normalized to LF, behaviour unchanged | COMPLETE | `db/init/04_app_role_login.sh`, `db/init/05_maintenance_role_login.sh` already LF; contents untouched |
| 3 | Repository check failing on CRLF `.sh` | COMPLETE | `scripts/check-line-endings.mjs`, `npm run check:line-endings`, `tests/line-endings.test.ts` |
| 4 | Portable Node migration runner, same command name | COMPLETE | `scripts/db-migrate.mjs`, `scripts/lib/migrate-plan.mjs`, `package.json` `db:migrate` |
| 5 | Local `psql` first, else `docker compose exec -T db psql` | COMPLETE | `planMigration()`; unit tests in `tests/db-migrate.test.ts` |
| 6 | `ON_ERROR_STOP=1`, established order, nonzero exit on failure | COMPLETE | `MIGRATION_FILES` 0001→0011; per-step exit-code check |
| 7 | Never logs passwords or database URLs | COMPLETE | `redact()`; asserted in `tests/db-migrate.test.ts` |
| 8 | Works on Windows PowerShell / Linux / macOS, no Lovable dependency | COMPLETE (Windows path exercised by the operator; sandbox has no Docker) | Node-only, no shell composition |
| 9 | Never silently starts or deletes containers | COMPLETE | `NO_PATH_ERROR` instructs the operator instead |
| 10 | `platform-admin:setup -- --help` exits 0 without `--email` | COMPLETE | `scripts/lib/platform-admin-cli.mjs`; `tests/platform-admin-cli.test.ts` |
| 11 | Help documents all flags, env vars, effects, secrecy, PowerShell, `--new-link`, activation-creates-account | COMPLETE | `HELP_TEXT`; assertions in `tests/platform-admin-cli.test.ts` |
| 12 | Unknown flags fail clearly with nonzero exit | COMPLETE | exit code 2 + supported-flag list |
| 13 | Security architecture unchanged | COMPLETE | no change to `db/migrations/*`, `src/lib/auth/*`, `src/lib/rbac/*` |
| 14 | Documentation updated | COMPLETE | `LOCAL_SETUP.md` §9, `README.md`, `SECURITY.md`, `ARCHITECTURE.md`, this file, `CHANGELOG.md` |

## 2. Validation

| Check | Result |
| --- | --- |
| `npm run check:line-endings` | PASS — 2 tracked shell scripts, all LF |
| `tsc --noEmit` | PASS (exit 0) |
| `vitest run` | PASS — 10 files, 77 passed, 70 skipped (DB-backed suites skip without PostgreSQL) |
| Role parity (`tests/role-parity.test.ts`) | PASS — 5/5 |
| Bootstrap/authorization (`tests/authorize.test.ts`) | PASS — 10/10 |
| Migration-runner unit tests | PASS — 7/7 |
| Setup-help tests | PASS — 6/6 |
| `npm run build` (portable) | PASS |
| `npm run build:dev` (editor) | PASS |
| `npm run platform-admin:setup -- --help` | PASS — exit 0 |
| `npm run db:test` (408 SQL assertions) | ENVIRONMENT-BLOCKED — no PostgreSQL in this sandbox |
| Docker Compose fallback executed end-to-end | ENVIRONMENT-BLOCKED — no Docker daemon in this sandbox (logic unit-tested; operator verified on Windows) |

## 3. Limitations

- The Docker fallback is proven by unit tests over the command plan, not by a live
  `docker compose exec` run in this environment.
- Database-backed TypeScript suites and every SQL assertion suite are skipped here;
  they must be re-run against a live PostgreSQL 16 instance.

## Stage: Migration State Tracking and Pending-Only Execution (2026-08-06)

**Root cause.** The runner had no persistent state. `scripts/lib/migrate-plan.mjs` planned a
full replay of a hard-coded file list on every invocation, so a Windows installation with
`0001`–`0011` already applied and `0012` pending restarted at `0001` and failed with
`relation "organizations" already exists`; `0012` had to be applied by hand.

**Fix.**
- `db/migrations/manifest.txt` - one canonical, ordered migration list read by both the Node
  runner and the Docker initialization script (no second list that can drift).
- `db/ledger/0000_migration_ledger.sql` - `airs_migrations.applied_migrations` (version,
  filename, SHA-256 checksum, applied_at, duration_ms, runner_version, app_release, adopted),
  immutability trigger, `assert_pending()` and `record_applied()`; all privileges revoked from
  `airs_app` and `airs_maintenance`.
- `db/ledger/adopt_verify.sql` - verification-only adoption gate (schemas, tables, RLS + policies,
  functions, roles, platform organization values, `platform_admin` separation, Albany tenants,
  role parity 10/56/175).
- `scripts/lib/migrate-plan.mjs` - checksums, version sort, applied/pending/conflict diff,
  transaction + advisory-lock script composition, adoption script, read-only status scripts,
  identical stdin for the psql and Docker paths.
- `scripts/db-migrate.mjs` - pending-only apply, `--dry-run`, `--status`, `--adopt-existing`,
  `--lock-timeout-ms`, refusal to replay a pre-ledger existing database (exit 5), checksum
  conflict stop (exit 3), lock contention exit (6), redaction everywhere.
- `docker-compose.yml` + `db/init/00_apply_migrations.sh` - fresh databases apply the manifest in
  order and record every migration in the same ledger.

**Validation.** `tests/db-migrate.test.ts` - 31 assertions (manifest/order/checksums,
pending-only diffs, one ledger row per migration, transaction + lock ordering, failure leaves no
ledger row, checksum-conflict stop, adoption verification/record-without-execute/failure modes,
ledger access model, dry-run and status read-only + credential-free, psql/Docker parity).
Database-executed checks (fresh migrate, second no-op run, live adoption, concurrency race,
`npm run db:test`, role parity in-database) are **environment-blocked**: no PostgreSQL or Docker
daemon is available in the build environment. No Stage 9 or operational feature work was started.

## Docker/PostGIS deployment defect and legacy repair

Root cause: the Compose `db` service used `postgres:16-alpine`, which ships no
PostGIS. Migration 0009 aborted with `extension "postgis" is not available`;
0010 then aborted with `type public.geometry does not exist`.

| Item | Before | After |
| --- | --- | --- |
| Database image | `postgres:16-alpine` | `postgis/postgis:16-3.6-alpine` |
| PostgreSQL major | 16 | 16 (volume reused as-is) |
| PostGIS | absent | 3.6, enabled before migration 0009 |

Verified in this environment (`npx vitest run`, `npm run typecheck`,
`npm run check:line-endings`, `npm run build`, `npm run build:dev`):

* pinned PostGIS image, no `latest`, volume/db/roles/ports/health check preserved
* fresh-install path enables PostGIS before 0009 and rejects a plain PostgreSQL
  image with an actionable error
* per-migration state probes exist for 0001-0012 with >= 2 concrete checks each
* the exact known noncontiguous live state is detected (0001-0008 present,
  0009/0010 missing, 0011/0012 present)
* repair plans only 0009 and 0010; 0011/0012 are never replayed
* partial or out-of-scope missing migrations abort the repair
* 0009/0010 are single advisory-locked transactions, write no ledger row while
  applying, and retry cleanly once PostGIS exists
* the ledger records exactly 0001-0012 with current checksums, refuses a
  populated ledger, and keeps `airs_app`/`airs_maintenance` denied
* repair requires `--confirm --backup-confirmed`, is not reachable from
  `npm run db:migrate` or Docker init, and prints no credentials

Environment-blocked (no Docker/PostgreSQL daemon in this build environment;
these are host procedures documented in LOCAL_SETUP.md):

* live container recreation of an existing PostgreSQL 16 volume under the PostGIS image
* live `CREATE EXTENSION postgis` / `postgis_full_version()` execution
* live data-intactness counts after recreation
* live end-to-end repair run, live SQL suite / role parity execution
  (10 roles / 56 permissions / 175 grants), live ledger contents and the
  live "second run reports zero pending" check
