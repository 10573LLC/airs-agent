# Changelog

All notable changes. Newest first. Dates are UTC.

## [Common Operating Picture Usability] 2026-08-08

### Added

- Map controls: "Reset view" (returns to the AIRS default Albany camera without a
  page reload) and "Fit visible data" (frames only geometry already drawn from
  enabled layers; with nothing visible it leaves the camera untouched and shows a
  subtle status line).
- Collapsible legend using the existing overlay tones, plus a transient
  working-point marker and a click-through info panel that shows only the label,
  detail and layer already released to the reader.

### Changed

- Default zoom 11.4 → 11.2 for regional orientation; layer checkboxes regrouped
  as a responsive "Operational layers" grid; compact map status line (incident
  scope, drawn authorized item count, working-point state, clear action).

UI/presentation only: no database, migration, PostGIS, RLS, role, permission,
auth, API, disclosure or Docker change; `VITE_MAP_STYLE_URL` behaviour untouched.

## [Platform Verification Column Fix] 2026-08-06

### Fixed

- Migration adoption/reconciliation failed with `ERROR: column u.email does not exist`
  in `buildPlatformVerificationScript()`. The verifier joined `airs.users` and
  filtered on `lower(u.email)`, but the canonical column has always been
  `email_address`. Changed the single predicate to `lower(u.email_address)`.
  No schema, migration, RLS policy, role, permission, membership, identity-model
  or application change.

### Added

- `tests/db-repair-legacy.test.ts` regression check: the platform-admin lookup
  uses `u.email_address`, never `u.email`, while preserving the existing
  `m.user_id = u.id` join and the `anconison-platform` / `platform_admin` filters.

## [Platform Admin Test-Fixture Fix] 2026-08-06

### Fixed

- `db/tests/platform_admin_rls.sql` section 5 resolved the platform probe
  account id _after_ `SET LOCAL ROLE airs_app`, where `airs.accounts` is
  RLS-restricted. The lookup yielded NULL, so the assertion "a platform
  administrator cannot assume an agency organization context" actually
  exercised the documented account-less, tenant-only branch of
  `airs.current_org_id()` and failed. The account id is now resolved with
  fixture privileges and carried across the role switch in a transaction-local
  setting. Test fixture only: no schema, migration, RLS policy, permission or
  application change.

### Added

- Fixture preconditions (account exists, exactly one active `platform_admin`
  membership in `anconison-platform`, no Albany membership, Albany users probe
  retained) plus assertions that account-less tenant-only context and
  invitation-redemption context behaviour are unchanged.
- `tests/platform-admin-fixture.test.ts` (7 checks) guards the ordering so the
  lookup can never drift back behind the restricted role.

## [SQL Test-Harness Fix and Reconciled-State Adoption] 2026-08-06

### Fixed

- `ERROR: schema "pg_temp" does not exist` during reconciliation/adoption
  verification. Cause: the runner wrapped session-scoped suite files in an extra
  `BEGIN; ... ROLLBACK;`, so a file's own intermediate `ROLLBACK` destroyed the
  temporary assertion helpers. A harness defect only; the AIRS schema, RLS
  policies, permissions and migrations 0001-0012 are unchanged.

### Added

- `scripts/lib/sql-suite.mjs`: the ONE canonical SQL verification-suite runner.
  One file per session, no runner-supplied transaction, stops at the first
  failing file, and statically rejects files whose temporary helpers cannot
  survive their own transaction handling.
- `scripts/db-test.mjs` behind `npm run db:test` (replaces the inline psql list).
- Adoption now verifies PostGIS, the full canonical object inventory, the SQL
  suite, `db/repair/reconcile_verify.sql`, role parity (10/56/175) and the
  platform administrator before recording 0001-0012. Optional `--admin-email`.
- `npm run db:reconcile-legacy` exits immediately on an already reconciled
  database and points at `npm run db:migrate:adopt`.

### Removed

- `buildVerificationScript` from `scripts/lib/migrate-plan.mjs`.

### Documentation

- `LOCAL_SETUP.md`, `DATABASE.md`, `BUILD_AUDIT.md`: root cause, canonical
  runner, completion path, and the explicit prohibitions (no
  `docker compose down -v`, no manual migration replay, no reconciliation run
  merely to populate the ledger).

