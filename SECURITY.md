# AIRS Agent — Security

No compliance claim is made. This system has **not** been validated against CJIS, NIST 800-53,
FedRAMP, or any other framework. Statements below describe implemented mechanics only.

## Tenant isolation — IMPLEMENTED

Shared-schema multi-tenancy with `org_id` on every tenant table, enforced by PostgreSQL RLS with
`FORCE ROW LEVEL SECURITY` and a non-owner application role (`airs_app`). Tenant identity is read
from a per-transaction session GUC set by the server, never from a client-supplied value.
Application-level checks in `authorize()` provide a second, independent layer.

Verified live (see `db/tests/rls_isolation.sql` and BUILD_AUDIT.md §7): with no session context, zero
rows are visible; Albany PD cannot see Albany County users; a partner org gains read access only
through an active share and loses it on revocation; cross-tenant `UPDATE` affects 0 rows.

## Authentication — NOT YET IMPLEMENTED

No login exists. The `AuthAdapter` contract is defined; planned drivers are self-hosted local
credentials (Argon2id + TOTP) and standard OIDC/PKCE against agency IdPs. Until this lands, the
application has no authenticated users and must not be exposed to real data.

## Authorization — IMPLEMENTED (library level)

`src/lib/rbac/authorize.ts` is a pure default-deny decision function:
- no principal -> deny
- resource in another tenant with no active share -> deny
- shared resource, permission outside `{incident.read, airspace.read}` -> deny
- permission not granted by any assigned role -> deny
- otherwise allow, with the reason recorded (`role_permission` | `active_share`)

It is unit tested but **not yet wired into request handling**, because no data endpoints exist yet.

## Roles implemented

Agency Administrator, Airspace Supervisor, Remote Pilot in Command, Visual Observer,
Dispatcher / RTCC Operator, Incident Commander, Intelligence Analyst, Partner-Agency User,
System Auditor. Definitions: `src/lib/rbac/roles.ts` and `db/migrations/0002_roles_seed.sql`.

## Audit logging — SCHEMA ONLY

`airs.audit_events` exists and is immutable to the app role (no UPDATE/DELETE policy). The
`AuditSink` interface is defined. Nothing writes to it yet.

## Data retention — SCHEMA ONLY

`airs.retention_policies` per tenant and `incidents.retain_until`. No purge job yet.

## Transport and secrets

Secrets come from environment variables (`.env.example`); none are committed. TLS is expected to be
terminated by the deployment platform or a reverse proxy — **NOT YET IMPLEMENTED** in-repo.

## Known gaps

1. No authentication, no sessions, no CSRF-protected login flow.
2. `authorize()` is not yet enforced on any data path (there are no data paths).
3. No audit writes, no retention purge, no key rotation, no rate limiting.
4. No password/MFA policy, no account lockout.
5. No encryption at rest beyond what the PostgreSQL host provides.
6. Migrations are applied manually; no version ledger.
7. `/api/public/health` is unauthenticated by design; it exposes only reachability, no data.
## Foundation Portability Verification — 2026-07-29

### Permission matrix (PROVISIONAL — subject to change before any operational use)

| Role | Permissions |
| --- | --- |
| Agency Administrator (`agency_admin`) | org.manage, user.manage, incident.read, airspace.read, aircraft.manage, retention.manage, audit.read |
| Airspace Supervisor (`airspace_supervisor`) | incident.read, airspace.read, airspace.approve, airspace.propose, aircraft.manage |
| Remote Pilot in Command (`rpic`) | incident.read, airspace.read, airspace.propose |
| Visual Observer (`visual_observer`) | incident.read, airspace.read |
| Dispatcher / RTCC Operator (`dispatcher`) | incident.create, incident.read, incident.update, airspace.read |
| Incident Commander (`incident_commander`) | incident.create, incident.read, incident.update, incident.close, incident.share, incident.revoke_share, airspace.read, airspace.approve |
| Intelligence Analyst (`intel_analyst`) | incident.read, airspace.read |
| Partner-Agency User (`partner_agency_user`) | incident.read, airspace.read (only for incidents shared with an active share) |
| System Auditor (`system_auditor`) | audit.read |

