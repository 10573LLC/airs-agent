# Associates, Friends and Capital Region directory — 2026-10-02

Release: friends-directory-20261002. Account 578856792953, us-east-2.

Existing approved relationships remain Associates, preserving incident-invitation eligibility. Each agency administrator can select Friend and explicitly release an operational briefing to the other agency. Read access requires both approved Friend relationships, the publishing agency's share choice and an unexpired review date. Downgrade, suspension or revocation prevents reading the briefing. Incident participation and actual connector activation are separate controls.

Briefings carry agency-declared equipment, communications arrangements, aircraft platforms, detection, video, body-camera and location-sharing capabilities, standing arrangements and coordination contacts. Shared catalog selections are read from the publishing agency's current Systems profile and remain explicitly disconnected. No credentials, radio keys or bearer video links should be entered. No existing relationship was upgraded and no real agency was contacted.

The incident workspace includes relevant participant Friend briefings. Agency Systems includes pre-incident management and the searchable county/service directory.

Directory: 242 service listings from New York's fire and criminal-justice datasets, the state-designated REMO county EMS rosters, and official county/state/federal/provider pages. Listings can overlap across service rosters. Fire dataset updated 2024-12-20; criminal-justice dataset updated 2022-09-15. These contacts are explicitly historical and not agency-confirmed. REMO roster entries without a direct verified number remain visibly pending. The linked state EMS PDF was inspected and excluded because it dates to 2012. County membership is not a verified response boundary. The named local FAA LEAP representative is pending verification; the official contact route is supplied.

Albany Fire's EMS/paramedic role is verified against the city page. The City of Albany Mohawk transport role is user-supplied and labeled accordingly; no inference is made about Mohawk's clinical capabilities elsewhere. Guilderland and Colonie municipal EMS contacts are included from their official sites.

Validation: TypeScript passed; 360 unit tests passed, 79 skipped. Disposable PostGIS database applied all 19 migrations and ran every configured SQL verification file. Friend-specific checks exercise Associate denial, reciprocal sharing, private draft isolation, outsider denial, expiration, unsharing and revocation. Production migration dry run: 18 applied, 1 pending, no conflicts. Apply task 42cea7954cc44efa96309c1420abfa07 exited 0 and recorded migration 0019. Change set affects only WebTask and Service.

Remaining work: finish direct contact/current-jurisdiction verification, assigned-asset operational tasking, visible ICS/CP and subject-event chronology, integration activation and a meaningful operational exercise. This release is not a claim of operational readiness or complete verified directory coverage.

Production rollout completed: CloudFormation UPDATE_COMPLETE; ECS airs-agent-prod:6 has two running tasks, zero pending, rollout COMPLETED. Signed-out route rendered correctly with no captured browser errors. Final authenticated directory/filter visual check is pending because the existing AIRS session expired; no credentials or access controls were bypassed.
