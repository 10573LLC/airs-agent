import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";

import { PageShell, StatusPill, type StatusTone } from "@/components/brand";
import { CopMap, type MapLayerItem } from "@/components/map/cop-map";
import { DENY_MESSAGES } from "@/components/incident-ui";
import { listObservationsFn } from "@/lib/api/awareness.functions";
import { readIncidentFn, listParticipantsFn } from "@/lib/api/incidents.functions";
import { readIcsBoardFn, saveIcsProfileFn, addIcsObjectiveFn, setIcsObjectiveStatusFn, addIcsPositionFn, setIcsPositionStatusFn, addIncidentResourceRequestFn, setIncidentResourceRequestStatusFn } from "@/lib/api/ics.functions";
import { createMapFeatureFn, listIncidentResourceLocationsFn, listMapFeaturesFn, listOperatingAreasFn } from "@/lib/api/map.functions";
import { listIncidentAssignmentsFn } from "@/lib/api/resources.functions";
import { MAP_FEATURE_LABELS, MAP_FEATURE_TYPES, type MapFeatureType } from "@/lib/map/model";

export const Route = createFileRoute("/incidents/$incidentId/command")({
  head: () => ({ meta: [{ title: "Incident command console — AIRS Agent" }] }),
  ssr: false,
  component: IncidentCommandConsole,
});

const mapStyleUrl = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || undefined;
const mapAttribution = (import.meta.env.VITE_MAP_ATTRIBUTION as string | undefined) || undefined;
const inputClass = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground";
const buttonClass = "rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40";
const smallButton = "rounded-md border border-border px-2 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-40";
type IcsPositionType = "incident_command" | "command_staff" | "operations" | "planning" | "logistics" | "finance_admin" | "branch" | "division" | "group" | "unit" | "staging_area" | "other";
type RequestKind = "personnel" | "law_enforcement" | "fire_ems" | "aviation" | "uas" | "counter_uas" | "communications" | "public_works" | "medical" | "logistics" | "specialty_team" | "other";
type RequestPriority = "immediate" | "high" | "routine";
const label = (value: string) => value.replaceAll("_", " ");
const requestTone = (status: string): StatusTone => status === "filled" ? "active" : status === "denied" || status === "cancelled" ? "critical" : status === "partially_filled" || status === "acknowledged" ? "info" : "caution";
const assignmentTone = (status: string): StatusTone => ["active","deployed"].includes(status) ? "active" : ["assigned","deploying"].includes(status) ? "info" : ["released","completed"].includes(status) ? "neutral" : "caution";
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
const localInputTime = (value: string | null | undefined) => { if (!value) return ""; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-card-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] font-medium text-muted-foreground">{text}<div className="mt-1">{children}</div></label>;
}

