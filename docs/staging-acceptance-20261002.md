# Local staging acceptance — 2026-10-02

The locked-framework branch was exercised with five synthetic entities against a disposable PostgreSQL/PostGIS database. No live entity data, external invitations, production migrations, or public-site publication were involved. The database and test containers are removed after the run.

## Observed results

- All 458 tests in 40 files passed with no skipped tests; all 14 SQL suites passed.
- TypeScript validation passed. The production Docker runtime image built successfully, including the application production build.
- The built container passed readiness, managed login page, PKCE redirect, secure transaction cookie, and invalid callback rejection checks. This does not establish a successful real Cognito login.
- The new acceptance exercise uses actual sign-in and application services for entity onboarding, source consent, automatic Partner activation, incident-only Associate grants, source-backed observations, human reports, owner-led correlation, source revocation, and incident closure.
- It verifies source profiles remain private, forged source attribution is replaced, ungranted data classes are denied, unrelated entities cannot read or report, and view-only participants cannot contribute.
- It checks missing victim location, conflicting correlated reports, source timestamp aging, immediate removal of revoked data, closed-incident visibility, and rejection of reports after closure. Supplemental access correctly remains pending external revocation until a provider receipt exists.

## Defect found and fixed

An Associate could accept an incident invitation but could not grant its own source into that incident. The incident lookup used `SELECT FOR SHARE`, which also applies the incident's owner-only UPDATE policy. It silently hid the incident from a valid participant.

Additive migration `0021_framework_participant_lock.sql` introduces an access-checked SECURITY DEFINER function that locks only a currently accessible active incident. The service uses that function without granting participants incident update rights. The exercise confirms participants still cannot update the incident and that a competing lifecycle write waits on the lock. Migration 0020 remains unchanged.

The runtime dependency installation now uses the same npm cache, disabled audit request, and bounded download concurrency as the build stage. This resolved the observed npm installation failure. The Docker build context excludes local `work/` files.

## Reproduce

```powershell
npm run typecheck
docker build --target runtime -t airs-agent:framework-staging-20261002 .
$env:AIRS_TEST_IMAGE='airs-agent:framework-staging-20261002'
npm run test:isolated -- --reporter=dot
```

Run from the application checkout with Docker available. The harness creates its own database; it does not use an operator's DATABASE_URL. Exercise fixtures are synthetic and explicitly seeded only in that disposable database.

## Release boundaries

After AWS renewal and Cloudflare sign-in, separate staging foundation/runtime stacks were deployed at https://staging.airsagent.com. All 21 migrations applied successfully. The web service, HTTPS/login-security checks and the five-entity service/database exercise passed in AWS. See ../deploy/aws/STAGING-DEPLOYMENT.md for exact task IDs, image metadata and release boundaries. Three infrastructure isolation tests and AWS template validation also passed.

The user authorized a staging invitation to admin@airsagent.com, and Cognito accepted the email request. The user has now completed password setup, MFA enrollment, verified-email sign-in and application invitation acceptance. The staging console shows active Platform Administrator access. Temporary enrollment access was removed.

Authenticated browser acceptance and concurrency, backup/restore and production rollout checks remain outstanding. Real Dedrone ingestion/revocation requires an authorized endpoint, provider specifications, representative payloads and secret-store credentials. Synthetic Dedrone records do not establish a live integration.

Application draft PR: https://github.com/10573LLC/airs-agent/pull/4

Public-site draft PR: https://github.com/10573LLC/airs-agent/pull/5

Main and production remain unchanged.
