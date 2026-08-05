# AIRS Agent — Database

PostgreSQL 16. Schema `airs`. All SQL is plain, portable DDL with no vendor extensions
(only `pgcrypto` for `gen_random_uuid()`, which ships with core PostgreSQL).

## Applying

```bash
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_roles_seed.sql
psql "$DATABASE_URL" -f db/seed/demo_orgs.sql
```

`docker compose up` applies all three automatically on first start.

## Tables (IMPLEMENTED)

| Table | PK | Tenant field | Key FKs |
| --- | --- | --- | --- |
| `airs.organizations` | `id uuid` | *is the tenant* | — |
| `airs.users` | `id uuid` | `org_id` | `org_id -> organizations` |
| `airs.roles` | `key text` | reference data (no tenant) | — |
| `airs.permissions` | `key text` | reference data (no tenant) | — |
| `airs.role_permissions` | `(role_key, permission_key)` | reference data (no tenant) | both FKs |
| `airs.user_roles` | `id uuid` | `org_id` | `user_id`, `role_key`, `granted_by` |
| `airs.incidents` | `id uuid` | `org_id` | `created_by -> users` |
| `airs.incident_shares` | `id uuid` | `org_id` (owner) | `incident_id`, `partner_org_id`, `granted_by` |
| `airs.aircraft` | `id uuid` | `org_id` | `org_id` |
| `airs.airspace_operations` | `id uuid` | `org_id` | `incident_id`, `aircraft_id`, `approved_by`, `created_by` |
| `airs.audit_events` | `id bigserial` | `org_id` | `actor_user_id` |
| `airs.retention_policies` | `org_id uuid` | `org_id` | `org_id -> organizations` |

Tables without tenant isolation: `roles`, `permissions`, `role_permissions` only. These are global
read-only reference data containing no agency information; `airs_app` holds `SELECT` and no write grant.

## Columns of note

- `incidents`: `title`, `status` (open/closed/archived), `classification` (public/restricted/sensitive),
  `opened_at`, `closed_at`, `retain_until`.
- `incident_shares`: `scope` (read/contribute), `granted_at`, `revoked_at` (null = active).
- `airspace_operations`: `status` (proposed/approved/active/completed/cancelled), `area_geojson jsonb`,
  `altitude_floor_ft`, `altitude_ceiling_ft` (CHECK ceiling >= floor), `starts_at`, `ends_at`.
- `audit_events`: `action`, `resource_type`, `resource_id`, `outcome` (allow/deny/error), `detail jsonb`,
  `ip_address inet`, `occurred_at`. Index: `(org_id, occurred_at DESC)`.
- `users`: `email_address`, `display_name`, `status`, `external_subject` (IdP subject), unique per `(org_id, email_address)`.

## Row-level security (IMPLEMENTED)

Every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY`. The application connects as `airs_app`,
which is neither superuser nor table owner, so RLS is never bypassed. Tenant context is set per
transaction with `SET LOCAL airs.org_id` / `airs.user_id`; helper functions `airs.current_org_id()`
and `airs.current_user_id()` read them.

| Table | Policy | Effect |
| --- | --- | --- |
| organizations | `org_self` (SELECT) | only your own org row |
| users, user_roles, aircraft, retention_policies | `tenant_rw` | `org_id = current_org_id()` for read and write |
| incidents | `tenant_or_shared_read`, `tenant_write/update/delete` | own tenant, plus read of incidents shared to you with `revoked_at IS NULL` |
| incident_shares | `share_visibility`, `share_owner_write/update` | owner or partner may read; only owner may create/revoke |
| airspace_operations | `ops_read`, `ops_write`, `ops_update` | own tenant, plus read via active share |
| audit_events | `audit_insert`, `audit_read` | insert + read within tenant; no UPDATE/DELETE policy = immutable |

No policy exists for a case = access denied. That is the default-deny guarantee.

## Seed data (IMPLEMENTED)

- 9 roles, 14 permissions, 34 role-permission grants (`0002_roles_seed.sql`).
- 2 fully separated demo tenants (`db/seed/demo_orgs.sql`): Albany Police Department
  (`11111111-1111-4111-8111-111111111111`) and Albany County (`22222222-2222-4222-8222-222222222222`),
  each with a default retention policy. No shared rows between them.

## Migrations

Numbered, forward-only SQL files under `db/migrations/`. A migration runner that records applied
versions is **NOT YET IMPLEMENTED**; today files are applied in filename order.
## Foundation Portability Verification — 2026-07-29

Reproducibility run on a brand-new empty database:

- **Environment:** local, self-managed cluster created with `initdb` in this sandbox (not hosted,
  not builder-managed).
- **PostgreSQL version:** 17.9 (`show server_version`). Target is 16; 16 was **NOT** exercised here.
- **Required extensions:** `pgcrypto` only, created by the migration itself.
- **Required privileges to migrate:** superuser (or a role able to `CREATE EXTENSION pgcrypto` and
  `CREATE ROLE`). Migrations create the `airs_app` role, the `airs` schema, all tables, grants and
  policies — nothing is assumed to exist beforehand.
- **Migration order:** `db/migrations/0001_init.sql`, then `db/migrations/0002_roles_seed.sql`.
- **Migration command:** `npm run db:migrate` (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f …`).
- **Seed command:** `npm run db:seed` (`db/seed/demo_orgs.sql`).
- **Test command:** `npm run db:test` → `db/tests/rls_matrix.sql` (47 checks) + `db/tests/role_parity.sql`.
- **Role assumptions:** the application connects as `airs_app` (NOLOGIN by default; give it a
  password locally or via `APP_DB_PASSWORD` in Docker). It is neither owner nor superuser, so
  `FORCE ROW LEVEL SECURITY` always applies.