function DetailForm({ summary, children }: { summary: string; children: React.ReactNode }) {
  return <details className="mt-3 rounded-md border border-border bg-muted/20 p-2"><summary className="cursor-pointer text-xs font-semibold text-primary">{summary}</summary><div className="mt-3">{children}</div></details>;
}
function IncidentCommandConsole() {
  const { incidentId } = Route.useParams();
  const qc = useQueryClient();
  const readIncident = useServerFn(readIncidentFn);
  const listParticipants = useServerFn(listParticipantsFn);
  const readIcs = useServerFn(readIcsBoardFn);
  const listAssignments = useServerFn(listIncidentAssignmentsFn);
  const listFeatures = useServerFn(listMapFeaturesFn);
  const listAreas = useServerFn(listOperatingAreasFn);
  const listLocations = useServerFn(listIncidentResourceLocationsFn);
  const listObservations = useServerFn(listObservationsFn);
  const saveProfile = useServerFn(saveIcsProfileFn);
  const addObjective = useServerFn(addIcsObjectiveFn);
  const objectiveStatus = useServerFn(setIcsObjectiveStatusFn);
  const addPosition = useServerFn(addIcsPositionFn);
  const positionStatus = useServerFn(setIcsPositionStatusFn);
  const addRequest = useServerFn(addIncidentResourceRequestFn);
  const requestStatus = useServerFn(setIncidentResourceRequestStatusFn);
  const createFeature = useServerFn(createMapFeatureFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [featureType, setFeatureType] = useState<MapFeatureType>("command_post");
  const [featureName, setFeatureName] = useState("");
  const [commandMode, setCommandMode] = useState("single");
  const [commander, setCommander] = useState("");
  const [commandPostName, setCommandPostName] = useState("");
  const [situation, setSituation] = useState("");
  const [safety, setSafety] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [objectiveText, setObjectiveText] = useState("");
  const [objectiveSequence, setObjectiveSequence] = useState("1");
  const [positionType, setPositionType] = useState<IcsPositionType>("operations");
  const [positionLabel, setPositionLabel] = useState("");
  const [positionLeader, setPositionLeader] = useState("");
  const [positionAgency, setPositionAgency] = useState("");
  const [positionParent, setPositionParent] = useState("");
  const [requestKind, setRequestKind] = useState<RequestKind>("personnel");
  const [requestQuantity, setRequestQuantity] = useState("1");
  const [requestDescription, setRequestDescription] = useState("");
  const [requestFrom, setRequestFrom] = useState("");
  const [requestBy, setRequestBy] = useState("");
  const [requestPriority, setRequestPriority] = useState<RequestPriority>("routine");
  const [requestStaging, setRequestStaging] = useState("");

  const room = useQuery({ queryKey: ["incident", incidentId], queryFn: () => readIncident({ data: { incidentId } }) });
  const roster = useQuery({ queryKey: ["incident-participants", incidentId], queryFn: () => listParticipants({ data: { incidentId } }) });
  const ics = useQuery({ queryKey: ["incident-ics", incidentId], queryFn: () => readIcs({ data: { incidentId } }) });
  const assignments = useQuery({ queryKey: ["incident-assignments", incidentId], queryFn: () => listAssignments({ data: { incidentId } }) });
  const features = useQuery({ queryKey: ["map-features", incidentId], queryFn: () => listFeatures({ data: { incidentId } }) });
  const areas = useQuery({ queryKey: ["operating-areas", incidentId], queryFn: () => listAreas({ data: { incidentId } }) });
  const locations = useQuery({ queryKey: ["incident-resource-locations", incidentId], queryFn: () => listLocations({ data: { incidentId } }) });
  const observations = useQuery({ queryKey: ["observations", "command", incidentId], queryFn: () => listObservations({ data: { incidentId, limit: 100 } }) });

  const refresh = (...keys: string[]) => keys.forEach((key) => void qc.invalidateQueries({ queryKey: [key, incidentId] }));
  const report = (result: { ok: boolean; code?: string }, success: string) => setNotice(result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code ?? "unknown"}).`));
  const saveProfileM = useMutation({ mutationFn: () => saveProfile({ data: {
    incidentId, commandMode, incidentCommander: commander, commandPostName, operationalPeriodStart: periodStart ? new Date(periodStart).toISOString() : null,
    operationalPeriodEnd: periodEnd ? new Date(periodEnd).toISOString() : null, situationSummary: situation, safetyMessage: safety,
  }}), onSuccess: (r) => { report(r, "ICS command profile updated."); if (r.ok) refresh("incident-ics"); } });

  const objectiveM = useMutation({ mutationFn: () => addObjective({ data: {
    incidentId, sequenceNo: Number(objectiveSequence) || 1, objective: objectiveText,
    operationalPeriodLabel: ics.data?.ok && ics.data.data.profile?.operationalPeriodStart ? `OP ${time(ics.data.data.profile.operationalPeriodStart)}` : null,
  }}), onSuccess: (r) => { report(r, "Incident objective added."); if (r.ok) { setObjectiveText(""); refresh("incident-ics"); } } });

  const objectiveStatusM = useMutation({ mutationFn: (input: { objectiveId: string; status: "active" | "completed" | "cancelled" }) => objectiveStatus({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "Objective status updated."); if (r.ok) refresh("incident-ics"); } });

  const positionM = useMutation({ mutationFn: () => addPosition({ data: {
    incidentId, parentId: positionParent || null, positionType, label: positionLabel, leaderName: positionLeader, agencyName: positionAgency,
  }}), onSuccess: (r) => { report(r, "ICS position added."); if (r.ok) { setPositionLabel(""); setPositionLeader(""); setPositionAgency(""); refresh("incident-ics"); } } });

  const positionStatusM = useMutation({ mutationFn: (input: { positionId: string; status: "active" | "inactive" | "completed" }) => positionStatus({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "ICS position status updated."); if (r.ok) refresh("incident-ics"); } });
  const requestM = useMutation({ mutationFn: () => addRequest({ data: {
    incidentId, requestedBy: requestBy, requestedFrom: requestFrom, resourceKind: requestKind,
    quantity: Number(requestQuantity) || 1, description: requestDescription, priority: requestPriority, stagingLocation: requestStaging,
  }}), onSuccess: (r) => { report(r, "Resource request created."); if (r.ok) { setRequestDescription(""); refresh("incident-ics"); } } });

  const requestStatusM = useMutation({ mutationFn: (input: { requestId: string; status: "acknowledged" | "partially_filled" | "filled" | "denied" | "cancelled" }) => requestStatus({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "Resource request status updated."); if (r.ok) refresh("incident-ics"); } });

  const featureM = useMutation({ mutationFn: () => createFeature({ data: {
    incidentId, featureType, name: featureName, geometry: { type: "Point" as const, coordinates: picked as [number, number] }, precisionPolicy: "approximate" as const,
  }}), onSuccess: (r) => { report(r, `Placed ${featureName}.`); if (r.ok) { setFeatureName(""); setPicked(null); refresh("map-features"); } } });

  const roomData = room.data?.ok ? room.data.data : null;
  const board = ics.data?.ok ? ics.data.data : null;
  const isOwner = roomData?.relationship === "origin_admin";
  const participantRows = roster.data?.ok ? roster.data.data : [];
  const assignmentRows = assignments.data?.ok ? assignments.data.data : [];
  const featureRows = features.data?.ok ? features.data.data : [];
  const areaRows = areas.data?.ok ? areas.data.data : [];
  const locationRows = locations.data?.ok ? locations.data.data : [];
  const observationRows = observations.data?.ok ? observations.data.data : [];
  const loadedProfile = board?.profile ?? null;

  useEffect(() => {
    if (!loadedProfile) return;
    setCommandMode(loadedProfile.commandMode);
    setCommander(loadedProfile.incidentCommander);
    setCommandPostName(loadedProfile.commandPostName);
    setSituation(loadedProfile.situationSummary);
    setSafety(loadedProfile.safetyMessage);
    setPeriodStart(localInputTime(loadedProfile.operationalPeriodStart));
    setPeriodEnd(localInputTime(loadedProfile.operationalPeriodEnd));
  }, [loadedProfile?.version]);

  const mapItems = useMemo<MapLayerItem[]>(() => {
    const items: MapLayerItem[] = [];
    for (const row of areaRows) items.push({ id: `area-${row.id}`, label: row.name, geometry: row.geometry, tone: "area", detail: `${label(row.status)} · ${row.altitudeFloorFt}–${row.altitudeCeilingFt} ft` });
    for (const row of featureRows) items.push({ id: `feature-${row.id}`, label: row.name, geometry: row.geometry, tone: row.relationship === "owner" ? "own" : "partner", detail: MAP_FEATURE_LABELS[row.featureType] });
    for (const row of locationRows) if (row.geometry) items.push({ id: `location-${row.id}`, label: row.resourceName, geometry: row.geometry, tone: "position", detail: `${label(row.freshness)} · manually reported` });
    for (const row of observationRows) if (row.geometry) items.push({ id: `observation-${row.id}`, label: row.title, geometry: row.geometry, tone: "muted", detail: `${label(row.observationType)} · ${label(row.verificationStatus)}` });
    return items;
  }, [areaRows, featureRows, locationRows, observationRows]);

  if (room.isLoading) return <PageShell width="full"><p className="text-sm text-muted-foreground">Loading incident command console…</p></PageShell>;
  if (!roomData) return <PageShell width="narrow"><p className="text-sm text-destructive">This incident room is unavailable to your active agency context.</p><Link to="/incidents" className="mt-4 inline-block text-sm underline">Back to incident rooms</Link></PageShell>;

  const profile = loadedProfile;
  const activeRequests = board?.requests.filter((r) => !["filled","denied","cancelled"].includes(r.status)) ?? [];
  const activeAssignments = assignmentRows.filter((r) => !["released","completed","cancelled"].includes(r.status));

  return (
    <PageShell width="full" viewport>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <header className="flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-panel">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><StatusPill tone="active">LIVE INCIDENT</StatusPill><StatusPill tone="neutral">MANUAL + AIRS DATA</StatusPill></div>
            <h1 className="mt-1 truncate text-lg font-semibold text-foreground">{roomData.incident.name}</h1>
          </div>
          <div className="text-right text-xs text-muted-foreground"><p>{label(roomData.incident.incidentType)} · {label(roomData.incident.status)}</p><p>{isOwner ? "Originating agency" : `Partner · ${label(roomData.relationship)}`}</p></div>
          <Link to="/incidents/$incidentId" params={{ incidentId }} className={smallButton}>Manage room</Link>
        </header>
        {notice ? <div className="shrink-0 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-foreground">{notice}</div> : null}

        <div className="grid shrink-0 gap-2 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="Command" value={profile?.commandMode === "unified" ? "Unified Command" : "Single Command"} />
          <Metric label="Incident Commander" value={profile?.incidentCommander || "Not entered"} />
          <Metric label="Operational period" value={profile?.operationalPeriodStart ? `${time(profile.operationalPeriodStart)}–${time(profile.operationalPeriodEnd)}` : "Not entered"} />
          <Metric label="Agencies" value={`${1 + participantRows.length} in picture`} />
          <Metric label="Assigned resources" value={`${activeAssignments.length}`} />
          <Metric label="Open requests" value={`${activeRequests.length}`} />
        </div>

        <div className="min-h-0 flex-1 xl:grid xl:grid-cols-[minmax(300px,380px)_minmax(620px,1fr)_minmax(330px,430px)] xl:gap-2">
          <div className="grid min-h-0 grid-rows-[1.25fr_.75fr] gap-2">
            <Panel title="ICS Command" description="Command, objectives, organization, and operational period.">
              <div className="space-y-3 text-xs">
                <div><p className="font-semibold text-foreground">Situation</p><p className="mt-1 text-muted-foreground">{profile?.situationSummary || roomData.incident.description || "No situation summary entered."}</p></div>
                {profile?.safetyMessage ? <div className="rounded-md border border-warning/40 bg-warning/10 p-2"><p className="font-semibold">Safety message</p><p className="mt-1">{profile.safetyMessage}</p></div> : null}
                <div><p className="font-semibold text-foreground">Objectives</p><ol className="mt-1 space-y-1">{board?.objectives.map((o) => <li key={o.id} className="rounded-md border border-border p-2"><div className="flex gap-2"><span className="font-mono">{o.sequenceNo}.</span><span className="flex-1">{o.objective}</span><StatusPill tone={o.status === "active" ? "active" : "neutral"}>{o.status}</StatusPill></div>{isOwner && o.status === "active" ? <button className="mt-1 text-[11px] underline" onClick={() => objectiveStatusM.mutate({ objectiveId: o.id, status: "completed" })}>Mark complete</button> : null}</li>)}{!board?.objectives.length ? <li className="text-muted-foreground">No objectives entered.</li> : null}</ol></div>
                <div><p className="font-semibold text-foreground">ICS organization</p><div className="mt-1 space-y-1">{board?.positions.map((p) => <div key={p.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"><div className="min-w-0 flex-1"><p className="truncate font-medium">{p.label}</p><p className="truncate text-[11px] text-muted-foreground">{label(p.positionType)}{p.leaderName ? ` · ${p.leaderName}` : ""}{p.agencyName ? ` · ${p.agencyName}` : ""}</p></div><StatusPill tone={p.status === "active" ? "active" : "neutral"}>{p.status}</StatusPill>{isOwner && p.status === "active" ? <button className="text-[11px] underline" onClick={() => positionStatusM.mutate({ positionId: p.id, status: "completed" })}>close</button> : null}</div>)}{!board?.positions.length ? <p className="text-muted-foreground">No ICS positions entered.</p> : null}</div></div>

                {isOwner ? <DetailForm summary="Edit ICS command profile">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Command mode"><select className={inputClass} value={commandMode} onChange={(e) => setCommandMode(e.target.value)}><option value="single">Single Command</option><option value="unified">Unified Command</option></select></Field>
                    <Field label="Incident Commander / Unified Command lead"><input className={inputClass} value={commander} onChange={(e) => setCommander(e.target.value)} placeholder={profile?.incidentCommander || "Name / title"} /></Field>
                    <Field label="Command Post"><input className={inputClass} value={commandPostName} onChange={(e) => setCommandPostName(e.target.value)} placeholder={profile?.commandPostName || "ICP name / location"} /></Field>
                    <Field label="Operational period start"><input type="datetime-local" className={inputClass} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></Field>
                    <Field label="Operational period end"><input type="datetime-local" className={inputClass} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
                    <Field label="Situation summary"><textarea className={inputClass} rows={3} value={situation} onChange={(e) => setSituation(e.target.value)} placeholder={profile?.situationSummary || "Current situation"} /></Field>
                    <Field label="Safety message"><textarea className={inputClass} rows={3} value={safety} onChange={(e) => setSafety(e.target.value)} placeholder={profile?.safetyMessage || "Responder hazards / safety"} /></Field>
                  </div><button className={`${buttonClass} mt-2`} disabled={saveProfileM.isPending} onClick={() => saveProfileM.mutate()}>Save ICS profile</button>
                </DetailForm> : null}
                {isOwner ? <DetailForm summary="Add incident objective">
                  <div className="grid gap-2 grid-cols-[5rem_1fr]"><Field label="Order"><input className={inputClass} type="number" min="1" max="999" value={objectiveSequence} onChange={(e) => setObjectiveSequence(e.target.value)} /></Field><Field label="Objective"><input className={inputClass} value={objectiveText} onChange={(e) => setObjectiveText(e.target.value)} /></Field></div>
                  <button className={`${buttonClass} mt-2`} disabled={!objectiveText.trim() || objectiveM.isPending} onClick={() => objectiveM.mutate()}>Add objective</button>
                </DetailForm> : null}

                {isOwner ? <DetailForm summary="Add ICS position / element">
                  <div className="grid gap-2 sm:grid-cols-2"><Field label="Type"><select className={inputClass} value={positionType} onChange={(e) => setPositionType(e.target.value as IcsPositionType)}>{["incident_command","command_staff","operations","planning","logistics","finance_admin","branch","division","group","unit","staging_area","other"].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select></Field><Field label="Label"><input className={inputClass} value={positionLabel} onChange={(e) => setPositionLabel(e.target.value)} /></Field><Field label="Leader"><input className={inputClass} value={positionLeader} onChange={(e) => setPositionLeader(e.target.value)} /></Field><Field label="Agency"><input className={inputClass} value={positionAgency} onChange={(e) => setPositionAgency(e.target.value)} /></Field><Field label="Reports to"><select className={inputClass} value={positionParent} onChange={(e) => setPositionParent(e.target.value)}><option value="">Top level</option>{board?.positions.filter((p) => p.status === "active").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field></div>
                  <button className={`${buttonClass} mt-2`} disabled={!positionLabel.trim() || positionM.isPending} onClick={() => positionM.mutate()}>Add ICS element</button>
                </DetailForm> : null}
              </div>
            </Panel>

            <Panel title="Agency Coordination" description="AIRS participation is distinct from outside-agency coordination.">
              <div className="space-y-2 text-xs"><div className="rounded-md border border-border p-2"><p className="font-semibold">{roomData.incident.orgName ?? "Originating agency"}</p><p className="text-muted-foreground">Originating organization · active</p></div>{participantRows.map((p) => <div key={p.id} className="rounded-md border border-border p-2"><div className="flex items-center justify-between gap-2"><p className="font-semibold">{p.partnerOrgName ?? p.partnerOrgId}</p><StatusPill tone={p.participationStatus === "active" ? "active" : "caution"}>{label(p.participationStatus)}</StatusPill></div><p className="mt-1 text-muted-foreground">{label(p.accessLevel)} · invitation {label(p.invitationStatus)}</p></div>)}{participantRows.length === 0 ? <p className="text-muted-foreground">No AIRS partner agencies are active in this room yet. Outside agencies can still be represented manually in ICS positions and resource requests.</p> : null}</div>
            </Panel>
          </div>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
            <div className="shrink-0 border-b border-border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold">Common Operating Picture</h2><p className="text-[11px] text-muted-foreground">Live incident geography. Manual reports are labeled by source and retain normal AIRS precision rules.</p></div><StatusPill tone="info">{mapItems.filter((i) => i.geometry).length} plotted</StatusPill></div>
              {isOwner ? <div className="mt-2 grid items-end gap-2 grid-cols-[10rem_1fr_auto]">
                <Field label="Plot type"><select className={inputClass} value={featureType} onChange={(e) => setFeatureType(e.target.value as MapFeatureType)}>{MAP_FEATURE_TYPES.map((v) => <option key={v} value={v}>{MAP_FEATURE_LABELS[v]}</option>)}</select></Field>
                <Field label="Label"><input className={inputClass} value={featureName} onChange={(e) => setFeatureName(e.target.value)} placeholder="Click map, name the point, then plot" /></Field>
                <button className={buttonClass} disabled={!picked || !featureName.trim() || featureM.isPending} onClick={() => featureM.mutate()}>Plot point</button>
              </div> : null}
              {picked ? <p className="mt-1 font-mono text-[10px] text-muted-foreground">Working point {picked[1].toFixed(5)}, {picked[0].toFixed(5)} · not stored until Plot point</p> : null}
            </div>
            <div className="min-h-0 flex-1 p-2">
              <CopMap items={mapItems} styleUrl={mapStyleUrl} attribution={mapAttribution} onPickPoint={isOwner ? setPicked : undefined} picking={isOwner} workingPoint={picked} className="h-full w-full overflow-hidden rounded-md border border-border" />
            </div>
          </section>

          <div className="grid min-h-0 grid-rows-2 gap-2">
            <Panel title="Resources / Assignments" description="Committed assets retain ownership with their supplying agency.">
              <div className="space-y-2 text-xs">{activeAssignments.map((a) => <div key={a.id} className="rounded-md border border-border p-2"><div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate font-semibold">{a.label ?? "Restricted assignment"}</p><StatusPill tone={assignmentTone(a.status)}>{label(a.status)}</StatusPill></div><p className="mt-1 text-muted-foreground">{a.ownerOrgName ?? "Your agency"} · {label(a.assignmentType)}{a.assignedRole ? ` · ${a.assignedRole}` : ""}</p></div>)}{activeAssignments.length === 0 ? <p className="text-muted-foreground">No active resource or personnel assignments.</p> : null}</div>
              <Link to="/incidents/$incidentId" params={{ incidentId }} className={`${smallButton} mt-3 inline-block`}>Manage assignments</Link>
            </Panel>
            <Panel title="Resource Requests" description="ICS-style requests can target an AIRS participant or an outside agency by name.">
              <div className="space-y-2 text-xs">{board?.requests.map((r) => <div key={r.id} className="rounded-md border border-border p-2"><div className="flex items-center gap-2"><span className="font-mono text-[10px] text-muted-foreground">{r.requestNumber}</span><p className="min-w-0 flex-1 truncate font-semibold">{r.quantity} × {label(r.resourceKind)} — {r.description}</p><StatusPill tone={requestTone(r.status)}>{label(r.status)}</StatusPill></div><p className="mt-1 text-muted-foreground">From {r.requestedBy || "Command"} → {r.requestedFrom || "any available agency"}{r.stagingLocation ? ` · stage ${r.stagingLocation}` : ""}</p>{isOwner && ["requested","acknowledged","partially_filled"].includes(r.status) ? <div className="mt-2 flex gap-2"><button className={smallButton} onClick={() => requestStatusM.mutate({ requestId: r.id, status: "acknowledged" })}>Acknowledge</button><button className={smallButton} onClick={() => requestStatusM.mutate({ requestId: r.id, status: "partially_filled" })}>Partial</button><button className={smallButton} onClick={() => requestStatusM.mutate({ requestId: r.id, status: "filled" })}>Filled</button></div> : null}</div>)}{!board?.requests.length ? <p className="text-muted-foreground">No resource requests entered.</p> : null}</div>

              {isOwner ? <DetailForm summary="Create resource request">
                <div className="grid gap-2 sm:grid-cols-2"><Field label="Requested by"><input className={inputClass} value={requestBy} onChange={(e) => setRequestBy(e.target.value)} placeholder="Operations / branch / command" /></Field><Field label="Requested from"><input className={inputClass} value={requestFrom} onChange={(e) => setRequestFrom(e.target.value)} placeholder="Agency or any available" /></Field><Field label="Kind"><select className={inputClass} value={requestKind} onChange={(e) => setRequestKind(e.target.value as RequestKind)}>{["personnel","law_enforcement","fire_ems","aviation","uas","counter_uas","communications","public_works","medical","logistics","specialty_team","other"].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select></Field><Field label="Quantity"><input className={inputClass} type="number" min="1" max="9999" value={requestQuantity} onChange={(e) => setRequestQuantity(e.target.value)} /></Field><Field label="Priority"><select className={inputClass} value={requestPriority} onChange={(e) => setRequestPriority(e.target.value as RequestPriority)}><option value="immediate">Immediate</option><option value="high">High</option><option value="routine">Routine</option></select></Field><Field label="Staging"><input className={inputClass} value={requestStaging} onChange={(e) => setRequestStaging(e.target.value)} /></Field></div><Field label="Request"><textarea className={`${inputClass} mt-2`} rows={2} value={requestDescription} onChange={(e) => setRequestDescription(e.target.value)} /></Field><button className={`${buttonClass} mt-2`} disabled={!requestDescription.trim() || requestM.isPending} onClick={() => requestM.mutate()}>Issue request</button>
              </DetailForm> : null}
            </Panel>
          </div>
        </div>
        <div className="hidden h-9 shrink-0 overflow-hidden rounded-md border border-border bg-card shadow-panel xl:flex">
          <div className="flex w-32 shrink-0 items-center justify-center bg-brand-navy px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white">Operational feed</div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="simulation-ticker-track flex h-full min-w-max items-center">
              {[...(board?.requests ?? []).slice(0, 6).map((r) => `${r.requestNumber} · ${label(r.status)} · ${r.quantity} ${label(r.resourceKind)}`), ...(board?.objectives ?? []).slice(0, 4).map((o) => `OBJ ${o.sequenceNo} · ${o.status} · ${o.objective}`), ...observationRows.slice(0, 6).map((o) => `OBS · ${label(o.verificationStatus)} · ${o.title}`)].map((item, index) => <span key={`${index}-${item}`} className="whitespace-nowrap border-r border-border/70 px-5 text-xs font-medium text-foreground">{item}</span>)}
              {(!board?.requests.length && !board?.objectives.length && observationRows.length === 0) ? <span className="px-4 text-xs text-muted-foreground">Awaiting manually entered operational updates.</span> : null}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function Metric({ label: text, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-card px-3 py-2 shadow-panel"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{text}</p><p className="mt-1 truncate text-sm font-semibold text-foreground">{value}</p></div>;
}
