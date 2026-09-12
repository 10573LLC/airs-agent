# AIRS deployment validation — 2026-09-12

The deployment branch implements Cognito login and prepares the application for AWS deployment validation. It has not been launched or tested against production RDS or a live Cognito login.

## Changes

- Cognito authorization-code login with PKCE, encrypted short-lived state, verified ID tokens and revocable database sessions.
- Invitation-controlled agency access; a new Cognito user receives no agency privileges automatically. Local password endpoints and old local sessions are rejected in OIDC mode.
- Correct ECS environment names, the configured Cognito identifiers and a public RDS certificate bundle for verified TLS.
- Separate ARM64 web and database-operations images, both running as a non-root user.
- Reproducible npm/Bun locks and patched dependencies. The full npm audit reports zero known vulnerabilities as of this validation date; this is not a guarantee against undiscovered issues.

## Reproduction

Final results: 436 tests passed across 35 test files; all 17 migrations applied and all 11 SQL suites passed. Both ARM64 images built and passed the combined operations/runtime checks. Type checking, changed-file lint, line-ending checks and `git diff --check` passed.

Validated local image IDs:

- Runtime: `sha256:1dbb66d678ea8e05070601d614899d779209d06e7343fe263725fe4d2fa6dad0`
- Operations: `sha256:31c15b9429dfed47b780d9fe9fd41374b26033cab3d6e867657a0c3e215106d5`

Run `npm ci --legacy-peer-deps`, `npm run typecheck` and `npm run test:isolated`. The isolated runner creates and removes its own disposable PostgreSQL/PostGIS database; it does not use production connection settings.

To include container checks, build both Docker targets as described in [the deployment guide](README.md), then set `AIRS_TEST_IMAGE` to the runtime image and `AIRS_TEST_OPS_IMAGE` to the ops image before running `npm run test:isolated`. This checks the migration ledger, readiness, rendered login page, PKCE redirect, secure cookie and rejection of an invalid callback.

Changed application files pass lint. Repository-wide lint still has a pre-existing formatting/lint backlog outside this change.

## Required before launch

1. Select the production map provider and attribution, then supply the build arguments for the release images.
2. Configure production Secrets Manager values, least-privilege ECS roles, database access and the separate migration/maintenance credentials.
3. Apply migrations to RDS and verify the application connects as `airs_app` with TLS certificate verification. Do not load demo fixtures into production.
4. Configure the load balancer, certificate and DNS for `app.airsagent.com`, then publish immutable images and start ECS.
5. Provision `admin@airsagent.com` in Cognito and issue its platform invitation using the documented operator procedure. No production user or invitation was created by this code change.
6. Exercise real Cognito login, required TOTP enrollment, invitation acceptance, agency isolation, logout and account disabling over HTTPS. Verify production health checks and scheduled incident expiration.

Cognito user provisioning remains an operator procedure. Signed-token tests and local container checks do not replace this live acceptance test.
