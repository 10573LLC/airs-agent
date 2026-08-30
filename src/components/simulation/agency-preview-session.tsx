import { useMemo, useState, type ReactNode } from "react";
import { StatusPill } from "@/components/brand";
import { CopMap } from "@/components/map/cop-map";
import {
  OBSERVATION_SOURCES,
  OBSERVATION_SOURCE_LABELS,
  OBSERVATION_TYPES,
  OBSERVATION_TYPE_LABELS,
  URGENCY_LABELS,
  URGENCY_LEVELS,
  type ObservationSource,
  type ObservationType,
  type UrgencyLevel,
} from "@/lib/awareness/model";
import {
  MAP_FEATURE_LABELS,
  MAP_FEATURE_TYPES,
  type MapFeatureType,
} from "@/lib/map/model";
import {
  CATEGORY_LABELS,
  CATEGORY_STATUSES,
  RESOURCE_CATEGORIES,
  STATUS_LABELS,
  type ReadinessStatus,
  type ResourceCategory,
} from "@/lib/resources/model";
import {
  AGENCY_PREVIEW_ROLES,
  AGENCY_PREVIEW_ROLE_LABELS,
  PREVIEW_BOUNDARY,
  previewHasPermission,
  previewRoleSummary,
  previewWalkthroughRole,
  type AgencyPreviewRole,
} from "@/lib/simulation/agency-preview";
import type { SimAgencyInformationPath, SimOperationalProjection } from "@/lib/simulation/operational";
import type { SimConfidence, SimSource } from "@/lib/simulation/model";
import type { SimWalkthroughEntry } from "@/lib/simulation/walkthrough";

const mapStyleUrl = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || undefined;
const mapAttribution = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || undefined;
const inputClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
const labelClass = "block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const buttonClass = "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButton = "rounded-md border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

type PreviewModule = "operations" | "command" | "awareness" | "readiness" | "cop" | "coordination";
const modules: { id: PreviewModule; label: string }[] = [
  { id: "operations", label: "Operations" },
  { id: "command", label: "Command" },
  { id: "awareness", label: "Awareness" },
  { id: "readiness", label: "Readiness" },
  { id: "cop", label: "COP" },
  { id: "coordination", label: "Coordination" },
];
const informationPaths: SimAgencyInformationPath[] = [
  "system_integration",
  "command_post_liaison",
  "dispatch",
  "radio",
  "phone",
  "email",
  "manual_entry",
  "mutual_aid_coordination",
  "other",
];

