import { useMemo, useState, type ReactNode } from "react";
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
  agencies: [],
  resources: [],
  mapItems: [],
  actions: [],
};

const views: { id: View; label: string }[] = [
  { id: "command", label: "Command Post" },
  { id: "agencies", label: "Agency Coordination" },
  { id: "resources", label: "Resources / Assignments" },
  { id: "map", label: "Airspace / COP Map" },
  { id: "timeline", label: "Decision Log" },
];

export function OperationalWorkspace({ projection: suppliedProjection }: { projection: SimOperationalProjection | null }) {
  const projection = suppliedProjection ?? EMPTY_OPERATIONAL_PROJECTION;
  const [view, setView] = useState<View>("command");
  const mapItems = useMemo<MapLayerItem[]>(
    () => projection.mapItems.map((item) => ({ ...item })),
    [projection.mapItems],
  );

  return (
    <section className="mt-5 space-y-4">
      <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Simulated operational workspace</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">{projection.incidentName}</h2>
          </div>
          <StatusPill tone="caution">EXERCISE DATA ONLY</StatusPill>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Incident state" value={projection.incidentStatus} />
          <Metric label="Command lead" value={projection.commandLead} />
          <Metric label="Priority" value={projection.priority} />
          <Metric label="Coordination picture" value={`${projection.agencies.length} organizations · ${projection.resources.length} resources`} />
        </div>
      </div>

      <div className="xl:hidden">
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
        <div className="mt-4">
          {view === "command" ? <CommandView projection={projection} /> : null}
          {view === "agencies" ? <AgencyView projection={projection} /> : null}
          {view === "resources" ? <ResourceView projection={projection} /> : null}
          {view === "map" ? <MapView projection={projection} mapItems={mapItems} /> : null}
          {view === "timeline" ? <DecisionLog projection={projection} /> : null}
        </div>
      </div>

      <DesktopConsole projection={projection} mapItems={mapItems} />
    </section>
  );
}

function DesktopConsole({ projection, mapItems }: { projection: SimOperationalProjection; mapItems: MapLayerItem[] }) {
  return (
    <div className="hidden xl:grid xl:grid-cols-[minmax(260px,360px)_minmax(560px,1fr)_minmax(280px,400px)] xl:gap-3">
      <div className="grid h-[min(64rem,calc(100vh-14rem))] min-h-[38rem] min-w-0 grid-rows-2 gap-3">
        <DesktopCommandPanel projection={projection} />
        <DesktopAgencyPanel projection={projection} />
      </div>
      <DesktopMapPanel projection={projection} mapItems={mapItems} />
      <div className="grid h-[min(64rem,calc(100vh-14rem))] min-h-[38rem] min-w-0 grid-rows-2 gap-3">
        <DesktopResourcePanel projection={projection} />
        <DesktopDecisionPanel projection={projection} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/70 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function DesktopPanel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
      <div className="border-b border-border px-3 py-2.5">
        <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>
    </section>
  );
}

function DesktopCommandPanel({ projection }: { projection: SimOperationalProjection }) {
  const active = projection.actions.slice(-8).reverse();
  return (
    <DesktopPanel title="Command Post" description="Current command activity and requests.">
      <div className="divide-y divide-border">
        {active.map((item) => (
          <div key={item.id} className="py-2 first:pt-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">{clock(item.atSeconds)}</span>
              <StatusPill tone={item.status === "active" ? "active" : item.status === "pending" ? "caution" : "info"}>{item.status}</StatusPill>
              <StatusPill tone={item.channel === "AIRS room" ? "active" : "neutral"}>{item.channel}</StatusPill>
            </div>
            <p className="mt-1 text-sm font-semibold text-foreground">{item.action}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.actor} → {item.target}</p>
          </div>
        ))}
        {active.length === 0 ? <p className="text-sm text-muted-foreground">No command-post actions have been triggered yet.</p> : null}
      </div>
    </DesktopPanel>
  );
}

function DesktopAgencyPanel({ projection }: { projection: SimOperationalProjection }) {
  return (
    <DesktopPanel title="Agency Coordination" description="AIRS participants and external liaison paths.">
      <div className="divide-y divide-border">
        {projection.agencies.map((item) => (
          <div key={item.id} className="py-2 first:pt-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-semibold text-foreground">{item.name}</p>
              <StatusPill tone={item.connection === "airs_room" ? "active" : item.connection === "regional_mutual_aid" ? "info" : "neutral"}>{item.connection === "airs_room" ? "AIRS" : item.connection === "regional_mutual_aid" ? "Mutual aid" : "External"}</StatusPill>
              <StatusPill tone={agencyTone[item.status] ?? "neutral"}>{item.status}</StatusPill>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.role}</p>
          </div>
        ))}
        {projection.agencies.length === 0 ? <p className="text-sm text-muted-foreground">No agency coordination has been established yet.</p> : null}
      </div>
    </DesktopPanel>
  );
}