## [Cumulative Legacy-Schema Reconciliation] 2026-08-06

### Added

- `npm run db:reconcile-legacy` (`scripts/db-reconcile-legacy.mjs`): operator-only,
  report-first reconciliation of a noncontiguous legacy database. Probes 94
  canonical post-0012 objects individually and creates only those genuinely
  absent, idempotently, in advisory-locked transactions. Execution requires
  `--confirm --backup-confirmed`.
- `scripts/lib/canonical-schema.mjs`: the canonical cumulative object inventory
  plus `SUPERSEDED_OBJECTS`, which records objects that must never be required
  or recreated, with their current equivalents and reasons.
- `scripts/lib/idempotent-sql.mjs`: deterministic transform of a canonical
  migration into a re-runnable reconciliation body, with a destructive-statement
  guard (`DROP TABLE`/`DROP COLUMN`/`DROP ROLE`/`TRUNCATE`/`DELETE FROM`).
- `scripts/lib/reconcile-legacy.mjs`: object probes, planning, conflict
  detection and the operator report.
- `db/repair/reconcile_verify.sql` and `db/repair/README.md`: security, tenancy,
  disclosure, precision and closure assertions that gate ledger adoption.
- `tests/db-reconcile-legacy.test.ts`: 34 assertions reproducing the exact live
  Windows state and proving report accuracy, idempotency, non-destructiveness,
  ordering, role parity derivation and ledger-after-verification.

### Fixed

- **False-positive `PARTIAL` classifications.** The legacy repair probes
  demanded `airs.has_permission` (0003) and `airs.disclosure_profiles` (0008).
  Neither is created by any migration in the manifest: permission evaluation
  lives in the TypeScript RBAC model plus RLS predicates over the session GUCs,
  and Stage 6 disclosure is modelled as `airs.disclosure_fields` +
  `airs.disclosure_profile_fields`. A complete database was therefore reported
  as partial. `STATE_PROBES` is now derived from the canonical inventory.
- `db/ledger/adopt_verify.sql` demanded `airs.has_permission`,
  `airs.disclosure_profiles` and the never-created `airs.aircraft`,
  `airs.vehicles`, `airs.sensors` and `airs.personnel`. Replaced with the
  canonical `airs.resource_aircraft`, `airs.resource_vehicles`,
  `airs.resource_sensors`, `airs.personnel_profiles`, `airs.resource_shares` and
  the current function set.
- `db/tests/role_parity.sql` printed an expected grant count of 171 while
  asserting 175. Both now state 175, matching the TypeScript RBAC model
  (10 roles / 56 permissions / 175 grants).
- The legacy repair refusal now points operators at the reconciliation command
  instead of leaving a partial database with no supported next step.

### Unchanged

- No numbered migration, schema, role, permission or application feature was
  added or altered. No Stage 9 work was started.

## [PostGIS Docker Image Tag Correction] 2026-08-06

### Fixed

- Corrected the Docker Compose `db` service image from the non-existent
  `postgis/postgis:16-3.6-alpine` to the verified `postgis/postgis:16-3.5-alpine`.
  PostgreSQL major version 16, the existing named volume, ports, health check,
  passwords and service names are unchanged.

### Changed

- Documentation and tests updated to state PostGIS 3.5 where applicable:
  `docker-compose.yml`, `db/init/00_apply_migrations.sh`,
  `scripts/lib/legacy-repair.mjs`, `DATABASE.md`, `README.md`, `ARCHITECTURE.md`,
  `LOCAL_SETUP.md`, `BUILD_AUDIT.md`, `CHANGELOG.md`.

## [Migration State Tracking and Pending-Only Execution] 2026-08-06

### Fixed

- `npm run db:migrate` restarted at `0001` on a database whose migrations were already applied
  and failed with `relation "organizations" already exists`. The runner now tracks applied
  migrations persistently and applies only pending ones.

### Added

- `airs_migrations.applied_migrations` migration ledger (`db/ledger/0000_migration_ledger.sql`):
  version, filename, SHA-256 checksum, applied timestamp, duration, runner version, app release.
  Immutable rows; no access for `airs_app` or `airs_maintenance`.
- `db/migrations/manifest.txt` - single canonical migration order shared by the Node runner and
  Docker initialization (`db/init/00_apply_migrations.sh`).
