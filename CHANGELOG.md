# Changelog

All notable changes. Newest first. Dates are UTC.

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