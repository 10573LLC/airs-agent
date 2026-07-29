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