- `npm run db:migrate -- --dry-run`, `npm run db:migrate:status`, `npm run db:migrate:adopt`
  (explicit, verification-first adoption of an existing pre-ledger database, never automatic,
  never replaying migration SQL), `--lock-timeout-ms`.
- `db/ledger/adopt_verify.sql` adoption verification gate.
- 31 migration-runner assertions in `tests/db-migrate.test.ts`.

### Changed

- One transaction per migration: advisory lock -> pending guard -> migration SQL -> ledger row ->
  commit. A failed migration rolls back, records nothing and stops the run.
- Documentation: `README.md`, `LOCAL_SETUP.md` (Windows recovery procedure), `DATABASE.md`,
  `ARCHITECTURE.md`, `SECURITY.md`, `BUILD_AUDIT.md`.

## [Platform Tenant Display Name Fix] 2026-08-06

### Fixed

- The platform tenant rendered as `Anconison ??? AIRS Agent Platform` on Windows installations.
  Migration 0011 seeded the name with a Unicode em dash; a psql client running with a cp1252
  console encoding cannot represent it, so replacement characters were stored. The canonical
  display name is now plain ASCII: `Anconison - AIRS Agent Platform`.

### Added

- `db/migrations/0012_fix_platform_org_display_name.sql` — idempotent repair. Updates only the
  organization whose slug is `anconison-platform`, raises if duplicates exist, leaves id, slug,
  `org_kind`, memberships, roles, permissions, invitations, authentication records and the Albany
  agency tenants untouched, and writes a `platform.display_name_repaired` audit event.
- `db/tests/platform_org_name.sql` (wired into `npm run db:test`) and
  `tests/platform-org-name.test.ts` — 8 assertions covering name, slug, `org_kind`, tenant id,
  Albany tenants, `platform_admin` permission set, scope and idempotency of the repair.

### Changed

- `db/migrations/0011_platform_administration.sql` seeds the ASCII name so fresh databases are
  correct without the repair; `scripts/lib/migrate-plan.mjs` runs 0012 last.

## [Platform Administration Bootstrap] 2026-08-05

### Added

- `db/migrations/0011_platform_administration.sql` — platform administration plane:
  `airs.organizations.org_kind` (`agency` | `platform`, unique partial index allowing exactly one
  platform tenant), the `Anconison - AIRS Agent Platform` organization, the `platform_admin` role
  with four platform-only permissions (`org.manage`, `user.manage`, `audit.read`,
  `retention.manage`), a `BEFORE INSERT/UPDATE` guard on `memberships`, `user_roles` and
  `invitations` keeping `platform_admin` out of agency tenants (and agency roles out of the
  platform tenant), plus two operator-only `SECURITY DEFINER` routines:
  `airs.platform_identity_report(text)` and `airs.bootstrap_platform_invitation(text, text, int)`.
  Neither is executable by `airs_app`.
- `scripts/bootstrap-platform-admin.mjs` (`npm run bootstrap:platform-admin`) — portable Node
  runner. Generates the one-time token locally, sends only its SHA-256 hash to the database,
  reports pre-existing identity records, refuses to duplicate an active platform administrator,
  and prints the single-use link to stdout only.
- `src/lib/auth/activation.server.ts`, `previewActivationFn` / `activateAccountFn`, and
  `/activate/$token` — first-time account activation from a single-use invitation. Address,
  organization and role come from the stored invitation row; an existing account is never
  overwritten (the recipient is sent to normal sign-in + `/invite/$token`).
- `db/tests/platform_admin_rls.sql` — plane-separation assertions.

### Changed

- `src/lib/rbac/roles.ts`, `db/tests/role_parity.sql`, `tests/role-parity.test.ts`,
  `tests/authorize.test.ts` — role model is now 10 roles / 56 permissions / 175 grants.

### Security

- No token, token hash, password or recovery value is written to the audit trail, the structured
  log lines, the repository or this changelog.
- A platform administrator holds no `incident.*`, `resource.*`, `map.*`, `observation.*`,
  `airspace.*` or `personnel.*` permission, and `airs.current_org_id()` still requires an ACTIVE
  membership, so agency-owned operational records remain unreachable from the platform plane.

