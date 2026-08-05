# AIRS Agent — Architecture

Status legend: **IMPLEMENTED** = exists and runs in this repository. **NOT YET IMPLEMENTED** = design only.

## 1. Goal and constraints

AIRS Agent is an incident-based airspace coordination platform for public-safety agencies.
Hard constraints driving every decision below:

- Must be exportable and operable outside Lovable (Docker + plain PostgreSQL).
- React + TypeScript frontend; portable TypeScript backend; PostgreSQL database.
- No proprietary builder-only database, auth, workflow engine, or connector on any essential path.
- Any managed service must sit behind an adapter interface.
- Every record belongs to an organization tenant; access denied by default.

## 2. Stack (IMPLEMENTED)

| Layer | Choice | Portability note |
| --- | --- | --- |
| UI | React 19 + TypeScript + Tailwind | Standard; no builder runtime |
| Routing / SSR | TanStack Start (Vite) | Open source; builds to a plain Node server (`.output/server/index.mjs`) |
| API | HTTP routes under `src/routes/api/**` | Standard `Request`/`Response`; framework-swappable |
| Database | PostgreSQL 16, raw SQL migrations | No ORM lock-in, no vendor extensions (no PostGIS required) |
| DB access | `pg` driver behind `DatabaseAdapter` | Any Postgres host |
| Mapping | MapLibre GL (**NOT YET IMPLEMENTED**) | Open source; style URL is configuration |
| Tests | Vitest + executable SQL isolation test | Standard |

TanStack Start is chosen because it is a plain open-source Vite framework. Lovable's preview runs it,
but so does `node .output/server/index.mjs` in the Docker image. It is the one framework-level
decision that would need a rewrite only if you wanted a different React meta-framework.

## 3. Repository structure

```text
db/
  migrations/0001_init.sql        schema, grants, RLS policies
  migrations/0002_roles_seed.sql  roles, permissions, role_permissions
  seed/demo_orgs.sql              Albany PD + Albany County tenants
  tests/rls_isolation.sql         executable tenant-isolation proof
src/
  lib/rbac/roles.ts               role + permission catalogue (mirrors SQL)
  lib/rbac/authorize.ts           default-deny decision function
  lib/adapters/types.ts           DB / Auth / Realtime / Storage / Audit contracts
  lib/adapters/postgres.server.ts PostgreSQL DatabaseAdapter (sets tenant context)
  lib/adapters/index.server.ts    env-driven adapter selection
  routes/api/public/health.ts     health endpoint (real DB probe)
  routes/index.tsx                stage-1 foundation status page
tests/authorize.test.ts           9 authorization tests
Dockerfile, docker-compose.yml, .env.example
```

## 4. Request path (design, partially implemented)

```text
Browser (React)
  -> HTTP route / server function
     -> AuthAdapter.verify(credential)          NOT YET IMPLEMENTED
     -> build Principal { userId, orgId, roles }
     -> authorize(principal, {resourceOrgId, permission})   IMPLEMENTED
     -> DatabaseAdapter.withTenant({orgId,userId}, fn)      IMPLEMENTED
          SET LOCAL airs.org_id / airs.user_id
          -> SQL executed as role airs_app under RLS        IMPLEMENTED
     -> AuditSink.record(...)                               contract only
```

Authorization is enforced **twice**: in application code (explicit permission check) and in the
database (RLS). A bug in one layer does not by itself leak cross-tenant data.

## 5. Multi-tenancy

Single database, shared schema, `org_id` on every tenant-owned table, PostgreSQL row-level security
with `FORCE ROW LEVEL SECURITY` and a non-owner application role (`airs_app`). Tenant identity comes
from the session GUC `airs.org_id`, set per transaction — never from client input.

Cross-agency sharing is explicit and revocable: `airs.incident_shares` grants a partner org read
(or contribute) access to a single incident; revocation sets `revoked_at` and the RLS predicate
immediately stops matching. Verified live — see BUILD_AUDIT.md §7.

## 6. Authentication (NOT YET IMPLEMENTED)

Design: session cookie issued by the app, backed by an `AuthAdapter`.
- `AUTH_DRIVER=local` — email + Argon2id password hash stored in Postgres, TOTP second factor. Fully self-hosted.
- `AUTH_DRIVER=oidc` — standard OIDC authorization-code + PKCE against the agency IdP (Entra ID, Okta, Keycloak).

No proprietary auth service. `airs.users.external_subject` holds the IdP subject when OIDC is used.

## 7. Roles and permissions (IMPLEMENTED)

Nine roles, fourteen permissions, defined once in `src/lib/rbac/roles.ts` and mirrored in
`db/migrations/0002_roles_seed.sql`. Role assignment is per tenant (`airs.user_roles.org_id`).
`authorize()` returns `allowed:false` unless a rule explicitly grants access; partner orgs are
additionally limited to `incident.read` and `airspace.read` on shared incidents.

## 8. Real-time (NOT YET IMPLEMENTED)

`RealtimeAdapter` contract exists. Planned default: PostgreSQL `LISTEN`/`NOTIFY` fanned out over the
app's own WebSocket/SSE endpoint — zero extra infrastructure, no third-party realtime service.
Alternative adapter: Redis pub/sub for multi-instance deployments. Tenant and incident scoping is
applied server-side before any message is emitted; channels are never trusted from the client.

## 9. Mapping (NOT YET IMPLEMENTED)