These assignments are **provisional**: they have not been reviewed or approved by any agency and
are expected to change. Parity between this table, `src/lib/rbac/roles.ts` and
`db/migrations/0002_roles_seed.sql` is enforced by `tests/role-parity.test.ts`.

### Tenant isolation — re-verified

`db/tests/rls_matrix.sql` runs 47 assertions as the unprivileged `airs_app` role across all nine
tenant tables and SELECT/INSERT/UPDATE/DELETE. All passed on 2026-07-29. Covered: no-context
default deny (read and write), Albany PD cannot reach Albany County rows and vice versa, `org_id`
cannot be changed to move a record between tenants (WITH CHECK denies it), cross-tenant UPDATE and
DELETE affect 0 rows, a partner gains read-only access only through an active share and loses it on
revocation, a partner cannot revoke or forge shares, and the audit log cannot be updated or deleted.

### Bypass behaviour

- `airs_app` (the application role): fully constrained by RLS.
- Table owner (`airs_owner`): constrained too, because every tenant table has
  `FORCE ROW LEVEL SECURITY`.
- **Superusers bypass RLS entirely.** Migrations and the test harness run as a superuser; the
  application must never be configured with superuser or owner credentials.

### Secrets

Repo-wide scan for credential patterns found placeholders and env-var names only. `.env` and
`.env.*` are git-ignored (`!.env.example`). `.env.example` contains `CHANGE_ME` placeholders.

## Authentication and Authorization Enforcement — 2026-07-30

Sections above that said "NOT YET IMPLEMENTED" for authentication and "not yet wired into request
handling" for authorization are superseded by this section.

### Enforcement chain — IMPLEMENTED

Every protected operation goes through `withAuthorized()` in
`src/lib/auth/authorize.server.ts`:

```
session cookie (opaque token) -> airs.sessions row (SHA-256 hash, unexpired, unrevoked)
  -> account -> requested organization -> ACTIVE membership -> assigned role
  -> required permission (authorize(), default deny) -> SET LOCAL airs.* GUCs
  -> unprivileged airs_app connection under FORCE ROW LEVEL SECURITY -> audit event
```

A browser-supplied organization id is never trusted: it is only accepted after an active
membership for the resolved account is found. Both allow and deny outcomes are audited.

### Credentials and tokens

- Passwords: PBKDF2-HMAC-SHA256, 210 000 iterations, 16-byte random salt, Web Crypto only
  (`src/lib/auth/password.ts`). Verification is constant-time over the derived key.
- Session and invitation tokens: 32 random bytes, base64url. Only the SHA-256 hash is stored;
  the clear-text value exists in the response body and the cookie, never in the database or the
  audit log (asserted in `tests/auth-integration.test.ts`).
- Session cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production, expiry mirrored from the row.
  The cookie carries no state — revocation and expiry are re-read on every request.

### Organization-context guard — IMPLEMENTED (migration 0004)

`airs.current_org_id()` no longer returns whatever `airs.org_id` contains. When an account
context is present it returns the organization **only** if that account holds an ACTIVE membership
in it, or is redeeming an invitation for it. A malformed GUC yields NULL. This makes the database
independently refuse a tenant pivot even if application code were to forward a client-supplied
organization id. Invited, suspended and revoked memberships establish no context at all.

### Invitations

Single-use, hashed, expiring, revocable and re-issuable. Organization and role come from the
stored row; the acceptance request cannot influence either, and acceptance requires the
authenticated account's e-mail to equal the invited address. Previews require a session and mask
the recipient address, so a leaked link cannot be used to harvest e-mails or enumerate agencies.

### Evidence

- `db/tests/auth_rls.sql` — 59 assertions executed as `airs_app` (asserted to hold neither
  SUPERUSER nor BYPASSRLS), covering default deny, cross-tenant read/write/update/delete,
  non-active memberships, malformed and unapproved GUCs, invitation-token scoping, append-only
  audit, and context lifetime across COMMIT/ROLLBACK on a reused connection.
- `tests/auth-integration.test.ts` — 25 tests against a live PostgreSQL through the real chain.

### Remaining gaps (unchanged or new)

