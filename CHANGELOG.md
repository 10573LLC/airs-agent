# Changelog

All notable changes. Newest first. Dates are UTC.

## [Stage 5A — Branding Integration and Incident Expiration Operations] 2026-08-05

### Added
- Approved AIRS Agent brand package installed under `public/brand/airs-agent/` plus root web icons;
  transparent masters verified by `npm run brand:verify`.
- Anconison design system: OKLCH brand tokens in `src/styles.css` and reusable components in
  `src/components/brand/` (`BrandMark`, `BrandLockup`, `BrandHorizontal`, `AppHeader`, `AppFooter`,
  `PageShell`, `PageHeading`, `SectionCard`, `StatusPill`).
- PWA manifest (`public/site.webmanifest`) and icon links in the document head.
- Portable expiration runner `src/lib/incidents/expiration.server.ts` (advisory lock 8421701).
- Three portable ways to invoke it: `npm run incidents:expire`, the token-protected endpoint
  `POST /api/public/cron/expire-incidents`, and the optional `db/scheduler/pg_cron.sql`.
- `expiration-scheduler` service in `docker-compose.yml`.
- `db/tests/expiration.sql` — 21 assertions covering expiry, revocation, retention, audit coverage,
  no-grant safety and idempotence. Wired into `npm run db:test` (now 104 assertions).

### Changed
- The scheduler endpoint now answers `GET` with 405 instead of falling through to the app shell.

### Verified (no behaviour change)
- `npm run db:test` 104/104 ok; `npx vitest run` 39/39 against a live database; `npx tsgo --noEmit`
  clean; portable build boots and serves; editor build produces `dist/server` + `dist/client`.
- Endpoint security proven end to end: 405 GET / 401 no token / 401 wrong token / 200 correct token
  / 503 when `INCIDENT_EXPIRY_TOKEN` is unset.

### Still PARTIALLY VERIFIED
Docker runtime, pg_cron path, clean-clone install, and the Stage 4 authentication gaps.

## [Authentication and Authorization Enforcement — closure verification] 2026-08-02

### Verified (no code change)
- `npm install` exit 0; `package.json` and `package-lock.json` unchanged.
- `npx vitest run` exit 0 — 14 passed / 25 skipped without a database; 39 passed / 0 failed with
  `TEST_DATABASE_URL` + `TEST_ADMIN_DATABASE_URL` (14 foundation + 25 authentication integration).
- `npx tsgo --noEmit` exit 0, 0 diagnostics.
- `npm run build` exit 0 → `.output/server/index.mjs` + `.output/public`; `npm run build:dev` exit 0 →
  `dist/server`, `dist/client`, `dist/server/wrangler.json`.
- Fresh PostgreSQL 17.9 cluster: migrations 0001→0004 and seed applied clean; `auth_rls.sql` 59/59,
  `rls_matrix.sql` and `role_parity.sql` pass; live-DB suite 39/39. Application role `airs_app` is
  neither SUPERUSER nor BYPASSRLS.
- Preview: `/`, `/auth`, `/console`, `/invite/<invalid>` all HTTP 200 with no console or page errors;
  unauthenticated `/console` renders the deny state.

### Documentation
- `BUILD_AUDIT.md`: added "Authentication and Authorization Enforcement — closure verification".
- `LOCAL_SETUP.md`: recorded that `db/tests/auth_rls.sql` must run with the migration/owner DSN.

### Still PARTIALLY VERIFIED
Interactive signed-in UI (editor preview has no `DATABASE_URL`), MFA, rate limiting, account
lockout, password-reset delivery, CSRF beyond same-origin + `SameSite=Lax`, Docker runtime,
clean-clone install.

## [Lovable Editor Compatibility Repair] 2026-07-30

### Fixed
- Editor "Build unsuccessful" status. The hosted build step expects a Cloudflare Worker artifact at
  `dist/server` + `dist/client`, but the portable config produced a Node server at `.output/` for
  every environment, so no deployable artifact existed. Nothing failed to compile.

### Changed
- `vite.config.ts`: Nitro build target is now environment-aware. Default remains `node-server` →
  `.output/`; only when `LOVABLE_SANDBOX=1` / `DEV_SERVER__PROJECT_PATH` is present does it build
  `cloudflare-module` → `dist/`. `NITRO_PRESET` overrides both.

### Notes
- No package added, restored or removed; no builder dependency exists in the project.
- Verified: `npm install` (exit 0), `npm run test` (14/14), `npm run build` (`.output/server/index.mjs`),
  `npm run build:dev` in-sandbox (`dist/client` + `dist/server`), dev preview HTTP 200.
- No database, RLS, Docker or test file was modified.

## [Stage 1 — Foundation] 2026-07-29

### Added
- PostgreSQL schema `airs` with 12 tables, tenant `org_id` columns, RLS default-deny policies
  (`db/migrations/0001_init.sql`).
