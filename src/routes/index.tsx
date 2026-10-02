import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell, PageHeading, SectionCard } from "@/components/brand";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AIRS Agent — One incident. One shared operational picture." },
      {
        name: "description",
        content:
          "Entity-led incident coordination. Authorized observations, responders, aircraft, hazards, and context in one Common Operating Picture.",
      },
    ],
  }),
  component: PublicOverview,
});

function PublicOverview() {
  return (
    <PageShell
      variant="public"
      headerRight={
        <Link to="/auth" className="rounded border px-3 py-2 text-sm">
          Sign in
        </Link>
      }
    >
      <PageHeading
        eyebrow="Awareness · Intelligence · Response · Security"
        title="One incident. One shared operational picture."
        description="AIRS connects entities and brings authorized information into an incident-centric Common Operating Picture: what is happening, where people and assets are, what is uncertain, and what happens next."
      />
      <div className="mt-8 grid gap-5 md:grid-cols-3">
        <SectionCard title="Partner">
          <p>
            A standing entity relationship defines a sharing envelope. Qualifying incidents activate
            selected sources and information classes under its approval rules.
          </p>
        </SectionCard>
        <SectionCard title="Associate">
          <p>
            An invited entity chooses temporary sharing for one incident. Participation does not
            require a permanent Partner relationship.
          </p>
        </SectionCard>
        <SectionCard title="Participant">
          <p>
            Dispatch, radio, phone, liaison, email, and manual reporting bring operational
            contributions into AIRS, even without source-system ingestion.
          </p>
        </SectionCard>
      </div>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <SectionCard title="Onboard inside AIRS Agent">
          <p>
            Build an entity profile, identify capabilities and source systems, and answer
            platform-specific follow-up questions. Authorizing AIRS ingestion is separate from
            authorizing incident sharing.
          </p>
          <Link className="mt-3 inline-block underline" to="/agency/systems">
            Entity onboarding and Source Systems
          </Link>
        </SectionCard>
        <SectionCard title="Source entities retain ownership">
          <p>
            AIRS preserves provenance, timestamps, confidence, precision, and scope while
            representing permitted information. Specialized source access is supplemental and
            belongs to the entity and event.
          </p>
        </SectionCard>
        <SectionCard title="Make gaps visible">
          <p>
            Unknown, not provided, not authorized, stale, conflicting, unverified, and unavailable
            information have distinct meanings. Correlation preserves every underlying observation.
          </p>
        </SectionCard>
        <SectionCard title="Close the incident, end sharing">
          <p>
            Incident sharing ends at closeout. Temporary external access is tracked through
            confirmed revocation. Cached information expires under policy while designated evidence
            and necessary audit history remain.
          </p>
        </SectionCard>
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        The acquisition model includes APIs and streams, secure tunnels, authorized web adapters,
        structured transports, and human reporting. Each external integration requires source
        authorization and verification. AIRS begins operationally empty; catalog and directory
        presence do not imply connectivity or permission.
      </p>
      <a className="mt-5 inline-block underline" href="https://airsagent.com/">
        Visit the AIRS Agent website
      </a>
    </PageShell>
  );
}
