# Automatic Anconison agency workflow

The human operates **Requesting Agency — EXERCISE**. Twelve separately owned Anconison exercise agencies respond automatically: police, fire/rescue, EMS, dispatch, UAS, emergency management, hospital, hazmat, search/rescue, utilities, public works and shelter/relief.

This runs on the actual operational platform. Each agency has an entity profile, source declaration, administrator and incident-commander identities, two fictional resources and two fictional crews. Its identities use the same authorization, participation, readiness, assignment, disclosure, report and audit services as a human agency. The web application retains Cognito authentication and MFA. Machine credentials exist only in an isolated staging process without a network listener; the process cannot run against a production database hostname. The provisioner alone receives a staging database-owner credential. The responder execution role receives only the application database credential and its exercise seed.

## User workflow

Open **Platform Console → Open requesting agency**. Create an incident, activate it, then open its operational workspace. **Request aid and agency responses** contains a multi-select receiving-agency directory, requested capability, units per agency, assistance description, priority and staging location. Sending invites selected entities to participate and creates an addressed request for each. The UI reports partial send failures and retries retain the same batch identifier.

Responders accept eligible invitations from the configured requesting agency, acknowledge the request, compare the structured requested capability with their service profile, allocate their own available resources/crews, apply incident disclosure, submit actual assignments and operational reports, and return filled/partially-filled/denied responses. Responses and attributed history appear in the request panel; assignments and reports flow into the existing incident picture. A database advisory lock prevents concurrent responder instances. The worker refreshes identity sessions and polls every five seconds. Existing response/report receipts prevent duplicate normal retries. Resource and crew readiness returns to available when the incident closes or participation ends.

Migration 0022 adds an addressed recipient and append-only agency response records, forced RLS and a recipient-scoped request lock. Responses require current operational participation, the addressed recipient, the actor's own identity, an active incident and an uncancelled request. Platform-administrator rights are not broadened. The controller receives an explicit incident-commander membership in the new requesting agency.

## Boundaries

The automated responders use deterministic capability/capacity policies. They are not generative AI agents and do not interpret arbitrary prose as operational orders. Description, priority and staging are retained; allocation follows the selected capability and quantity. Each agency starts with two available units. No real dispatch, provider connection, external message, autonomous flight, invented arrival time or inferred coordinates is performed. Location is explicitly unknown until reported. Service-specific specialist systems such as clinical records, fire dispatch software or live UAS telemetry are not emulated by this fixture.

## Verification

463 tests in 42 files and all 14 SQL suites passed against disposable PostgreSQL/PostGIS. The automatic workflow test provisions actual entities/identities, routes to multiple recipients, accepts participation, shares and assigns resources, preserves response attribution, verifies partial capacity, idempotent batch retry, wrong-agency denial, closure denial and readiness release. TypeScript, ARM64 web and operator container builds passed. Cloud/browser evidence is recorded after rollout in the staging deployment notes.