1. No MFA/TOTP enrolment flow, no password reset delivery, no account lockout threshold.
2. No rate limiting on sign-in; failed attempts are counted but not acted on.
3. Invitation delivery is out of band — the token is shown once to the inviting administrator.
4. No CSRF token: mutations are same-origin server functions with a `SameSite=Lax` cookie.
5. Superusers still bypass RLS; the application must never hold superuser or owner credentials.
6. Signed-in UI verified through service-level integration tests, not an in-browser walkthrough.

## Incident expiration maintenance (Stage 5B)

Time-based expiration is an operator function, not an application function, so it runs on its own
privilege plane.

**Least privilege.** Migration `0006_maintenance.sql` creates the `airs_maintenance` role:
`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`. It holds exactly three privileges —
`EXECUTE` on `airs.run_incident_expiration()`, `airs.record_maintenance_event()` and
`airs.maintenance_expiration_status()`, plus `SELECT`/`INSERT` on `airs.maintenance_events`. It has
no privilege on any tenant table, so a stolen maintenance credential cannot read one incident, one
account or one audit row. The same migration **revokes** `EXECUTE` on `airs.expire_incident_state()`
from `airs_app`: the role that serves browser traffic can no longer trigger cross-tenant state
changes at all. Both facts are asserted in `db/tests/incident_expiration.sql`.

**Credential separation.** The runner reads `AIRS_MAINTENANCE_DATABASE_URL`, never `DATABASE_URL`.
Maintenance therefore never borrows the application pool, the application role, or a pooled session
that might still carry `airs.*` tenant GUCs. The password is set outside the repository
(`MAINTENANCE_DB_PASSWORD` in the container, or peer/IAM authentication elsewhere) and can be
rotated without touching application credentials.

**Bounded blast radius.** The sweep can only remove access. It has no code path that grants,
restores, or elevates anything — asserted directly ("sweep granted no new access"). Every row it
changes produces a tenant audit event, and every run produces a `maintenance.expiration_started`
plus a `maintenance.expiration_completed` or `maintenance.expiration_failed` record.

**Maintenance audit isolation.** Operator activity is recorded in `airs.maintenance_events`, a
non-tenant, append-only table with forced RLS and no `UPDATE`/`DELETE` policy. Tenants cannot read
it; `airs_app` has no grant on it. Metadata passes through `airs.strip_sensitive_detail()`, which
removes `secret`, `token`, `authorization`, `password`, `database_url` and similar keys before the
row is written. Failure records store an error *class*, never a raw driver message.

**Concurrency.** `airs.run_incident_expiration()` takes transaction-level advisory lock `8421701`
before doing anything. A second runner that loses the race returns `skipped_locked = true`, writes a
`skipped` maintenance record and exits 0 without touching a row.

### Optional HTTP trigger

`POST /api/maintenance/expire-incidents` exists only for schedulers that cannot run a command. It is
**off by default** and is deliberately not under `/api/public/`.

- **Disabled unless enabled.** Without `AIRS_MAINTENANCE_ENDPOINT_ENABLED=true` it returns 404.
- **Fails closed.** Without `AIRS_MAINTENANCE_SECRET`, or with a secret shorter than 24 characters,
  it returns 503 and never touches the database.
- **Operator secret only.** No session, organization role or incident role is ever consulted — an
  Agency Administrator with a valid session is rejected exactly like an anonymous caller. The
  credential is compared with `timingSafeEqualString` (SHA-256 digests, constant time).
- **Header only.** A secret presented in the query string is refused with 400 so it cannot leak into
  proxy or browser history logs.
- **POST only** (405 otherwise) and **rate limited** to one accepted invocation per
  `AIRS_MAINTENANCE_MIN_INTERVAL_MS` (default 30s), returning 429.
- **No disclosure.** Responses are aggregate counters and a classification; the secret is never
  echoed, logged or audited. All of the above is asserted in `tests/maintenance-expiration.test.ts`.

Operators who want no HTTP surface leave the endpoint disabled and use
`npm run maintenance:expire-incidents` or `db/scheduler/pg_cron.sql`.

## Field-level disclosure controls (Stage 6 closure)

Row access and field access are separate decisions. Passing RLS releases a row; it does not release
the row's contents.

**Defaults.** A share with no stated profile is `summary`. An unknown profile name is rejected by a
check constraint; an unknown profile reaching the service layer resolves to `summary`. Unknown field
keys are never disclosable.

