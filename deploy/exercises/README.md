# Anconison deployment gauntlet

The user authorized simulated participants only, no external invitations, and requested to watch the incident as it happens. The plan is in `anconison-helene-gauntlet.json`.

Use a clearly labeled historical Hurricane Helene exercise with six fictional participating agencies and Anconison as originator. Do not imply that actual emergency agencies participated. The NC DPS sources establish real-world rescue/aviation context; the exercise behavior is invented for testing.

Run application services and forced row-level security, not direct database updates masquerading as user actions. Operator setup may create isolated, named exercise fixtures and simulated sessions; report that distinction and separately verify the administrator's real Cognito login. No emails, SMS messages or other outside invitations are permitted for synthetic participants. Do not load the generic demo seed into production.

Keep platform administration separate from the Anconison operational membership. Open the observer's incident/command view before starting. Use paced steps with start/pause/resume/stop, and label each outcome observed, failed, or not run. Preserve failure evidence. Do not run the scenario offscreen and call it a live demonstration.

Observer release observer-20261002 adds three-second foreground polling for incident-room, roster, history, assignments, command board, map and invitation inbox. This is periodic refresh, not a push stream. Command profile drafts are initialized once per incident so polling cannot overwrite unfinished edits. Command view includes exercise labeling, pause/resume and failure indication. Authenticated observer browser verification remains pending.

Administrator TOTP enrollment has now been verified through Cognito: SOFTWARE_TOKEN_MFA is enabled and preferred. The temporary client 25t499hvu5he3g8be9lbrkgh97 was deleted and the local helper stopped. The user manually ran the activation helper after automatic approval review blocked agent execution. The invitation was accepted. A read-only production check on 2026-10-02 UTC confirmed account_status=active, platform_membership=true, pending_invitations=0, and active_sessions=1. Verification task 98d158e64596439db5db870b827542e7 exited 0. Agency operational authorization remains a separate check.

Next: establish and verify Anconison exercise membership, implement/rehearse the actual service runner against disposable data, deploy live-refresh changes, open the observer view, then run the bounded gauntlet. Backup restoration, rollback and alert delivery must also be proven before declaring public readiness.

Production preparation on 2026-10-02 UTC: task 87309b3c427e4276bbc18677d5b77259 exited 0. Seven exercise agencies and draft incident 513ce2ca-a791-4e55-89e4-cd37fee87de6 exist. admin@airsagent.com has explicit incident_commander membership in exercise organization e3a8890f-3aea-4a60-a147-186910da11c5. Synthetic accounts have no passwords, no external identities and no external messages. Temporary fixture sessions were revoked in cleanup. Scenario remains DRAFT / NOT STARTED. Paced gauntlet runner, production authorization/load checks and observer readiness are still pending.

Validation: typecheck and both ARM64 Docker builds passed. 357 unit tests passed; 79 database-dependent tests were skipped by the plain unit command. Separate disposable-PostgreSQL preparation test applied all migrations and passed twice, checking seven agencies, one draft, idempotence and zero active synthetic sessions. This is preparation validation, not the full gauntlet.