- Role/permission reference data: 9 roles, 14 permissions, 34 grants (`db/migrations/0002_roles_seed.sql`).
- Demo tenants Albany Police Department and Albany County (`db/seed/demo_orgs.sql`).
- Executable tenant-isolation SQL test (`db/tests/rls_isolation.sql`).
- Portable RBAC library: `src/lib/rbac/roles.ts`, `src/lib/rbac/authorize.ts`.
- Adapter contracts for database, auth, realtime, object storage and audit (`src/lib/adapters/types.ts`)
  plus a PostgreSQL implementation (`postgres.server.ts`) and env-driven registry (`index.server.ts`).
- Health endpoint with a real database probe (`src/routes/api/public/health.ts`).
- Stage-1 status page replacing the template placeholder (`src/routes/index.tsx`).
- Docker packaging: `Dockerfile`, `docker-compose.yml`, `.env.example`.
- Tests: `tests/authorize.test.ts` (9 tests, all passing).
- Documentation: `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `LOCAL_SETUP.md`, `BUILD_AUDIT.md`, this file.

### Changed
- `package.json`: added `test`, `test:run`, `db:migrate`, `db:seed` scripts.

### Dependencies
- Added: `pg`, `@types/pg` (dev), `vitest` (dev).
- Removed: none.

### Not included
- Authentication, real-time transport, MapLibre map, audit writes, retention purge, application screens.
## Foundation Portability Verification — 2026-07-29

### Removed
- `@lovable.dev/vite-tanstack-config` (package + lockfile entry).
- `src/lib/lovable-error-reporting.ts` and its use in `src/routes/__root.tsx`.
- Builder registry mirror URLs in `bun.lock` (now `registry.npmjs.org`).
- Builder-specific lockfile overrides in `bunfig.toml`.

### Added
- `db/tests/rls_matrix.sql` — 47-assertion tenant isolation matrix (all tenant tables, full CRUD).
- `db/tests/role_parity.sql`, `tests/role-parity.test.ts` — role/permission drift detection.
- `db/init/04_app_role_login.sh`, `.dockerignore`, `db:test` npm script.

### Changed
- `vite.config.ts` rewritten with standard Vite + TanStack Start + Nitro (`node-server`) plugins.
- `Dockerfile`: non-root `USER node`, `HEALTHCHECK`, explicit Nitro preset.
- `docker-compose.yml`: init SQL mounted as individual files (directories were silently ignored),
  `airs_owner`/`airs_app` split, credentials required from `.env`, persistent volume retained.
- `.env.example` placeholders only; `.gitignore` now excludes `.env*`.
- Root route metadata, `README.md` rewritten for AIRS Agent.
- `BUILD_AUDIT.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `LOCAL_SETUP.md` updated.

## 2026-07-30 — Authentication and Authorization Enforcement (complete)

### Added
- `src/routes/invite/$token.tsx` — session-gated, non-enumerating invitation acceptance page.
- `db/migrations/0004_org_context_guard.sql` — organization-context guard in
  `airs.current_org_id()`; `audit_identity_insert` now requires an ACTIVE membership.
- `db/tests/auth_rls.sql` — 59 identity-plane RLS assertions run as `airs_app`.
- `tests/auth-integration.test.ts` — 25 live-database tests of the full enforcement chain.
- `/auth` accepts an optional same-origin `?redirect=` path so an invitation link survives sign-in.

### Changed
- `previewInvitation()` requires a session, masks the recipient address, returns
  `recipientMatches`, and resolves the organization name through the invitation's own context
  instead of a join that RLS correctly blocked.
- `auditIdentityEvent()` writes only to organizations with an ACTIVE membership and no longer lets
  an audit failure break sign-in or sign-out.
- `npm run db:migrate` applies 0001–0004; `npm run db:test` also runs `auth_rls.sql`.

## Stage 5 — Incident Room Lifecycle

- `db/migrations/0005_incident_rooms.sql`: trusted agencies, incident rooms, incident participation,
  immutability triggers, forced RLS, invitation-side read helpers and a scheduled expiration routine.
- `src/lib/incidents/`: pure lifecycle model (`lifecycle.ts`) plus server services for rooms
  (`incidents.server.ts`), participation (`participation.server.ts`) and trust (`trust.server.ts`).
- `src/lib/api/incidents.functions.ts`: validated transport layer; the browser never supplies
  ownership, participation state or access decisions.
- `src/routes/incidents.index.tsx` and `src/routes/incidents.$incidentId.tsx`: room list, invitation
  inbox, lifecycle controls, participant roster and per-room audit history.
- RBAC extended to 23 permissions / 52 grants, in parity across SQL and TypeScript.
- Tests: `db/tests/incident_rls.sql` (26 incident assertions; 82 across the SQL suite) and the
  existing vitest suites, all passing.
