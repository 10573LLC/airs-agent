# AIRS framework staging — 2026-10-02

Application: https://staging.airsagent.com/auth

Account 578856792953, region us-east-2. Separate stacks `airs-agent-staging-foundation` and `airs-agent-staging-runtime` provide a dedicated VPC (10.30.0.0/16), private encrypted RDS instance, ECS cluster, repository, Secrets Manager credentials and invitation-only Cognito pool with mandatory authenticator MFA. No production database or identity pool is reused. Both stacks have termination protection; database deletion protection and snapshot retention are enabled. These are running AWS resources.

The single ARM64 Fargate web task uses an immutable image digest. Maintenance is enabled every five minutes. The load balancer terminates HTTPS with an issued staging certificate. Cloudflare contains new staging routing and certificate-validation CNAMEs only; existing production, website and mail records were preserved. Staging's DNS-only CNAME targets `airs-agent-staging-alb-502863918.us-east-2.elb.amazonaws.com`.

Public identifiers, image digests and secret ARNs are in `staging-deployment.json`; secret values are excluded. Operator/test images are separate from the web image. Only the scoped operator execution role can retrieve the staging master database credential.

## Observed validation

- Bootstrap task `b01ccf85f6b849b2853c5246d2f52385` exited 0: 21 migrations recorded, highest 0021, zero pending/checksum conflicts, no adoption required. No demo seed was applied.
- Web service: desired 1, running 1, pending 0, deployment completed. HTTPS health returned 200 with database reachable.
- Cloud HTTP checks passed: managed sign-in page, staging Cognito issuer/callback, PKCE S256, Secure/HttpOnly/SameSite transaction cookie, invalid callback rejection without a session.
- Human browser sign-in completed: the user reached the staging console with an active Platform Administrator session and accepted application invitation. AWS independently confirms verified email and preferred SOFTWARE_TOKEN_MFA.
- Exercise task `11fcd8140aba49709f305565b4fd68b9` (`airs-agent-staging-exercise:2`) exited 0. The five-entity test passed against staging RDS in 6.70 seconds. It covers onboarding, automatic Partner and incident-only Associate sharing, human reports, provenance, missing/stale/conflicting positions, access denials, revocation, incident locking and closeout. Synthetic fixtures and sessions are removed in cleanup.
- The first exercise stopped before fixture setup because its password-length check did not accommodate the RDS-managed master credential. The runner was corrected, rebuilt and passed on rerun; no credential was changed.
- Earlier local validation: 458 tests/40 files, all 14 SQL suites, typecheck, production build and container smoke checks passed. Three additional infrastructure isolation tests and AWS template validation passed.

Production runtime remains UPDATE_COMPLETE, last updated 2026-10-02T03:50:22.605Z. Remote main remains `17d2fd21f51de98155bfe9385e1f27ab8bd0878e`.

## Rebuild and rollout

Generate the foundation with `build-staging.mjs` and runtime with `build-staging-runtime.mjs`; use staging output filenames and stack names. Generators reject live origin/resource reuse. Runtime creation defaults to desired count zero and disabled maintenance until bootstrap succeeds. Then update staging parameters to DesiredCount=1 and ScheduleState=ENABLED.

Docker on this workstation requires its configured HTTP/HTTPS build proxy. Optional `build_ca` supplies trusted roots only during dependency installation. TLS verification remains enabled and the CA is not copied into the runtime image. Web/ops images use linux/arm64; the test image uses linux/amd64 and its task explicitly uses X86_64.

## Remaining gates

The user authorized a staging login invitation to admin@airsagent.com. Cognito accepted the email invitation request and returned FORCE_CHANGE_PASSWORD. The user completed password setup, authenticator enrollment, email verification and acceptance of the separate application invitation. The temporary enrollment client was removed; only the staging web client remains. No email was sent before authorization, and no password or MFA credential was set on the user's behalf.

Live Dedrone ingestion/revocation, authenticated browser concurrency, backup/restore and rollback drills remain unverified. Provider specifications, approved credentials and representative payloads remain prerequisites for live integration. Public-site PR #5 remains unpublished; production release and main merges have not occurred.