## [Stage 6 closure — Disclosure Hardening] 2026-08-12

### Added

- `src/lib/resources/disclosure.ts` — portable field-level disclosure model: 60 field keys, 12 of
  them sensitive, five partner-selectable profiles (`summary`, `operational`, `aviation`,
  `incident_command`, `full`) plus `custom`, cumulative widening, and `projectFields()`, which
  deletes withheld properties instead of nulling them.
- `db/migrations/0008_disclosure_profiles.sql` — `airs.disclosure_fields`,
  `airs.disclosure_profile_fields`, `airs.disclosure_allows()`, `airs.effective_disclosure()`,
  `airs.assignment_current_qualifications()`, and `disclosure_profile` / `custom_field_keys` on
  `airs.resource_shares` and `airs.incident_assignments` with a sensitivity-enforcing trigger.
- `db/tests/disclosure_projection.sql` — 63 assertions, run as `airs_app` with no superuser and no
  `BYPASSRLS`, covering the summary floor, cumulative widening, sensitive-field exclusion, custom
  profiles, named recipients, narrowing, revocation and room closure.
- `tests/disclosure.test.ts` — 12 pure tests asserting SQL/TypeScript parity and projection.

### Changed

- `resources.server.ts` and `assignments.server.ts` resolve disclosure per read instead of applying
  a flat redaction list; `shareResourceFn`, `assignToIncidentFn` and the new `setShareDisclosureFn`
  accept a profile.
- The readiness board names the profile in effect on every partner-shared record, and the incident
  assignment panel lets the owning agency choose the profile when offering a record.

## [Stage 5B — Incident Expiration Operations] 2026-08-05

### Added

- `db/migrations/0006_maintenance.sql`: dedicated `airs_maintenance` role (NOSUPERUSER,
  NOBYPASSRLS, no privilege on any tenant table), the append-only non-tenant
  `airs.maintenance_events` table with forced RLS, and three narrow SECURITY DEFINER entry points —
  `airs.run_incident_expiration()`, `airs.record_maintenance_event()`,
  `airs.maintenance_expiration_status()` — plus `airs.strip_sensitive_detail()`.
- `src/lib/maintenance/` — portable runner (`expiration.server.ts`), endpoint authorization
  (`endpoint.server.ts`) and shared types.
- `scripts/expire-incident-state.mjs` — primary CLI runner (plain Node + `pg`), structured JSON
  logging, exit 0 on sweep or lock-skip, exit 1 on failure. `npm run maintenance:expire-incidents`.
- `POST /api/maintenance/expire-incidents` — optional, disabled by default, operator-secret only,
  constant-time compare, POST-only, rate limited, no secret accepted in the query string.
- `db/tests/incident_expiration.sql` (43 assertions) and `tests/maintenance-expiration.test.ts`
  (14 tests: 10 endpoint authorization, 4 live runner/concurrency).
- `db/init/05_maintenance_role_login.sh` and `MAINTENANCE_DB_PASSWORD` for the container path.

### Changed

- **`EXECUTE` on `airs.expire_incident_state()` revoked from `airs_app`.** The application role can
  no longer trigger cross-tenant time-based state changes.
- The compose `expiration-scheduler` now connects as `airs_maintenance` and runs the new CLI runner.
- `db/scheduler/pg_cron.sql` schedules `airs.run_incident_expiration()` and documents running the
  job as `airs_maintenance`.
- `INCIDENT_EXPIRY_TOKEN` / `npm run incidents:expire` / `POST /api/public/cron/expire-incidents`
  replaced by `AIRS_MAINTENANCE_*`, `npm run maintenance:expire-incidents` and the protected
  maintenance route. Removed: `src/lib/incidents/expiration.server.ts`,
  `scripts/expire-incidents.mjs`, `src/routes/api/public/cron/expire-incidents.ts`,
  `db/tests/expiration.sql`.

### Verified (no incident-room behaviour change)

- `npm run db:test` — 126 assertions ok, exit 0.
- `npx vitest run` — 53/53 passing against a live PostgreSQL 17.9 cluster.
- `npx tsgo --noEmit` clean; portable and editor builds both succeed.
- CLI proven three ways: as `airs_maintenance` (exit 0), as `airs_app` (permission denied, exit 1),
  unconfigured (exit 1).

