import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { PageHeading, PageShell, SectionCard } from "@/components/brand";
import { getMe, getOrganization } from "@/lib/api/auth.functions";
import { AgencySystemsIntegrationsPanel } from "@/lib/resources/agency-systems-integrations-panel";

export const Route = createFileRoute("/agency/systems")({
  head: () => ({
    meta: [
      { title: "Systems & Integrations - AIRS Agent" },
      {
        name: "description",
        content: "Agency-declared technology ecosystems, installed components, related-system suggestions, and AIRS connection status.",
      },
    ],
  }),
  ssr: false,
  component: AgencySystemsPage,
});

function AgencySystemsPage() {
  const me = useServerFn(getMe);
  const org = useServerFn(getOrganization);
  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const signedIn = session.data?.ok === true;
  const organization = useQuery({
    queryKey: ["org"],
    queryFn: () => org({ data: {} }),
    enabled: signedIn,
  });

  if (session.isLoading) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </PageShell>
    );
  }

  if (!signedIn) {
    return (
      <PageShell width="narrow">
        <PageHeading
          eyebrow="Agency configuration"
          title="Session required"
          description="Sign in to view your agency's Systems & Integrations profile."
        />
        <Link to="/auth" className="mt-6 inline-block text-sm underline">Go to sign in</Link>
      </PageShell>
    );
  }

  if (organization.isLoading) {
    return <PageShell width="narrow"><p className="text-sm text-muted-foreground">Loading agency context...</p></PageShell>;
  }

  const orgResult = organization.data;
  if (orgResult?.ok && orgResult.data.roleKey === "platform_admin") {
    return (
      <PageShell width="narrow">
        <PageHeading
          eyebrow="Agency configuration"
          title="Agency context required"
          description="Platform administration does not grant access to an agency's Systems & Integrations profile. Select an agency membership with appropriate authorization to continue."
        />
        <Link to="/console" className="mt-6 inline-block text-sm underline">Return to Platform Console</Link>
      </PageShell>
    );
  }
  const canManage = orgResult?.ok === true && orgResult.data.permissions.includes("org.manage");

  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link to="/console" className="underline underline-offset-4">Agency Dashboard</Link>
        <span aria-hidden="true">/</span>
        <span className="font-medium text-foreground">Systems & Integrations</span>
      </div>
      <PageHeading
        eyebrow="Agency configuration"
        title="Systems & Integrations"
        description="Define what technology your agency actually uses, distinguish installed systems from AIRS suggestions, and see exactly what is and is not connected to AIRS."
      />

      <div className="mt-6">
        <SectionCard
          title="C-UAS / SAFER SKIES"
          description="Optional capability. Agencies without C-UAS personnel, equipment, or authority continue to use AIRS normally; mutual-aid-only posture is supported."
          actions={
            <Link
              to="/agency/cuas"
              className="rounded-md border border-input px-3 py-2 text-xs font-semibold hover:bg-muted"
            >
              Open C-UAS Readiness
            </Link>
          }
        >
          <p className="text-sm text-muted-foreground">
            Record agency participation, current certified personnel, authorized equipment, reporting deadlines, and mutual-aid posture without turning C-UAS into a prerequisite for incident operations.
          </p>
        </SectionCard>
      </div>

      <div className="mt-8">
        <AgencySystemsIntegrationsPanel canManage={canManage} />
      </div>
    </PageShell>
  );
}
