# Locked framework refactor — implementation and release boundary

## Repository baseline

- Remote `main`: `17d2fd21f51de98155bfe9385e1f27ab8bd0878e` (unchanged).
- Existing completeness draft: PR #3, `task/airs-operational-completeness-20261002`, `ff93bf7e850b15b7ff92c78e6877a320d097f156`.
- Existing live-workspace/deployment branch: `task/aws-ecs-deployment-20260911`, `9d48e1e`.
- This branch combines those two existing lines with a normal merge. It does not rewrite history. The earlier local checkout and its untracked MFA helper remain untouched.
- Review this refactor against the live-workspace/deployment branch to avoid burying product changes in its existing infrastructure diff. This does not merge the deployment work into main or resolve the independent infrastructure draft PR #2.

## Framework coverage

| Point | Implementation | Boundary |
| --- | --- | --- |
| 1 Clean installation | Removed automatic demo seed from Compose. New tables contain no operational fixtures. Existing public directory and reusable technology catalog remain. | Demo seed is explicit and still used only by isolated tests. |
| 2 Ownership | Source profiles remain owner-only under forced RLS. Recipients see normalized observations only. | No source credentials or raw vendor interfaces stored or exposed. |
| 3 Onboarding | Persistent entity profile, contacts, jurisdiction, administrators, identity provider, capabilities; adaptive vendor questions and per-source consent in `/agency/systems`. | Contact and SSO values are declarations, not identity-provider provisioning. |
| 4 Acquisition paths | API/stream, secure tunnel, authorized web, structured transport, and human-reporting vocabulary; source controller, classes, limitations, restrictions, fallback, technical contact and answers. | Actual vendor drivers require specifications and authorized access. This PR does not implement network collectors. |
| 5 AIRS representation | Session-authorized observation write path, provenance-aware representation, map projection. Supplemental access stays separate. | Source-observation entry is an authenticated reporting interface, not a claim of automated vendor acquisition. |
| 6 Readiness | Identified/configured/verified/unavailable receipts, plus authorized/not-now/denied consent independent of sharing. | Readiness receipts are entity-reported; saving a receipt does not test a live connector. |
| 7 Partners | Directional source/class/incident-type envelopes, expiry, revocation, automatic or approval-required activation. | Reciprocal sharing is two independent directional envelopes. Legacy Friends are not silently converted into permission. |
| 8 Associates | Incident invitations can target known AIRS entities without standing trust; explicit old restrictions remain. Incident-only source grants require accepted participation. | The contributing entity's administrator authorizes its own source classes. |
| 9 Participants | Existing ICS coordination roster and manual information paths remain; new normalized human reports carry reporting-entity provenance and reach the COP. | Entities without AIRS accounts participate through their contact/liaison path; this does not create accounts or send messages. |
| 10 Request creation | Existing incident metadata/lifecycle retained; directory and source readiness exposed alongside it. | Discovery does not auto-contact entities. |
| 11 Activation | Automatic Partner activation on room activation/accepted participation; explicit source-owner grant action for approvals and Associates. | Creating a new envelope after activation requires explicit activation or a subsequent qualifying event. |
| 12 Ingestion | Incident/source/class/time gates on normalized reporting. Permission withdrawal and participant revocation immediately invalidate reads. | External transport workers are not available without source-specific integration work. |
| 13 Provenance | Origin, platform, record ID, source/received times, confidence, verification, precision, incident and source grant retained. Source-backed origin/platform are derived server-side. | Raw vendor records remain outside this schema. |
| 14 Correlation | Incident owner can group authorized observations across sources/entities with a reason. Separate correlation links preserve observations; conflicting fresh positions remain visible. | Correlation is explicit, not automatic probabilistic identification. |
| 15 Completeness | Existing reusable AIRS/ICS checks now serve the live workspace. Geography requires actual geometry; resource gaps, command, timing, priorities and next actions remain visible. | Heuristics do not prove all operational information is complete. The UI says no gaps detected by available checks. |
| 16 COP | Normalized positions project into the live map; provenance/evidence and non-location reports remain available in the incident panel. | A 500-observation display limit is explicitly flagged as incomplete rather than silently omitting records. |
| 17 Missing/stale/conflicting | Eight distinct states, source-time aging, explicit missing location, conflicting correlated positions, and source query failure notices. | Reporters must record unavailable/withheld states; there is no vendor health polling worker yet. |
| 18 Supplemental access | Entity/event/source/access-profile/period/provisioning/revocation-owner records and actual revocation receipts. Personnel may rotate. | Does not provision vendor accounts, distribute credentials, or revoke external sessions itself. |
| 19 Continuous operation | Existing 3-second workspace polling and 5-second incident panel polling; current authorization rechecked on reads. | Not a streaming/SSE implementation. |
| 20 Closeout | Atomic trigger ends grants and queues revocation status; shared maintenance sweep expires grants and purges caches; evidence designation preserves selected rows; audit metadata and grants remain. | External credential/session/tunnel revocation remains pending until a provider receipt; automation requires vendor-specific workers. |

`originating_entity` source grants permit an entity to ingest for its own incident scope. This is an ownership scope, not a fourth interentity collaboration relationship.

## Schema and enforcement

Migration `0020_locked_framework.sql` is additive and registered in the canonical migration/repair inventory. It adds entity profiles, source systems, Partner envelopes, incident source grants, operational observations, observation correlation links, and supplemental access records. Existing Friend rows remain historical declarations. No automatic migration promotes their free text into authorization.

All services use the existing session → active membership → role permission → transaction-local organization → unprivileged `airs_app` → forced RLS → audit chain. Read-only incident membership cannot submit observations. Confirmed observations require verification permission. Source profile writes, grants, readiness, and supplemental access require entity administration. Correlation also requires incident ownership and observation-link permission.

Migration and tests run against disposable local PostgreSQL/PostGIS. No production database migration, infrastructure change, credential issue, or website publication is performed by this PR.

## Remaining release work

1. Supply approved vendor API/session/transport specifications, credentials via a secret store, and representative payloads. Implement/test each acquisition and external revocation worker, including reconnection and incident-scoped tunnel/session shutdown. Do not advertise a connector as operational based on catalog presence.
2. Review the combined application branch against the actual deployment baseline, then apply migration 0020 through the existing ledger-backed rollout process. The deployment and infrastructure branches remain separate review decisions.
3. Validate end-to-end operator workflows against a staging deployment with representative multi-entity accounts and load beyond the explicit observation limit. The service tests exercise real database/RLS paths; they are not a production operational acceptance exercise.
4. Publish the separate public-site PR through its existing AWS public-site deployment, and deploy the application landing-page change through the app release. Neither public domain was changed during this refactor.