### Still PARTIALLY VERIFIED

Docker runtime (no daemon available), the pg_cron path (extension not installed), and the Stage 4
authentication gaps (no MFA, no rate limiting on sign-in, no password-reset delivery).

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

## Stage 6 — Operational Resource Registry and Readiness Board

- `db/migrations/0007_resource_registry.sql`: organization-owned `resources` plus aircraft, vehicle,
  dock, launch-site and sensor detail tables; `personnel_profiles`, `qualifications`, `shifts`;
  `resource_shares` and `incident_assignments`. Forced RLS on every table, immutable ownership,
  category-valid readiness states, no overlapping shifts, and
  `airs.terminate_incident_resource_access()` so closing a room ends every share and live assignment.
- Role model expanded to 9 roles / 38 permissions / 92 grants.
- `src/lib/resources/`: portable domain model, resource lifecycle and sharing services, personnel and
  qualification services, incident assignment services — all behind the existing authorization chain.
- `src/lib/api/resources.functions.ts`: validated transport layer; `/resources` readiness board and an
  assignments panel inside each incident room.
- `db/tests/resource_registry_rls.sql`: 52 assertions proving default deny, owner-only writes,
  share-scoped partner reads, classification handling, revocation, expiry and closure termination.
  Full suite: 178 assertions green; typecheck clean.

## Stage 7 closure verification

- Added `tests/map-geography.test.ts` (22 tests): model↔migration parity plus
  live enforcement of precision, withholding, revocation and closure.
- Removed the silent OpenStreetMap raster fallback from `CopMap`; the operator's
  `VITE_MAP_STYLE_URL` is now read, and its absence produces an explicit
  "Basemap not configured" notice instead of an unconfigured provider.
- Added an always-visible attribution line (`VITE_MAP_ATTRIBUTION`).
- Added keyboard-accessible layer visibility controls on `/map`.
- Recorded the full verification result in `BUILD_AUDIT.md`.

## Stage 8 (continued) — Awareness verification and interface

- Dedicated Stage 8 verification: `db/tests/awareness_observations_rls.sql` (99 assertions)
  and `tests/awareness.test.ts` (41 tests). Full suites on a rebuilt PostgreSQL 17.9 /
  PostGIS 3.6.1 database: 408 SQL assertions and 124 TypeScript tests, exit 0.
- Service fixes found by verification: observation geography joined the wrong
  resource-location column; lifecycle closure bound the closing account as text;
  sharing an observation with a non-approved agency now fails as
  `partner_not_eligible`; filing into a closed or archived room now fails as
  `incident_closed` instead of surfacing a raw database exception.
- Awareness interface: `/awareness` board (summary tiles, filters, report form with a
  clearly separated restricted plane) and `/awareness/$observationId` review screen
  (verification transitions, annotations, links, information gaps, evidence references,
  partner releases with per-release disclosure profile and geographic precision).
- Map awareness layer: observations released with geography are drawn on the common
  operating picture behind their own toggle; withheld reports are counted, not placed.
- Console navigation now links the common operating picture and awareness board.

## Stage 8 closure — Manual Airspace Observations and Awareness Layer (2026-08-18)

Closure pass. No new operational features; the map-click coordinate picker
remains deliberately out of scope.

### Fixed

- **Test isolation.** Database-backed TypeScript suites left accounts,
  memberships, organizations, observations and audit evidence behind, so
  `db/tests/auth_rls.sql` failed on a second run unless the database was
  rebuilt. Added `tests/support/fixtures.ts` (`cleanupRunFixtures`,
  `ensureTrustedAgency`) and wired it into `tests/auth-integration.test.ts`,
  `tests/awareness.test.ts` and `tests/map-geography.test.ts`.
- **Shared demo state.** The Albany PD → Albany County trusted-agency approval
  is now created only when absent and removed only by the run that created it.
- **Brittle assertion.** `db/tests/auth_rls.sql` asserted a table-wide
  membership count; it now asserts the four specific fixture membership ids,
  which is a stronger check and immune to unrelated rows.

### Added

- `vitest.config.ts` with `fileParallelism: false` (correctness, not speed —
  suite files share the demo organizations).
- `DESIGN_SYSTEM.md`, documenting the token layer, awareness status palette and
  the disclosure-absence convention.