MapLibre GL JS with a configurable style URL (`VITE_MAP_STYLE_URL`). Agencies may self-host tiles
(OpenMapTiles/Protomaps) with no API key. Airspace geometry is stored as GeoJSON in `jsonb`, so no
PostGIS dependency exists today; PostGIS can be added later for spatial deconfliction queries.

## 10. Adapters and connectors

Every external capability is an interface in `src/lib/adapters/types.ts`
(`DatabaseAdapter`, `AuthAdapter`, `RealtimeAdapter`, `ObjectStorageAdapter`, `AuditSink`).
Only `DatabaseAdapter` has an implementation today. Future integrations (LAANC/UAS Facility Maps,
CAD/RMS, Remote ID feeds) get their own adapter interface plus an HTTP client — no builder connectors.

## 11. Data retention (schema only)

`airs.retention_policies` stores per-tenant retention windows (incidents, audit, telemetry).
`airs.incidents.retain_until` is the enforcement hook. The purge job is **NOT YET IMPLEMENTED**.

## 12. Audit logging (schema only)

`airs.audit_events` is append-only by construction: RLS grants INSERT and SELECT within the tenant
and defines no UPDATE or DELETE policy, so modification is impossible for `airs_app`. Application
wiring (`AuditSink`) is **NOT YET IMPLEMENTED**.

## 13. Portability risks

See BUILD_AUDIT.md §3 for the full dependency register. Summary of where lock-in could creep in:
1. Enabling Lovable Cloud would introduce Supabase auth/DB coupling — deliberately not enabled.
2. Lovable-generated helper modules (`src/lib/lovable-error-reporting.ts`, `error-capture.ts`,
   `@lovable.dev/vite-tanstack-config`) are preview-only conveniences; they must stay out of business logic.
3. Cloudflare-Worker-only APIs in the Lovable preview runtime — avoided by keeping server code to
   standard Node/Web APIs.
4. Any future use of a builder connector or managed realtime service without an adapter.
## Foundation Portability Verification — 2026-07-29

The build toolchain no longer contains any builder-specific package. `vite.config.ts` composes the
standard plugin set directly: `@tailwindcss/vite`, `vite-tsconfig-paths`, `tanstackStart` (with
client import protection and `src/server.ts` as the SSR entry), `nitro/vite`, `@vitejs/plugin-react`.

The Nitro deployment preset is `node-server` by default and configurable with `NITRO_PRESET`, so
`npm run build` produces `.output/server/index.mjs`, runnable with plain `node` on any host, in the
Docker image, or on any Node PaaS. Cloudflare/Workers output remains available via
`NITRO_PRESET=cloudflare-module` but is not required.

Remaining builder artifacts (`AGENTS.md` banner, `.lovable/`, `.workspace/`) are metadata and
documentation only; nothing in install, build, test, run or deploy reads them.

## Request path with authentication (2026-07-30)

```
browser
  |  TanStack server function (src/lib/api/auth.functions.ts)
  |    reads the httpOnly airs_session cookie, never a client-supplied identity
  v
withAuthorized()  src/lib/auth/authorize.server.ts
  |  AuthAdapter.resolve(token)      src/lib/auth/local-adapter.server.ts
  |  resolveMembership(ctx, orgId)   active membership only
  |  authorize(principal, request)   pure, default deny  src/lib/rbac/authorize.ts
  v
DatabaseAdapter.withContext({ airs.org_id, airs.user_id, airs.account_id })
  |  SET LOCAL inside a transaction -> discarded on COMMIT/ROLLBACK (pool safe)
  v
PostgreSQL as airs_app under FORCE ROW LEVEL SECURITY
  |  airs.current_org_id() re-checks the membership (migration 0004)
  v
recordAudit() in the same transaction  -> airs.audit_events
```

Portability is unchanged: the auth driver is selected by `AUTH_DRIVER` behind the `AuthAdapter`
contract (`local` today, OIDC later), and no Lovable-specific service is on this path.

### Routes added

- `/auth` — sign-in; accepts an optional same-origin `?redirect=` path only.
- `/invite/$token` — invitation acceptance (`ssr: false`, `noindex`); organization and role are
  displayed read-only from the server-validated invitation.

## Brand and presentation layer (Stage 5A)

Brand artwork is static and portable: files live in `public/brand/airs-agent/` and are referenced
through a single registry, `src/components/brand/assets.ts`. No component hard-codes a path, so the
whole package can be re-pointed or re-issued in one place. Design tokens are Tailwind v4 `@theme`
variables in `src/styles.css`; components consume tokens, never literal colours.

`src/components/brand/` is the only place that knows what the product looks like:

```
BrandMark / BrandLockup / BrandHorizontal   the mark, at fixed safe sizes
AppHeader / AppFooter                       chrome shared by every route
PageShell / PageHeading / SectionCard       page skeleton
StatusPill                                  lifecycle and verification states
```

## Incident expiration operations (Stage 5A)

Expiration logic stays in the database — `airs.expire_incident_state()` — so every invocation path
gets the same behaviour and the same audit trail. Three interchangeable triggers exist; an operator
picks one and none is required:

```
npm run incidents:expire        scripts/expire-incidents.mjs, plain pg driver, for cron/systemd
POST /api/public/cron/…         bearer-token endpoint, for a hosted scheduler
db/scheduler/pg_cron.sql        optional in-database schedule, no external caller at all
docker compose                  expiration-scheduler service wrapping the script
```

All paths take PostgreSQL advisory lock `8421701` first, so overlapping schedulers cannot run
concurrent sweeps; a caller that loses the race returns `skippedLocked: true` and exits cleanly.