function DesktopResourcePanel({ projection }: { projection: SimOperationalProjection }) {
  return (
    <DesktopPanel title="Resources / Assignments" description="Status and location without fabricated positions.">
      <div className="divide-y divide-border">
        {projection.resources.map((item) => (
          <div key={item.id} className="py-2 first:pt-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-semibold text-foreground">{item.name}</p>
              <StatusPill tone={resourceTone[item.status] ?? "neutral"}>{item.status.replaceAll("_", " ")}</StatusPill>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.owner} · {item.category}</p>
            <p className="mt-0.5 text-xs text-foreground">{item.location}</p>
          </div>
        ))}
        {projection.resources.length === 0 ? <p className="text-sm text-muted-foreground">No resources have been established from released facts.</p> : null}
      </div>
    </DesktopPanel>
  );
}

function DesktopDecisionPanel({ projection }: { projection: SimOperationalProjection }) {
  return (
    <DesktopPanel title="Decision Log" description="Coordination decisions generated from released facts.">
      <div className="divide-y divide-border">
        {projection.actions.map((item) => (
          <div key={item.id} className="py-2 first:pt-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">{clock(item.atSeconds)}</span>
              <StatusPill tone={item.channel === "AIRS room" ? "active" : item.channel === "System" ? "info" : "neutral"}>{item.channel}</StatusPill>
            </div>
            <p className="mt-1 text-sm font-semibold text-foreground">{item.action}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.actor} → {item.target}</p>
          </div>
        ))}
        {projection.actions.length === 0 ? <p className="text-sm text-muted-foreground">No command-post decisions have been generated yet.</p> : null}
      </div>
    </DesktopPanel>
  );
}

function DesktopMapPanel({ projection, mapItems }: { projection: SimOperationalProjection; mapItems: MapLayerItem[] }) {
  return (
    <section className="flex h-[min(64rem,calc(100vh-14rem))] min-h-[38rem] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">Airspace / Common Operating Picture</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Live exercise geography from facts released at the current clock.</p>
        </div>
        <StatusPill tone="info">{projection.mapItems.length} plotted</StatusPill>
      </div>
      <div className="min-h-0 flex-1 p-2.5">
        <CopMap items={mapItems} styleUrl={mapStyleUrl} attribution={mapAttribution} className="h-full w-full overflow-hidden rounded-md border border-border" />
      </div>
      <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        Approximate exercise geometry is labeled. Unknown positions remain unplotted.
      </div>
    </section>
  );
}

function MapView({ projection, mapItems, desktop = false }: { projection: SimOperationalProjection; mapItems: MapLayerItem[]; desktop?: boolean }) {
  return (
    <SectionCard
      title="Airspace / Common Operating Picture"
      description="Exercise geography supported by facts released at the current clock."
      className={desktop ? "min-w-0" : undefined}
    >
      <CopMap
        items={mapItems}
        styleUrl={mapStyleUrl}
        attribution={mapAttribution}
        className={`${desktop ? "h-[44rem]" : "h-[34rem]"} overflow-hidden rounded-md border border-border`}
      />
      {desktop ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <StatusPill tone="info">{projection.mapItems.length} plotted items</StatusPill>
          <span>Approximate exercise geometry remains labeled; unknown positions stay unplotted.</span>
        </div>
      ) : (
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {projection.mapItems.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-3 text-sm">
              <p className="font-semibold text-foreground">{item.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
            </div>
          ))}
          {projection.mapItems.length === 0 ? <p className="text-sm text-muted-foreground">No exercise geography has been established yet.</p> : null}
        </div>
      )}
    </SectionCard>
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
      </SectionCard>
      <SectionCard title="Current Participants" description="AIRS-room participation is distinct from external coordination.">
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
    <SectionCard title="Agency Coordination" description="Participating and non-participating organizations without pretending every organization has an AIRS account.">
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
        {projection.agencies.length === 0 ? <p className="text-sm text-muted-foreground">No agency coordination has been established yet.</p> : null}
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
    <SectionCard title="Coordination / Decision Log" description="Simulated command-post workflow from released exercise facts, not the controller's future timeline.">
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