**Never disclosed to a partner under any profile** (12 sensitive keys): serial numbers, FAA
registration, asset tags, VIN, restricted notes, internal identifiers, personnel duty contact
details, employee identifiers, qualification certificate numbers, qualification restrictions,
verification evidence, and share-recipient notes. These are excluded from every partner profile and
cannot be re-added through a custom profile — the database trigger rejects the insert and the
service layer filters them again.

**Named recipients.** `full` only resolves to the full authorized record for an organization the
owner explicitly named on the share. Every other partner resolving `full` is downgraded to
`incident_command`.

**Withholding is invisible.** Withheld fields are omitted from the payload rather than sent as
`null`, so a partner cannot infer that a value exists.

**Narrowing is immediate.** Disclosure is resolved per read, not cached on the share, so narrowing a
profile, revoking the share, expiring the share or closing the room takes effect on the next request.

**Receiving organizations cannot widen.** `airs_app` holds `SELECT` only on the two reference
tables; `setShareDisclosure` requires the owning organization plus `resource.share`, and
`assertSameOrg` denies a cross-tenant attempt with an auditable `tenant_mismatch`.

**Qualification expiry.** An expired, revoked or unverified qualification stops being current
immediately via `airs.qualification_is_current()`. Partners at aviation level and above see only the
currency flag, never the qualification record.

## Manual Airspace Observations and Awareness Layer (Stage 8)

**Threat model for this layer.** An observation frequently carries the identity
of a member of the public, an internal case number and an exact location. The
layer is built so that each of those can be released independently, to a named
partner, for a bounded time, and withdrawn.

**Controls.**
- *Default deny.* 12 `observation.*` permissions (create, read, update_own,
  review, verify, reject, close, reopen, share, revoke_share, link,
  evidence_reference_manage) are granted per role in `src/lib/rbac/roles.ts`.
  A role without the grant receives `forbidden`; the record is never sent and
  then hidden.
- *Forced RLS.* Every Stage 8 table carries `FORCE ROW LEVEL SECURITY`, so the
  unprivileged `airs_app` role cannot read another tenant's observation even
  with a correct primary key. Proven by 99 assertions in
  `db/tests/awareness_observations_rls.sql`.
- *Restricted source protection.* `reporterIdentity`, `reporterContact`,
  `internalNotes`, `internalCaseNumber`, `sourceDetail`, `classification` and
  `declaredPrecision` are removed from the payload before it leaves the owning
  organization's plane. They are absent from partner responses, not masked.
- *Geographic minimisation.* Precision is reduced server-side to the reader's
  entitlement (exact → generalized → approximate → area only → withheld). A
  withheld observation is counted on the map layer, never plotted.
- *Explicit, revocable release.* Sharing requires an approved trusted-agency
  relationship (`partner_not_eligible` otherwise), names the partner, records
  the disclosure profile and precision, and supports expiry and revocation.
  Closing an incident room terminates the associated releases through
  `airs.terminate_incident_observations()`.
- *Provenance integrity.* Annotations are append-only at the database level;
  verification and lifecycle transitions are validated against the current state
  and guarded by optimistic version checks, so a stale client cannot silently
  overwrite a review decision.
- *Audit.* Every awareness action writes an `airs.audit_events` row in the same
  transaction, with allow/deny outcome. Credentials, tokens and password
  material are excluded from audit detail by construction.

**Known gaps unchanged by this stage.** No MFA, no rate limiting, no password
reset, no evidence file custody (only references are stored).

### Test-fixture privilege note

`tests/support/fixtures.ts` briefly sets `session_replication_role = replica` to
delete append-only fixture rows. This requires the fixture-owner/superuser
connection (`TEST_ADMIN_DATABASE_URL`) and is confined to test teardown. The
application role has no such privilege, and no application code path sets it —
append-only remains enforced for the running system.


## Platform administration bootstrap — IMPLEMENTED (2026-08-05)

Threat addressed: the product operator needs an administrative identity without becoming a member
of, or gaining visibility into, any participating agency.

Controls:

- **Separate tenant.** Platform ownership lives in the `anconison-platform` organization
  (`org_kind = 'platform'`). No agency account is ever made platform owner, and the City of Albany
  organizations are untouched.
