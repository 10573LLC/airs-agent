import { createFileRoute } from "@tanstack/react-router";
import { ROLE_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac/roles";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AIRS Agent — Airspace Coordination Foundation" },
      {
        name: "description",
        content:
          "Foundation stage of AIRS Agent: portable multi-tenant airspace coordination platform for public-safety agencies.",
      },
      { property: "og:title", content: "AIRS Agent — Airspace Coordination Foundation" },
      {
        property: "og:description",
        content:
          "Architecture, tenant model, RBAC and PostgreSQL foundation for incident-based airspace coordination.",
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

// Stage 1 renders the actual, source-derived foundation state only.
// No decorative controls: there are no application workflows yet.
function FoundationStatus() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Stage 1 — Foundation
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">AIRS Agent</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Incident-based airspace coordination for public-safety agencies. No application screens
        exist yet: this build establishes the portable architecture, PostgreSQL schema, tenant
        isolation and role model.
      </p>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-foreground">Role model (from source)</h2>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {ROLE_KEYS.map((key) => (
            <li key={key} className="flex flex-col gap-1 px-4 py-3">
              <span className="text-sm font-medium text-foreground">{ROLE_LABELS[key]}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {ROLE_PERMISSIONS[key].join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-foreground">Documentation in repository</h2>
        <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs text-muted-foreground">
          {DOCS.map((doc) => (
            <li key={doc}>{doc}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
