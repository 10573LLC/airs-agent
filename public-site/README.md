# AIRS public website — framework copy revision

`airsagent.com/index.html` and `assets/approved-20261001/story.js` revise the existing public page captured from https://airsagent.com/ on 2026-10-02. The approved layout, artwork paths, contact address, and parent-company link remain in place. `style.css` retains the deployed stylesheet and adds a narrow-screen logo overflow correction discovered during preview.

The copy follows the locked 1–20 product framework: entity onboarding inside AIRS, separate ingestion and sharing authorization, five acquisition paths, Partner/Associate/Participant roles, provenance and operational gaps, supplemental entity/event access, and incident closeout.

## Deployment boundary

This is a source-controlled draft, not a production deployment. The current public website is separate from the AIRS application. Existing deployment records identify CloudFront distribution `E1482RA4K42EYF`, private S3 bucket `10573-public-sites-578856792953`, and domain-separated sources under `/home/cloudshell-user/10573-public-preparation/sites/` in AWS CloudShell. Verify those live settings before publishing; they were not changed by this PR.

Apply the HTML and story script to the existing `airsagent.com` source tree and corresponding domain objects. Preserve existing image/font assets and router settings. Invalidate the affected public paths after publishing and verify the domain. The application landing route `src/routes/index.tsx` is a separate entry point and requires the application build/deployment.

For local review, serve `airsagent.com/` and retain the production image assets at their existing `/assets/approved-20261001/` paths. No new image files are introduced.

The page describes the intended product model without promising every named vendor has a production-ready adapter. External integrations require authorization and verification. Walkthrough scenes are illustrative.
