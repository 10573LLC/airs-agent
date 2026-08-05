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

## Scheduled expiration endpoint

`POST /api/public/cron/expire-incidents` is the only unauthenticated-by-session route in the app,
so it is locked down independently:

- **Disabled unless configured.** Without `INCIDENT_EXPIRY_TOKEN` (minimum 24 characters) the route
  returns 503 and never touches the database. It fails closed, not open.
- **Bearer token, constant-time compare.** `Authorization: Bearer <token>` is compared with
  `timingSafeEqualString`; anything else is 401.
- **POST only.** `GET` returns 405, so a crawler or link preview can never trigger a sweep.
- **No data disclosure.** The response is aggregate counters — no tenant identifiers, no room
  names, no PII — and errors are reduced to `{"status":"error"}` with detail sent to server logs.
- **Bounded blast radius.** The underlying function can only remove access, and audits every row it
  changes, so a hypothetical unauthorised call cannot leak or grant anything.
- **No concurrency.** Advisory lock `8421701` serialises sweeps across every invocation path.

The token lives in the environment only. It is never logged and is not present in the repository.
Operators who prefer no HTTP surface at all should leave it unset and use `npm run incidents:expire`
or `db/scheduler/pg_cron.sql`.