- **No operational reach.** `platform_admin` carries four administrative permissions and no
  `incident.*`, `resource.*`, `map.*`, `observation.*`, `airspace.*` or `personnel.*` grant. Even
  with a permission bug, `airs.current_org_id()` denies an organization context the account is not
  an ACTIVE member of, so agency rows stay invisible.
- **Database-enforced plane separation.** A trigger rejects cross-plane role assignment on
  `memberships`, `user_roles` and `invitations`.
- **No privileged path from the app.** `airs.bootstrap_platform_invitation()` and
  `airs.platform_identity_report()` are not executable by `airs_app`; the running application
  cannot mint a platform administrator.
- **Token handling.** The invitation token is generated in the operator CLI, transmitted to the
  database only as a SHA-256 hex digest, and printed once to stdout. It never appears in the
  database, the audit detail, the structured logs, or the repository.
- **Expiry and single use.** The invitation expires (default 72 h, clamped to 300 s .. 7 d) and is
  claimed by a conditional `UPDATE ... WHERE status = 'pending'`, so a replayed link fails.
  Re-running the bootstrap revokes the previous pending link instead of creating a duplicate.
- **Activation cannot take over an account.** `/activate/$token` refuses when an account already
  exists for the invited address; that recipient must sign in normally and then accept the
  invitation. The address is taken from the stored invitation, never from the request.
- **Authentication unchanged.** After activation the platform administrator signs in at `/auth`
  with the same PBKDF2 credential check, opaque session token and httpOnly cookie as every other
  user. Nothing in this work disables, bypasses or weakens authentication, forced RLS, organization
  isolation or session control.
- **Audit.** `platform.bootstrap_invitation_created` (issuance), `invitation.accepted`
  (activation, membership creation and role assignment) and `auth.sign_in` are recorded in the
  platform organization. No audit record contains token material.

---

## Windows bootstrap hardening (2026-08-06)

Portability fixes only; no change to the security architecture. Platform/agency
plane separation, the `platform_admin` role and its zero operational permissions,
forced RLS, tenant isolation, authentication, PBKDF2 password hashing, session
handling, SHA-256 invitation hashing, invitation expiry and single-use activation
are all unchanged. No seed administrator credentials exist.

- **Migration runner** (`scripts/db-migrate.mjs`) redacts connection strings and
  password-like values from every message it prints (`redact()` in
  `scripts/lib/migrate-plan.mjs`), preserves `ON_ERROR_STOP=1` on both paths, and
  exits nonzero on the first failure. It never starts or removes containers.
- **Setup help** (`--help`) documents what the command changes and states
  explicitly that no token, token hash, password or database URL is ever printed,
  logged or stored, and that the account is created only when activation completes.
- **Exposed links.** Any activation URL that has been screenshotted or shared must
  be replaced with `npm run platform-admin:setup -- --email <address> --new-link`,
  which revokes the pending invitation immediately.
- **Line endings.** `.gitattributes` forces LF for tracked shell scripts;
  `npm run check:line-endings` and `tests/line-endings.test.ts` fail the build if a
  CRLF shell script is ever committed, closing a container-init failure mode.
- No passwords, database URLs, activation links, tokens or token hashes are
  committed to this repository.

# Migration ledger security

- `airs_migrations` is a separate schema owned by the migration/database owner, outside the
  `airs` tenant schema. Migration ownership never mixes with tenant data ownership.
- `airs_app` (the application connection) has no USAGE on the schema and no privilege on
  `airs_migrations.applied_migrations`: migration state cannot be read, written or replayed
  through the application, and no application code references it.
- `airs_maintenance` likewise holds no privilege, so the maintenance plane can never modify
  migration state.
- Applied rows are immutable: a `BEFORE UPDATE OR DELETE` trigger raises `AIRS_LEDGER_IMMUTABLE`.
  Recorded checksums are never rewritten by the runner; a modified applied migration stops the
  run instead.
- Concurrency is serialised with the transaction-scoped advisory lock
  `pg_advisory_xact_lock(4718152, 12)`; a losing runner exits without partially applying.
- Every runner code path (apply, dry-run, status, adoption, error handling) passes printable text
  through `redact()`, so database URLs and passwords are never emitted.
- Adoption is operator-explicit, verification-first and never executes migration SQL.