Result: applied cleanly on the first attempt, seed loaded, 47/47 isolation checks passed,
role parity 9 roles / 14 permissions / 34 grants.

## Migration 0004 — organization-context guard (2026-07-30)

`db/migrations/0004_org_context_guard.sql` redefines `airs.current_org_id()` as a
`STABLE SECURITY DEFINER` function. Behaviour:

| `airs.org_id` | `airs.account_id` | Result |
| --- | --- | --- |
| unset / malformed | any | `NULL` (every policy denies) |
| set | unset | the organization id (migrations, tenant-only tests, jobs) |
| set | set, ACTIVE membership exists | the organization id |
| set | set, membership invited/suspended/revoked or absent | `NULL` |
| set | set, valid `airs.invite_token_hash` for that org | the organization id (redemption) |

`SECURITY DEFINER` is required because the lookup reads `airs.memberships`, whose own policies call
this function; running it as the owner avoids recursion. `audit_identity_insert` was tightened in
the same migration to require an ACTIVE membership.

Apply order is now `0001 -> 0002 -> 0003 -> 0004` (`npm run db:migrate`).

## Identity-plane test

`npm run db:test` now runs `db/tests/rls_matrix.sql`, `db/tests/role_parity.sql` and
`db/tests/auth_rls.sql`. The last one creates its fixtures as the owner, then runs all 59
assertions after `SET ROLE airs_app`, and rolls everything back — it leaves no rows behind.

## Migration 0005 — incident rooms (Stage 5)

`db/migrations/0005_incident_rooms.sql` adds three tenant tables, all with `ENABLE` +
`FORCE ROW LEVEL SECURITY` and `airs_app` grants:

| Table | Tenant field | Purpose |
| --- | --- | --- |
| `airs.trusted_agencies` | `org_id` (owner) | eligibility only — never access |
| `airs.incident_rooms` | `org_id` (originating agency, immutable) | the temporary room |
| `airs.incident_participants` | `org_id` (owner) + `partner_org_id` | one row per partner agency |

Room states: `draft → scheduled → active ⇄ paused → closing → closed → archived`.
Ownership is immutable (`incident_room_guard`), closed rooms cannot reopen, archived rooms are frozen.
A partner may only accept/decline/withdraw its own row (`incident_participant_guard`).

Helpers (all `SECURITY DEFINER`, executable by `airs_app` only):
`airs.has_incident_access(uuid)` (the single definition of partner visibility),
`airs.pending_incident_invitations()`, `airs.related_org_name(uuid)`,
`airs.expire_incident_state()` (time-based sweep that only ever removes access and audits every
change — executable by `airs_maintenance` only, see below).

Role model is now 9 roles / 23 permissions / 52 grants.
Apply order: `0001 → 0002 → 0003 → 0004 → 0005 → 0006`.
`npm run db:test` additionally runs `db/tests/incident_rls.sql`.

## Scheduled expiration

`airs.expire_incident_state()` is the single writer for time-based state changes. In one
transaction it expires overdue invitations (destroying their token hashes), expires overdue
participations, closes rooms whose scheduled window elapsed and revokes their partners, and marks
temporary data past its retention window. It returns counters only and writes an audit row for
every change. It can only remove access — no code path in the function grants or restores any.

## Maintenance plane (0006_maintenance.sql)

| Object | Purpose |
| --- | --- |
| `airs_maintenance` (role) | `NOSUPERUSER`, `NOBYPASSRLS`; the only role that may run the sweep |
| `airs.maintenance_events` | non-tenant, append-only operator audit; forced RLS, no UPDATE/DELETE policy |
| `airs.run_incident_expiration(uuid)` | advisory lock `8421701` → sweep → completion record, one transaction |
| `airs.record_maintenance_event(...)` | validated append-only writer; used for start and failure records |
| `airs.strip_sensitive_detail(jsonb)` | removes secret-like keys from audit metadata |
| `airs.maintenance_expiration_status()` | last success, last failure, runs in the past 24 hours |

`EXECUTE` on `airs.expire_incident_state()` is **revoked from `airs_app`** here; the application
role can no longer invoke time-based state changes. `airs_maintenance` holds no privilege on any
tenant table.

A runner records `maintenance.expiration_started` outside the sweep transaction (so it survives a
rollback), runs `airs.run_incident_expiration()` inside one, and records
`maintenance.expiration_failed` after a rollback if the sweep raised. Running twice in a row is a
no-op and a concurrent second runner returns `skipped_locked = true`. All of this is asserted in
`db/tests/incident_expiration.sql` (43 assertions, included in `npm run db:test`) and
`tests/maintenance-expiration.test.ts`.

Optional in-database scheduling lives in `db/scheduler/pg_cron.sql`. It is not part of the
migration chain and is applied only where the `pg_cron` extension exists; schedule it as
`airs_maintenance` so it carries no more privilege than an external scheduler.