- Stage 8 sections titled _Manual Airspace Observations and Awareness Layer_ in
  `BUILD_AUDIT.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md` and
  `LOCAL_SETUP.md`.

### Verified

- `tsc --noEmit` — exit 0.
- `npm run db:test` — 408/408 assertions, three consecutive runs.
- `vitest run` — 7 files, 124 passed / 4 skipped, three consecutive runs.
- Row census after each of the three cycles: 2 organizations, 0 accounts,
  0 memberships, 0 observations, 0 audit events, 0 trusted-agency rows —
  identical to the seeded state, with no rebuild between cycles.

## Windows Bootstrap Hardening — 2026-08-06

### Added

- Repository-root `.gitattributes`: `text=auto eol=lf` default, explicit
  `*.sh text eol=lf` (plus `.bash`/`.zsh`, SQL, TS/JS, YAML, JSON, Markdown,
  `Dockerfile`, `docker-compose.yml`), `*.ps1 text eol=crlf`, binary assets excluded.
- `scripts/check-line-endings.mjs` + `npm run check:line-endings` — fails when any
  tracked shell script contains CRLF.
- `scripts/db-migrate.mjs` and `scripts/lib/migrate-plan.mjs` — portable Node
  migration runner: local `psql` first, otherwise `docker compose exec -T db psql`,
  `ON_ERROR_STOP=1` on both paths, established 0001→0011 order, nonzero exit on
  failure, redacted output, no implicit container start or delete.
- `scripts/lib/platform-admin-cli.mjs` — `--help` (exit 0, no `--email` required)
  documenting every flag, required environment variables, what the command changes,
  what it never prints or stores, a Windows PowerShell example, how to replace an
  exposed invitation with `--new-link`, and that the account only exists after
  activation. Unknown flags exit 2 with a clear message.
- Tests: `tests/line-endings.test.ts`, `tests/db-migrate.test.ts`,
  `tests/platform-admin-cli.test.ts` (18 new assertions).

### Changed

- `npm run db:migrate` now runs the Node runner instead of a bare `psql` invocation.
  The command name is unchanged.
- `LOCAL_SETUP.md` §9 documents the verified 14-step Windows sequence and its
  warnings (`docker compose down -v` data loss, never share activation URLs, use
  `--new-link` after exposure, do not run `npm audit fix` unreviewed).

### Unchanged (verified)

- Platform/agency plane separation, `platform_admin` role and its zero operational
  permissions, forced RLS, tenant isolation, authentication, password hashing,
  session handling, invitation hashing/expiry, single-use activation, the
  `anconison-platform` organization and both Albany agency organizations.

### Verified

- `npm run check:line-endings`, `tsc --noEmit`, `vitest run` (77 passed / 70 skipped),
  `npm run build`, `npm run build:dev`, `platform-admin:setup -- --help` (exit 0).
- Environment-blocked in this sandbox: `npm run db:test` (no PostgreSQL) and a live
  Docker Compose migration run (no Docker daemon).

## Docker/PostGIS deployment fix and legacy repair path

### Fixed

- Compose `db` service pinned to `postgis/postgis:16-3.5-alpine`; migrations
  0009 and 0010 no longer fail with `extension "postgis" is not available` or
  `type public.geometry does not exist`.
- `db/ledger/adopt_verify.sql` now checks `airs.resource_locations` (the real
  Stage 7 table) instead of a non-existent `airs.asset_locations`.

### Added

- Fresh-install PostGIS preflight in `db/init/00_apply_migrations.sh`: rejects a
  non-PostGIS image with an actionable error and enables PostGIS before 0009.
- `npm run db:migrate:repair-legacy` - operator-only, confirmation-gated repair
  of pre-ledger databases with concrete per-migration state probes, missing-only
  application of 0009/0010, full verification, and ledger creation last.
- `tests/db-repair-legacy.test.ts` (28 assertions) covering image pinning,
  fresh-install ordering, state probes, noncontiguous detection, transaction
  guarantees, ledger recording and command safety.

### Documentation

- Windows recovery procedure (preserve the volume, never `docker compose down -v`)
  in LOCAL_SETUP.md, DATABASE.md and README.md; ARCHITECTURE.md, SECURITY.md and
  BUILD_AUDIT.md updated.