function formatClock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  return `T+${hours}:${minutes}`;
}
function id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={labelClass}>{label}<div className="mt-1">{children}</div></label>;
}
function sourceFor(source: ObservationSource): SimSource {
  if (source === "dispatch_communications_report") return "911/CAD";
  if (source === "manual_sensor_reading") return "Airspace/C-UAS";
  if (source === "partner_agency_report") return "Law Enforcement";
  return "RTCC";
}
export function AgencyPreviewSession({
  scenarioTitle,
  clockSeconds,
  agencyName,
  onAgencyNameChange,
  role,
  onRoleChange,
  entries,
  projection,
  onAdd,
  onClose,
  splitView,
  onSplitViewChange,
}: {
  scenarioTitle: string;
  clockSeconds: number;
  agencyName: string;
  onAgencyNameChange: (value: string) => void;
  role: AgencyPreviewRole;
  onRoleChange: (role: AgencyPreviewRole) => void;
  entries: SimWalkthroughEntry[];
  projection: SimOperationalProjection;
  onAdd: (entry: SimWalkthroughEntry) => void;
  onClose: () => void;
  splitView: boolean;
  onSplitViewChange: (value: boolean) => void;
}) {
  const [module, setModule] = useState<PreviewModule>("operations");
  const permissions = useMemo(() => previewRoleSummary(role), [role]);
  const base = () => ({ id: id(), atSeconds: clockSeconds, role: previewWalkthroughRole(role), organizationName: agencyName.trim() || "Preview Agency" });
  const [situation, setSituation] = useState("");
  const [commandLead, setCommandLead] = useState("");
  const [priority, setPriority] = useState("");
  const [observationType, setObservationType] = useState<ObservationType>("unidentified_aircraft");
  const [observationSource, setObservationSource] = useState<ObservationSource>("direct_reporting_user");
  const [urgency, setUrgency] = useState<UrgencyLevel>("routine");
  const [observationTitle, setObservationTitle] = useState("");
  const [observationDetail, setObservationDetail] = useState("");
  const [observedObject, setObservedObject] = useState("");
  const [observedBehavior, setObservedBehavior] = useState("");
  const [observedCount, setObservedCount] = useState("");
  const [observedAltitude, setObservedAltitude] = useState("");
  const [obsLat, setObsLat] = useState("");
  const [obsLng, setObsLng] = useState("");
  const [resourceCategory, setResourceCategory] = useState<ResourceCategory>("aircraft");
  const [resourceName, setResourceName] = useState("");
  const [callsign, setCallsign] = useState("");
  const [readiness, setReadiness] = useState<ReadinessStatus>("available");
  const [commitResource, setCommitResource] = useState(false);
  const [resourceLocation, setResourceLocation] = useState("");
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [featureType, setFeatureType] = useState<MapFeatureType>("point_of_interest");
  const [featureLabel, setFeatureLabel] = useState("");
  const [featureDetail, setFeatureDetail] = useState("");
  const [coordinationName, setCoordinationName] = useState("");
  const [coordinationRole, setCoordinationRole] = useState("");
  const [informationPath, setInformationPath] = useState<SimAgencyInformationPath>("command_post_liaison");
  const [notice, setNotice] = useState<string | null>(null);

  const ownedResources = useMemo(() => {
    const rows = entries.filter((entry): entry is Extract<SimWalkthroughEntry, { kind: "resource_status" }> => entry.kind === "resource_status" && entry.organizationName === (agencyName.trim() || "Preview Agency"));
    const latest = new Map<string, Extract<SimWalkthroughEntry, { kind: "resource_status" }>>();
    for (const row of rows) latest.set(`${row.resourceName}|${row.callsign ?? ""}`, row);
    return [...latest.values()];
  }, [agencyName, entries]);

  const recentAgencyEntries = useMemo(
    () => entries.filter((entry) => entry.atSeconds <= clockSeconds).slice(-8).reverse(),
    [clockSeconds, entries],
  );
  const canCoordinate = previewHasPermission(role, "incident.update") || previewHasPermission(role, "incident.invite_partner");
  const canWriteCop = permissions.canReportPosition || permissions.canManageMapFeature;

  const addCommand = () => {
    if (!situation.trim()) return setNotice("Enter the current situation before saving the update.");
    onAdd({ ...base(), kind: "command_update", situation: situation.trim(), commandLead: commandLead.trim() || undefined, priority: priority.trim() || undefined });
    setSituation(""); setCommandLead(""); setPriority(""); setNotice("Exercise command update entered.");
  };
  const addObservation = () => {
    if (!observationTitle.trim() || !observationDetail.trim()) return setNotice("Enter an observation title and what was observed.");
    const lat = obsLat.trim() ? Number(obsLat) : undefined;
    const lng = obsLng.trim() ? Number(obsLng) : undefined;
    if ((lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))) return setNotice("Latitude or longitude is invalid.");
    const confidence: SimConfidence = urgency === "immediate" ? "reported" : "reported";
    onAdd({ ...base(), kind: "observation", source: sourceFor(observationSource), title: observationTitle.trim(), detail: observationDetail.trim(), confidence, observationType, sourceType: observationSource, urgency, observedObject: observedObject.trim() || undefined, observedBehavior: observedBehavior.trim() || undefined, observedCount: observedCount ? Math.max(0, Number(observedCount) || 0) : undefined, observedAltitudeFt: observedAltitude ? Number(observedAltitude) : undefined, latitude: lat, longitude: lng });
    setObservationTitle(""); setObservationDetail(""); setObservedObject(""); setObservedBehavior(""); setObservedCount(""); setObservedAltitude(""); setObsLat(""); setObsLng("");
    setNotice("Exercise observation filed. AIRS received it as agency-entered information.");
  };

  const addResource = () => {
    if (!resourceName.trim()) return setNotice("Enter the resource name.");
    const existing = ownedResources.find((row) => row.resourceName.toLowerCase() === resourceName.trim().toLowerCase() && (!callsign.trim() || row.callsign?.toLowerCase() === callsign.trim().toLowerCase()));
    if (!permissions.canCreateResource && !existing) return setNotice("This role can update existing resources but cannot create a new agency resource. Select or enter an existing preview resource first.");
    const status = CATEGORY_STATUSES[resourceCategory].includes(readiness) ? readiness : CATEGORY_STATUSES[resourceCategory][0] ?? "available";
    onAdd({ ...base(), kind: "resource_status", resourceName: resourceName.trim(), category: resourceCategory, readinessStatus: status, callsign: callsign.trim() || undefined, commitToOperation: commitResource && permissions.canAssignResource, location: resourceLocation.trim() || undefined });
    setResourceName(""); setCallsign(""); setResourceLocation(""); setCommitResource(false);
    setNotice(commitResource && permissions.canAssignResource ? "Exercise resource updated and committed to the operation." : "Exercise readiness record updated.");
  };
  const addMapReport = () => {
    if (!picked || !featureLabel.trim()) return setNotice("Select a point on the map and enter a label.");
    onAdd({ ...base(), kind: "map_report", label: `${MAP_FEATURE_LABELS[featureType]} · ${featureLabel.trim()}`, detail: featureDetail.trim() || "Agency-reported exercise geography.", latitude: picked[1], longitude: picked[0] });
    setFeatureLabel(""); setFeatureDetail(""); setPicked(null); setNotice("Exercise COP report entered.");
  };

  const addCoordination = () => {
    if (!coordinationName.trim()) return setNotice("Enter the organization name.");
    onAdd({ ...base(), kind: "coordination", organizationName: coordinationName.trim(), operationalRole: coordinationRole.trim(), informationPath });
    setCoordinationName(""); setCoordinationRole(""); setNotice("Exercise coordination organization entered.");
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-primary/30 bg-card shadow-panel">
      <header className="shrink-0 border-b border-border bg-primary/5 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="caution">EXERCISE AGENCY SESSION</StatusPill>
          <StatusPill tone="info">{formatClock(clockSeconds)}</StatusPill>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{scenarioTitle}</span>
          <button type="button" className={secondaryButton} onClick={() => onSplitViewChange(!splitView)}>{splitView ? "Agency only" : "Show AIRS effect"}</button>
          <button type="button" className={secondaryButton} onClick={onClose}>Exit preview</button>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr]">
          <Field label="Preview agency">
            <input value={agencyName} onChange={(event) => onAgencyNameChange(event.target.value)} className={inputClass} maxLength={160} />
          </Field>
          <Field label="Agency role">
            <select value={role} onChange={(event) => onRoleChange(event.target.value as AgencyPreviewRole)} className={inputClass}>
              {AGENCY_PREVIEW_ROLES.map((value) => <option key={value} value={value}>{AGENCY_PREVIEW_ROLE_LABELS[value]}</option>)}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{PREVIEW_BOUNDARY}</p>
      </header>

      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2" aria-label="Exercise agency modules">
        {modules.map((item) => (
          <button key={item.id} type="button" onClick={() => setModule(item.id)} className={module === item.id ? "rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground" : "rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"}>
            {item.label}
          </button>
        ))}
      </nav>

      {notice ? <p role="status" className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs text-foreground">{notice}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {module === "operations" ? <OperationsView role={role} permissions={permissions} projection={projection} entries={recentAgencyEntries} /> : null}
        {module === "command" ? (
          <ModulePanel title="Incident command" description="Same agency command concepts as the live Command Console; controls follow the selected role's actual AIRS permissions.">
            <div className="grid gap-3">
              <Field label="Current situation"><textarea rows={4} value={situation} onChange={(e) => setSituation(e.target.value)} className={inputClass} disabled={!permissions.canUpdateIncident} /></Field>
              <Field label="Command lead / structure"><input value={commandLead} onChange={(e) => setCommandLead(e.target.value)} className={inputClass} placeholder="Unified Command, IC, branch lead..." disabled={!permissions.canUpdateIncident} /></Field>
              <Field label="Current priority"><input value={priority} onChange={(e) => setPriority(e.target.value)} className={inputClass} disabled={!permissions.canUpdateIncident} /></Field>
              <button type="button" className={buttonClass} disabled={!permissions.canUpdateIncident || !situation.trim()} onClick={addCommand}>Save command update</button>
              {!permissions.canUpdateIncident ? <ReadOnlyNotice role={role} text="This role can view the operation but does not have incident.update authority." /> : null}
            </div>
          </ModulePanel>
        ) : null}

        {module === "awareness" ? (
          <ModulePanel title="Manual airspace observation" description="Uses the same observation vocabulary as the live Awareness Board. Agency entry remains information, not an automated determination.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Observation type"><select value={observationType} onChange={(e) => setObservationType(e.target.value as ObservationType)} className={inputClass} disabled={!permissions.canCreateObservation}>{OBSERVATION_TYPES.map((value) => <option key={value} value={value}>{OBSERVATION_TYPE_LABELS[value]}</option>)}</select></Field>
              <Field label="Source"><select value={observationSource} onChange={(e) => setObservationSource(e.target.value as ObservationSource)} className={inputClass} disabled={!permissions.canCreateObservation}>{OBSERVATION_SOURCES.map((value) => <option key={value} value={value}>{OBSERVATION_SOURCE_LABELS[value]}</option>)}</select></Field>
              <Field label="Urgency"><select value={urgency} onChange={(e) => setUrgency(e.target.value as UrgencyLevel)} className={inputClass} disabled={!permissions.canCreateObservation}>{URGENCY_LEVELS.map((value) => <option key={value} value={value}>{URGENCY_LABELS[value]}</option>)}</select></Field>
              <Field label="Title"><input value={observationTitle} onChange={(e) => setObservationTitle(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field>
            </div>
            <div className="mt-3 grid gap-3">
              <Field label="What was observed"><textarea rows={4} value={observationDetail} onChange={(e) => setObservationDetail(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Object observed"><input value={observedObject} onChange={(e) => setObservedObject(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field><Field label="Observed behavior"><input value={observedBehavior} onChange={(e) => setObservedBehavior(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Count"><input type="number" min="0" value={observedCount} onChange={(e) => setObservedCount(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field><Field label="Estimated altitude (ft AGL)"><input type="number" value={observedAltitude} onChange={(e) => setObservedAltitude(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field></div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Latitude (optional)"><input inputMode="decimal" value={obsLat} onChange={(e) => setObsLat(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field><Field label="Longitude (optional)"><input inputMode="decimal" value={obsLng} onChange={(e) => setObsLng(e.target.value)} className={inputClass} disabled={!permissions.canCreateObservation} /></Field></div>
              <button type="button" className={buttonClass} disabled={!permissions.canCreateObservation || !observationTitle.trim() || !observationDetail.trim()} onClick={addObservation}>File observation</button>
              {!permissions.canCreateObservation ? <ReadOnlyNotice role={role} text="This role does not have observation.create authority." /> : null}
            </div>
          </ModulePanel>
        ) : null}

        {module === "readiness" ? (
          <ModulePanel title="Resource registry and readiness" description="Agency-owned readiness information remains separate from incident commitment until an authorized role assigns it.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category"><select value={resourceCategory} onChange={(e) => { const next = e.target.value as ResourceCategory; setResourceCategory(next); setReadiness(CATEGORY_STATUSES[next][0] ?? "available"); }} className={inputClass} disabled={!permissions.canSetResourceStatus}>{RESOURCE_CATEGORIES.map((value) => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}</select></Field>
              <Field label="Resource name"><input value={resourceName} onChange={(e) => setResourceName(e.target.value)} className={inputClass} disabled={!permissions.canSetResourceStatus} /></Field>
              <Field label="Callsign"><input value={callsign} onChange={(e) => setCallsign(e.target.value)} className={inputClass} disabled={!permissions.canSetResourceStatus} /></Field>
              <Field label="Readiness"><select value={readiness} onChange={(e) => setReadiness(e.target.value as ReadinessStatus)} className={inputClass} disabled={!permissions.canSetResourceStatus}>{CATEGORY_STATUSES[resourceCategory].map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="Current / staging location (optional)"><input value={resourceLocation} onChange={(e) => setResourceLocation(e.target.value)} className={inputClass} disabled={!permissions.canSetResourceStatus} /></Field></div>
              <label className="sm:col-span-2 flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={commitResource} onChange={(e) => setCommitResource(e.target.checked)} disabled={!permissions.canAssignResource} />Commit this agency resource to the current exercise operation</label>
              <button type="button" className={`${buttonClass} sm:col-span-2`} disabled={!permissions.canSetResourceStatus || !resourceName.trim()} onClick={addResource}>Update readiness</button>
            </div>
            {!permissions.canSetResourceStatus ? <ReadOnlyNotice role={role} text="This role can see readiness but cannot change agency resource status." /> : null}
            {permissions.canSetResourceStatus && !permissions.canAssignResource ? <p className="mt-2 text-xs text-muted-foreground">This role may update readiness but cannot commit resources to an incident.</p> : null}
            <div className="mt-4 border-t border-border pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview agency resources</p><div className="mt-2 space-y-2">{ownedResources.map((row) => <div key={`${row.resourceName}-${row.callsign ?? ""}`} className="rounded-md border border-border p-2 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{row.resourceName}</span>{row.callsign ? <span className="font-mono text-xs text-muted-foreground">{row.callsign}</span> : null}<StatusPill tone={row.commitToOperation ? "active" : "info"}>{row.readinessStatus.replaceAll("_", " ")}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">{CATEGORY_LABELS[row.category as ResourceCategory] ?? row.category}{row.commitToOperation ? " · committed to operation" : " · agency readiness only"}</p></div>)}{!ownedResources.length ? <p className="text-xs text-muted-foreground">No exercise readiness records entered yet.</p> : null}</div></div>
          </ModulePanel>
        ) : null}

        {module === "cop" ? (
          <ModulePanel title="Common operating picture" description="The map is the same COP renderer used elsewhere in AIRS. Preview writes are exercise-only.">
            {permissions.canReadMap ? <><CopMap items={projection.mapItems} styleUrl={mapStyleUrl} attribution={mapAttribution} picking={canWriteCop} onPickPoint={canWriteCop ? setPicked : undefined} workingPoint={picked} className="h-[24rem] w-full overflow-hidden rounded-md border border-border" />
              {canWriteCop ? <div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Feature type"><select value={featureType} onChange={(e) => setFeatureType(e.target.value as MapFeatureType)} className={inputClass}>{MAP_FEATURE_TYPES.map((value) => <option key={value} value={value}>{MAP_FEATURE_LABELS[value]}</option>)}</select></Field><Field label="Label"><input value={featureLabel} onChange={(e) => setFeatureLabel(e.target.value)} className={inputClass} /></Field><div className="sm:col-span-2"><Field label="Operational detail"><textarea rows={2} value={featureDetail} onChange={(e) => setFeatureDetail(e.target.value)} className={inputClass} /></Field></div><div className="sm:col-span-2 flex flex-wrap items-center gap-2"><button type="button" className={buttonClass} disabled={!picked || !featureLabel.trim()} onClick={addMapReport}>Record COP report</button><span className="text-xs text-muted-foreground">{picked ? `${picked[1].toFixed(5)}, ${picked[0].toFixed(5)}` : "Click the map to select a working point."}</span></div></div> : <ReadOnlyNotice role={role} text="This role can view the COP but does not have a map-write permission." />}</> : <ReadOnlyNotice role={role} text="This role does not have map.read authority." />}
          </ModulePanel>
        ) : null}

        {module === "coordination" ? (
          <ModulePanel title="Organization coordination" description="Organizations are represented through information paths. This does not create workspace access or imply technical integration.">
            <div className="space-y-2">{projection.agencies.map((row) => <div key={row.id} className="rounded-md border border-border p-2 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{row.name}</span><StatusPill tone="info">{row.informationPath.replaceAll("_", " ")}</StatusPill><StatusPill tone={row.status === "active" ? "active" : "neutral"}>{row.status}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">{row.role}</p></div>)}{!projection.agencies.length ? <p className="text-sm text-muted-foreground">No organizations represented yet.</p> : null}</div>
            <div className="mt-4 border-t border-border pt-3"><div className="grid gap-3 sm:grid-cols-2"><Field label="Organization"><input value={coordinationName} onChange={(e) => setCoordinationName(e.target.value)} className={inputClass} disabled={!canCoordinate} /></Field><Field label="Information path"><select value={informationPath} onChange={(e) => setInformationPath(e.target.value as SimAgencyInformationPath)} className={inputClass} disabled={!canCoordinate}>{informationPaths.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></Field><div className="sm:col-span-2"><Field label="Operational role"><input value={coordinationRole} onChange={(e) => setCoordinationRole(e.target.value)} className={inputClass} disabled={!canCoordinate} /></Field></div><button type="button" className={`${buttonClass} sm:col-span-2`} disabled={!canCoordinate || !coordinationName.trim()} onClick={addCoordination}>Add coordination organization</button></div>{!canCoordinate ? <ReadOnlyNotice role={role} text="This role can view coordination but cannot update the incident roster." /> : null}</div>
          </ModulePanel>
        ) : null}
      </div>
    </section>
  );
}
export function AgencyPreviewEffect({ projection }: { projection: SimOperationalProjection }) {
  return <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
    <div className="shrink-0 border-b border-border bg-brand-navy px-3 py-2 text-white"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/70">AIRS effect</p><p className="mt-0.5 text-sm font-semibold">Common operational picture after agency input</p></div>
    <div className="grid shrink-0 gap-2 border-b border-border p-2 sm:grid-cols-2"><Metric label="State" value={projection.incidentStatus} /><Metric label="Priority" value={projection.priority} /><Metric label="Command" value={projection.commandLead} /><Metric label="Picture" value={`${projection.agencies.length} orgs · ${projection.resources.length} resources`} /></div>
    <div className="min-h-[14rem] flex-1 p-2"><CopMap items={projection.mapItems} styleUrl={mapStyleUrl} attribution={mapAttribution} className="h-full w-full overflow-hidden rounded-md border border-border" /></div>
    <div className="grid max-h-[15rem] shrink-0 gap-2 border-t border-border p-2 lg:grid-cols-3">
      <EffectList title="Organizations" rows={projection.agencies.slice(-5).reverse().map((row) => `${row.name} · ${row.informationPath.replaceAll("_", " ")}`)} />
      <EffectList title="Resources" rows={projection.resources.slice(-5).reverse().map((row) => `${row.name} · ${row.status.replaceAll("_", " ")}`)} />
      <EffectList title="Latest actions" rows={projection.actions.slice(-5).reverse().map((row) => `${formatClock(row.atSeconds)} · ${row.action}`)} />
    </div>
  </section>;
}

function EffectList({ title, rows }: { title: string; rows: string[] }) {
  return <div className="min-h-0 overflow-y-auto rounded-md border border-border p-2"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p><div className="mt-1 space-y-1">{rows.map((row) => <p key={row} className="text-xs text-foreground">{row}</p>)}{!rows.length ? <p className="text-xs text-muted-foreground">None yet.</p> : null}</div></div>;
}

function ModulePanel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="rounded-md border border-border bg-background/50"><div className="border-b border-border px-3 py-2"><h2 className="text-sm font-semibold text-foreground">{title}</h2><p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p></div><div className="p-3">{children}</div></section>;
}

function ReadOnlyNotice({ role, text }: { role: AgencyPreviewRole; text: string }) {
  return <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"><strong>{AGENCY_PREVIEW_ROLE_LABELS[role]}:</strong> {text}</p>;
}

function entryLabel(entry: SimWalkthroughEntry) {
  if (entry.kind === "command_update") return "Command update";
  if (entry.kind === "observation") return entry.title;
  if (entry.kind === "resource_status") return `Readiness · ${entry.resourceName}`;
  if (entry.kind === "resource_request") return `Request · ${entry.quantity} × ${entry.resourceName}`;
  if (entry.kind === "coordination") return `Coordination · ${entry.organizationName}`;
  return `COP · ${entry.label}`;
}

function OperationsView({ role, permissions, projection, entries }: {
  role: AgencyPreviewRole;
  permissions: ReturnType<typeof previewRoleSummary>;
  projection: SimOperationalProjection;
  entries: SimWalkthroughEntry[];
}) {
  const capabilities = [
    ["Incident update", permissions.canUpdateIncident],
    ["File observation", permissions.canCreateObservation],
    ["Create resource", permissions.canCreateResource],
    ["Resource status", permissions.canSetResourceStatus],
    ["Commit resource", permissions.canAssignResource],
    ["COP write", permissions.canReportPosition || permissions.canManageMapFeature],
  ] as const;
  return <div className="grid gap-3">
    <ModulePanel title="Agency operational view" description="This is the exercise tenant view for the selected real AIRS role.">
      <div className="grid gap-2 sm:grid-cols-2"><Metric label="Operation state" value={projection.incidentStatus} /><Metric label="Command" value={projection.commandLead} /><Metric label="Priority" value={projection.priority} /><Metric label="Picture" value={`${projection.agencies.length} orgs · ${projection.resources.length} operational resources`} /></div>
    </ModulePanel>
    <ModulePanel title="Role capability" description="Enabled from the production AIRS RBAC table, not a demo-specific permission list.">
      <div className="flex flex-wrap gap-2">{capabilities.map(([label, allowed]) => <StatusPill key={label} tone={allowed ? "active" : "neutral"}>{label} · {allowed ? "allowed" : "read only"}</StatusPill>)}</div>
      <p className="mt-2 text-xs text-muted-foreground">Active preview role: {AGENCY_PREVIEW_ROLE_LABELS[role]}.</p>
    </ModulePanel>
    <ModulePanel title="Recent agency input" description="What this exercise agency has actually entered at or before the current exercise clock.">
      <div className="space-y-2">{entries.map((entry) => <div key={entry.id} className="rounded-md border border-border px-3 py-2 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{formatClock(entry.atSeconds)}</span><StatusPill tone="info">agency entry</StatusPill></div><p className="mt-1 font-semibold text-foreground">{entryLabel(entry)}</p></div>)}{!entries.length ? <p className="text-sm text-muted-foreground">No agency-entered exercise information yet.</p> : null}</div>
    </ModulePanel>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border px-3 py-2"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold text-foreground">{value}</p></div>;
}
