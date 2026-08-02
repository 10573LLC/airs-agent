# Changelog

All notable changes. Newest first. Dates are UTC.

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
