import { createFileRoute, Link } from "@tanstack/react-router";

import {
  BRAND,
  BrandHorizontal,
  BrandMark,
  DataRow,
  PageHeading,
  PageShell,
  SectionCard,
  StatusPill,
} from "@/components/brand";
import { ROLE_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac/roles";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AIRS Agent — Secure Airspace Incident Coordination" },
      {
        name: "description",
        content:
          "AIRS Agent coordinates drone and crewed-aircraft operations across public-safety agencies with tenant-isolated incident rooms and default-deny access.",
      },
      { property: "og:title", content: "AIRS Agent — Secure Airspace Incident Coordination" },
      {
        property: "og:description",
        content:
          "Incident rooms, trusted-agency sharing and audited closure for public-safety airspace coordination.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FoundationStatus,
});

const DOCS = [
  "ARCHITECTURE.md",
  "DATABASE.md",
  "SECURITY.md",
  "LOCAL_SETUP.md",
  "CHANGELOG.md",
  "BUILD_AUDIT.md",
];

const STAGES = [
  { name: "Foundation & portability", state: "Closed", tone: "active" as const },
  { name: "Authentication & authorization", state: "Closed", tone: "active" as const },
  { name: "Incident room lifecycle", state: "Closed", tone: "active" as const },
  { name: "Branding & expiration operations", state: "Current", tone: "info" as const },
];

// This screen reports source-derived build state only. No decorative controls:
// application workflows live behind the console and incident routes.
function FoundationStatus() {
  return (
    <PageShell
      variant="public"
      headerRight={
        <Link
          to="/auth"
          className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
        >
          Sign in
        </Link>
      }
    >
      <PageHeading
        eyebrow="Stage 5A — Branding & expiration operations"
        title="Secure airspace coordination, one incident at a time"
        description="AIRS Agent lets separate public-safety agencies open a temporary incident room, share approved airspace information under explicit permission, and end that sharing the moment the incident closes."
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <SectionCard title="Build stages" className="lg:col-span-2">
          <ul className="divide-y divide-border">
            {STAGES.map((stage) => (
              <li key={stage.name} className="flex items-center justify-between gap-4 py-2.5">
                <span className="text-sm text-foreground">{stage.name}</span>
                <StatusPill tone={stage.tone}>{stage.state}</StatusPill>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Brand" description="Approved package v2, transparent masters">
          <div className="flex flex-col items-center gap-4">
            <BrandMark size={112} />
            <BrandHorizontal width={260} />
            <p className="text-center text-xs text-muted-foreground">{BRAND.tagline}</p>
          </div>
        </SectionCard>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Role model"
          description="Nine roles, enforced server-side and by row-level security"
        >
          <ul className="divide-y divide-border">
            {ROLE_KEYS.map((key) => (
              <li key={key} className="flex flex-col gap-1 py-2.5">
                <span className="text-sm font-medium text-foreground">{ROLE_LABELS[key]}</span>
                <span className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {ROLE_PERMISSIONS[key].join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Operational guarantees">
            <DataRow label="Tenancy" value="forced RLS, default deny" />
            <DataRow label="Ownership" value="immutable per incident" />
            <DataRow label="Sharing" value="ends at closure or expiry" />
            <DataRow label="Expiration" value="airs.expire_incident_state()" />
            <DataRow label="Audit" value="every state change recorded" />
          </SectionCard>

          <SectionCard title="Documentation in repository">
            <ul className="grid grid-cols-2 gap-2 font-mono text-xs text-muted-foreground">
              {DOCS.map((doc) => (
                <li key={doc}>{doc}</li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </PageShell>
  );
}
