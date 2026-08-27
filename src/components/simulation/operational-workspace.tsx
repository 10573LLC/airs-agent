import { useMemo, useState } from "react";
import { SectionCard, StatusPill, type StatusTone } from "@/components/brand";
import { CopMap, type MapLayerItem } from "@/components/map/cop-map";
import type { SimOperationalProjection } from "@/lib/simulation/operational";

const mapStyleUrl = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || undefined;
const mapAttribution = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || undefined;

type View = "command" | "agencies" | "resources" | "map" | "timeline";

const agencyTone: Record<string, StatusTone> = {
  active: "active",
  invited: "info",
  requested: "caution",
  notified: "neutral",
};
const resourceTone: Record<string, StatusTone> = {
  on_scene: "active",
  active: "active",
  en_route: "info",
  requested: "caution",
  unknown_location: "neutral",
};

function clock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  return `T+${hours}:${minutes}`;
}
const EMPTY_OPERATIONAL_PROJECTION: SimOperationalProjection = {
  incidentName: "No active exercise",
  incidentStatus: "awaiting scenario",
  commandLead: "Not established",
  priority: "Not established",
  agencies: [], resources: [], mapItems: [], actions: [],
};

export function OperationalWorkspace({ projection: suppliedProjection }: { projection: SimOperationalProjection | null }) {
  const projection = suppliedProjection ?? EMPTY_OPERATIONAL_PROJECTION;
  const [view, setView] = useState<View>("command");
  const mapItems = useMemo<MapLayerItem[]>(() => projection.mapItems.map((item) => ({ ...item })), [projection.mapItems]);
  const views: { id: View; label: string }[] = [
    { id: "command", label: "Command Post" },
    { id: "agencies", label: "Agency Coordination" },
    { id: "resources", label: "Resources / Assignments" },
    { id: "map", label: "Airspace / COP Map" },
    { id: "timeline", label: "Decision Log" },
  ];

  return (
    <section className="mt-8 space-y-4">
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Simulated operational workspace</p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">{projection.incidentName}</h2>
          </div>
          <StatusPill tone="caution">EXERCISE DATA ONLY</StatusPill>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Incident state" value={projection.incidentStatus} />
          <Metric label="Command lead" value={projection.commandLead} />
          <Metric label="Priority" value={projection.priority} />
          <Metric label="Coordination picture" value={`${projection.agencies.length} organizations · ${projection.resources.length} resources`} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={view === item.id
              ? "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
              : "rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === "command" ? <CommandView projection={projection} /> : null}
      {view === "agencies" ? <AgencyView projection={projection} /> : null}
      {view === "resources" ? <ResourceView projection={projection} /> : null}
      {view === "map" ? (
        <SectionCard title="Airspace / Common Operating Picture" description="Only exercise geography supported by facts released at the current clock is plotted. Approximate exercise geometry is labeled as such.">
          <CopMap items={mapItems} styleUrl={mapStyleUrl} attribution={mapAttribution} className="h-[34rem] overflow-hidden rounded-md border border-border" />
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {projection.mapItems.map((item) => (
              <div key={item.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-semibold text-foreground">{item.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
              </div>
            ))}
            {projection.mapItems.length === 0 ? <p className="text-sm text-muted-foreground">No exercise geography has been established yet.</p> : null}
          </div>
        </SectionCard>
      ) : null}
      {view === "timeline" ? <DecisionLog projection={projection} /> : null}
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function CommandView({ projection }: { projection: SimOperationalProjection }) {
  const active = projection.actions.slice(-6).reverse();
  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
      <SectionCard title="Command Post Activity" description="What command leaders and AIRS are doing at the current exercise time.">
        <div className="space-y-3">
          {active.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{clock(item.atSeconds)}</span>
                <StatusPill tone={item.status === "active" ? "active" : item.status === "pending" ? "caution" : "info"}>{item.status}</StatusPill>
                <StatusPill tone={item.channel === "AIRS room" ? "active" : "neutral"}>{item.channel}</StatusPill>
              </div>
              <p className="mt-2 text-sm font-semibold text-foreground">{item.action}</p>
              <p className="mt-1 text-sm text-muted-foreground">{item.actor} → {item.target}</p>
            </div>
          ))}
          {active.length === 0 ? <p className="text-sm text-muted-foreground">No command-post actions have been triggered yet.</p> : null}
        </div>
      </SectionCard>      <SectionCard title="Current Participants" description="AIRS-room participation is distinct from external coordination.">
        <div className="space-y-2">
          {projection.agencies.slice(0, 8).map((item) => (
            <div key={item.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{item.name}</p>
                <StatusPill tone={item.connection === "airs_room" ? "active" : "neutral"}>{item.connection === "airs_room" ? "AIRS room" : item.connection === "regional_mutual_aid" ? "Mutual aid" : "External"}</StatusPill>
                <StatusPill tone={agencyTone[item.status] ?? "neutral"}>{item.status}</StatusPill>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.role}</p>
            </div>
          ))}
          {projection.agencies.length === 0 ? <p className="text-sm text-muted-foreground">No agency coordination has been established yet.</p> : null}
        </div>
      </SectionCard>
    </div>
  );
}

function AgencyView({ projection }: { projection: SimOperationalProjection }) {
  return (
    <SectionCard title="Agency Coordination" description="Shows how participating and non-participating organizations are brought into the operation without pretending every organization has an AIRS account.">
      <div className="grid gap-3 md:grid-cols-2">
        {projection.agencies.map((item) => (
          <article key={item.id} className="rounded-md border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{item.name}</h3>
              <StatusPill tone={item.connection === "airs_room" ? "active" : item.connection === "regional_mutual_aid" ? "info" : "neutral"}>{item.connection.replaceAll("_", " ")}</StatusPill>
              <StatusPill tone={agencyTone[item.status] ?? "neutral"}>{item.status}</StatusPill>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{item.role}</p>
            <p className="mt-2 text-xs text-muted-foreground">{item.coordination}</p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">Added {clock(item.sinceSeconds)}</p>
          </article>
        ))}
      </div>
    </SectionCard>
  );
}
function ResourceView({ projection }: { projection: SimOperationalProjection }) {
  return (
    <SectionCard title="Resources / Assignments" description="Resource requests and positions remain explicit; AIRS does not fabricate a location when the scenario has not supplied one.">
      <div className="space-y-3">
        {projection.resources.map((item) => (
          <div key={item.id} className="grid gap-2 rounded-md border border-border p-4 md:grid-cols-[1.2fr_.8fr_.8fr]">
            <div>
              <p className="text-sm font-semibold text-foreground">{item.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.owner} · {item.category}</p>
            </div>
            <div>
              <StatusPill tone={resourceTone[item.status] ?? "neutral"}>{item.status.replaceAll("_", " ")}</StatusPill>
              <p className="mt-2 font-mono text-xs text-muted-foreground">Since {clock(item.sinceSeconds)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Location</p>
              <p className="mt-1 text-sm text-foreground">{item.location}</p>
            </div>
          </div>
        ))}
        {projection.resources.length === 0 ? <p className="text-sm text-muted-foreground">No resources have been established from released facts.</p> : null}
      </div>
    </SectionCard>
  );
}

function DecisionLog({ projection }: { projection: SimOperationalProjection }) {
  return (
    <SectionCard title="Coordination / Decision Log" description="This is the simulated command-post workflow generated from released exercise facts, not the controller's future timeline.">
      <ol className="space-y-3">
        {projection.actions.map((item) => (
          <li key={item.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{clock(item.atSeconds)}</span>
              <StatusPill tone={item.channel === "AIRS room" ? "active" : item.channel === "System" ? "info" : "neutral"}>{item.channel}</StatusPill>
              <StatusPill tone={item.status === "active" ? "active" : item.status === "pending" ? "caution" : "info"}>{item.status}</StatusPill>
            </div>
            <p className="mt-2 text-sm font-semibold text-foreground">{item.action}</p>
            <p className="mt-1 text-sm text-muted-foreground">{item.actor} → {item.target}</p>
          </li>
        ))}
        {projection.actions.length === 0 ? <li className="text-sm text-muted-foreground">No command-post decisions have been generated yet.</li> : null}
      </ol>
    </SectionCard>
  );
}