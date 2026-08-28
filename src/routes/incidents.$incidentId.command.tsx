import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";

import { PageShell, StatusPill, type StatusTone } from "@/components/brand";
import { CopMap, type MapLayerItem } from "@/components/map/cop-map";
import { DENY_MESSAGES } from "@/components/incident-ui";
import { listObservationsFn } from "@/lib/api/awareness.functions";
import { readIncidentFn, listParticipantsFn } from "@/lib/api/incidents.functions";
import { readIcsBoardFn, saveIcsProfileFn, addIcsObjectiveFn, setIcsObjectiveStatusFn, addIcsPositionFn, setIcsPositionStatusFn, addIncidentResourceRequestFn, setIncidentResourceRequestStatusFn, addCoordinationPartnerFn, setCoordinationPartnerStateFn, addIncidentAuthorityFn, setIncidentAuthorityStatusFn, addThreatHypothesisFn, setThreatHypothesisStatusFn } from "@/lib/api/ics.functions";
import { LIFE_SAFETY_AUTHORITY_NOTE, suggestAuthorities, suggestThreatHypotheses, type AuthoritySuggestion, type ThreatHypothesisSuggestion } from "@/lib/authority/jurisdiction";
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
type AuthorityTypeValue = "jurisdictional" | "regulatory" | "functional" | "command" | "investigative" | "protective" | "delegated" | "supporting";
type ThreatTypeValue = "secondary_assault" | "follow_on_uas" | "responder_targeting" | "coordinated_attack" | "explosive_hazard" | "cbrne" | "other";
type ThreatConfidenceValue = "unknown" | "low" | "medium" | "high";
type OperationalCondition = "nominal" | "elevated" | "emergency" | "recovery";
type CoordinationConnectionMode = "airs" | "external_liaison" | "emergency_communications" | "radio" | "phone" | "email" | "other";
type CoordinationPartnerState = "planned" | "invited" | "confirmed" | "on_scene" | "active" | "released" | "cancelled";
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
  const addCoordinationPartner = useServerFn(addCoordinationPartnerFn);
  const coordinationPartnerState = useServerFn(setCoordinationPartnerStateFn);
  const addAuthority = useServerFn(addIncidentAuthorityFn);
  const authorityStatus = useServerFn(setIncidentAuthorityStatusFn);
  const addThreatHypothesis = useServerFn(addThreatHypothesisFn);
  const threatStatus = useServerFn(setThreatHypothesisStatusFn);
  const createFeature = useServerFn(createMapFeatureFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const [featureType, setFeatureType] = useState<MapFeatureType>("command_post");
  const [featureName, setFeatureName] = useState("");
  const [commandMode, setCommandMode] = useState("single");
  const [operationalCondition, setOperationalCondition] = useState<OperationalCondition>("nominal");
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
  const [partnerName, setPartnerName] = useState("");
  const [partnerRole, setPartnerRole] = useState("");
  const [partnerCommandRole, setPartnerCommandRole] = useState("");
  const [partnerConnection, setPartnerConnection] = useState<CoordinationConnectionMode>("external_liaison");
  const [partnerState, setPartnerState] = useState<CoordinationPartnerState>("planned");
  const [partnerContact, setPartnerContact] = useState("");
  const [partnerNotes, setPartnerNotes] = useState("");
  const [authorityDomain, setAuthorityDomain] = useState("");
  const [authorityHolder, setAuthorityHolder] = useState("");
  const [authorityType, setAuthorityType] = useState<AuthorityTypeValue>("functional");
  const [authorityScope, setAuthorityScope] = useState("");
  const [authorityLimitations, setAuthorityLimitations] = useState("");
  const [threatTitle, setThreatTitle] = useState("");
  const [threatType, setThreatType] = useState<ThreatTypeValue>("other");
  const [threatConfidence, setThreatConfidence] = useState<ThreatConfidenceValue>("unknown");
  const [threatRationale, setThreatRationale] = useState("");

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
    incidentId, commandMode, operationalCondition, incidentCommander: commander, commandPostName, operationalPeriodStart: periodStart ? new Date(periodStart).toISOString() : null,
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

  const coordinationPartnerM = useMutation({ mutationFn: () => addCoordinationPartner({ data: {
    incidentId, organizationName: partnerName, operationalRole: partnerRole, commandPostRole: partnerCommandRole,
    connectionMode: partnerConnection, participationState: partnerState, primaryContact: partnerContact, notes: partnerNotes,
  }}), onSuccess: (r) => { report(r, "Coordination partner added."); if (r.ok) { setPartnerName(""); setPartnerRole(""); setPartnerCommandRole(""); setPartnerContact(""); setPartnerNotes(""); refresh("incident-ics"); } } });
  const coordinationPartnerStateM = useMutation({ mutationFn: (input: { coordinationPartnerId: string; participationState: CoordinationPartnerState }) => coordinationPartnerState({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "Coordination partner status updated."); if (r.ok) refresh("incident-ics"); } });

  const confirmAuthorityM = useMutation({ mutationFn: (item: AuthoritySuggestion) => addAuthority({ data: {
    incidentId, domain: item.domain, authorityHolder: item.authorityHolder, authorityType: item.authorityType,
    geographicScope: item.geographicScope, functionalScope: item.functionalScope, basisType: item.basisType,
    basisReference: item.basisReference, sourceReference: item.sourceReference, limitations: item.limitations, confidence: item.confidence,
  }}), onSuccess: (r) => { report(r, "Authority record added."); if (r.ok) refresh("incident-ics"); } });
  const authorityStatusM = useMutation({ mutationFn: (input: { authorityId: string; status: "active" | "disputed" | "superseded" | "ended" }) => authorityStatus({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "Authority status updated."); if (r.ok) refresh("incident-ics"); } });
  const confirmThreatM = useMutation({ mutationFn: (item: ThreatHypothesisSuggestion) => addThreatHypothesis({ data: {
    incidentId, hypothesisType: item.hypothesisType, title: item.title, confidence: item.confidence, rationale: item.rationale,
    indicators: item.indicators, protectiveImplications: item.protectiveImplications, sourceBasis: item.sourceBasis,
  }}), onSuccess: (r) => { report(r, "Threat hypothesis added for command review."); if (r.ok) refresh("incident-ics"); } });
  const threatStatusM = useMutation({ mutationFn: (input: { hypothesisId: string; status: "open" | "supported" | "reduced" | "ruled_out" | "confirmed" }) => threatStatus({ data: { incidentId, ...input } }),
    onSuccess: (r) => { report(r, "Threat hypothesis status updated."); if (r.ok) refresh("incident-ics"); } });
  const manualAuthorityM = useMutation({ mutationFn: () => addAuthority({ data: {
    incidentId, domain: authorityDomain, authorityHolder, authorityType, geographicScope: authorityScope,
    functionalScope: authorityScope, basisType: "claimed" as const, limitations: authorityLimitations,
    confidence: "reported" as const, sourceReference: "Manual command-post entry",
  }}), onSuccess: (r) => { report(r, "Manual authority record added."); if (r.ok) { setAuthorityDomain(""); setAuthorityHolder(""); setAuthorityScope(""); setAuthorityLimitations(""); refresh("incident-ics"); } } });
  const manualThreatM = useMutation({ mutationFn: () => addThreatHypothesis({ data: {
    incidentId, hypothesisType: threatType, title: threatTitle, confidence: threatConfidence,
    rationale: threatRationale, protectiveImplications: "Command review required; maintain proportionate protective posture until assessed.",
    sourceBasis: "Manual command-post assessment",
  }}), onSuccess: (r) => { report(r, "Manual threat hypothesis added."); if (r.ok) { setThreatTitle(""); setThreatRationale(""); refresh("incident-ics"); } } });

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
  const coordinationRows = board?.coordinationPartners ?? [];
  const authorityRows = board?.authorities ?? [];
  const threatRows = board?.threatHypotheses ?? [];
  const loadedProfile = board?.profile ?? null;
  const inferenceText = useMemo(() => [
    roomData?.incident.description ?? "", loadedProfile?.situationSummary ?? "", loadedProfile?.safetyMessage ?? "",
    ...observationRows.map((o) => `${o.title} ${o.description ?? ""} ${o.observedBehavior ?? ""}`),
  ].join(" "), [roomData?.incident.description, loadedProfile?.situationSummary, loadedProfile?.safetyMessage, observationRows]);
  const authoritySuggestions = useMemo(() => suggestAuthorities(inferenceText).filter((item) =>
    !authorityRows.some((row) => row.domain === item.domain && row.status !== "ended")), [inferenceText, authorityRows]);
  const threatSuggestions = useMemo(() => suggestThreatHypotheses(inferenceText).filter((item) =>
    !threatRows.some((row) => row.hypothesisType === item.hypothesisType && row.status !== "ruled_out")), [inferenceText, threatRows]);

  useEffect(() => {
    if (!loadedProfile) return;
    setCommandMode(loadedProfile.commandMode);
    setOperationalCondition((loadedProfile.operationalCondition || "nominal") as OperationalCondition);
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
  const isPlannedOperation = roomData.incident.incidentType === "planned_event";
  const currentCondition = (profile?.operationalCondition || "nominal") as OperationalCondition;
  const operationLabel = isPlannedOperation
    ? roomData.incident.status === "draft" ? "PLANNING"
      : roomData.incident.status === "scheduled" ? "PRE-EVENT READY"
      : roomData.incident.status === "active" && currentCondition === "emergency" ? "EVENT + INCIDENT RESPONSE"
      : roomData.incident.status === "active" ? "EVENT OPERATIONS LIVE"
      : `PLANNED EVENT · ${label(roomData.incident.status).toUpperCase()}`
    : roomData.incident.status === "active" ? "LIVE INCIDENT" : label(roomData.incident.status).toUpperCase();
  const operationTone: StatusTone = currentCondition === "emergency" ? "critical" : currentCondition === "elevated" ? "caution" : currentCondition === "recovery" ? "info" : "active";

  return (
    <PageShell width="full" viewport>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <header className="flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-panel">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><StatusPill tone={operationTone}>{operationLabel}</StatusPill><StatusPill tone={operationTone}>CONDITION · {label(currentCondition).toUpperCase()}</StatusPill><StatusPill tone="neutral">MANUAL + AIRS DATA</StatusPill></div>
            <h1 className="mt-1 truncate text-lg font-semibold text-foreground">{roomData.incident.name}</h1>
          </div>
          <div className="text-right text-xs text-muted-foreground"><p>{label(roomData.incident.incidentType)} · {label(roomData.incident.status)}</p><p>{isOwner ? "Originating agency" : `Partner · ${label(roomData.relationship)}`}</p></div>
          <Link to="/incidents/$incidentId" params={{ incidentId }} className={smallButton}>Manage room</Link>
        </header>
        {notice ? <div className="shrink-0 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-foreground">{notice}</div> : null}
        {isPlannedOperation ? <div className="shrink-0 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-foreground"><strong>Preplanned operation:</strong> command structure, agencies, authorities, resources, zones, and assignments may be established before event day. Emergency escalation changes the operational condition; it does not reset the plan.</div> : null}

        <div className="grid shrink-0 gap-2 sm:grid-cols-2 xl:grid-cols-8">
          <Metric label="Command" value={profile?.commandMode === "unified" ? "Unified Command" : "Single Command"} />
          <Metric label="Incident Commander" value={profile?.incidentCommander || "Not entered"} />
          <Metric label="Operational period" value={profile?.operationalPeriodStart ? `${time(profile.operationalPeriodStart)}–${time(profile.operationalPeriodEnd)}` : "Not entered"} />
          <Metric label="Agencies" value={`${1 + participantRows.length + coordinationRows.filter((r) => !["released","cancelled"].includes(r.participationState)).length} in picture`} />
          <Metric label="Authorities" value={`${authorityRows.filter((r) => r.status === "active").length} active`} />
          <Metric label="Open hypotheses" value={`${threatRows.filter((r) => ["open","supported"].includes(r.status)).length}`} />
          <Metric label="Assigned resources" value={`${activeAssignments.length}`} />
          <Metric label="Open requests" value={`${activeRequests.length}`} />
        </div>

        <div className="min-h-0 flex-1 xl:grid xl:grid-cols-[minmax(300px,380px)_minmax(620px,1fr)_minmax(330px,430px)] xl:gap-2">
          <div className="grid min-h-0 grid-rows-[1.25fr_.75fr] gap-2">
            <Panel title="ICS Command" description={isPlannedOperation ? "Pre-event command, objectives, organization, and operational period remain live before an emergency occurs." : "Command, objectives, organization, and operational period."}>
              <div className="space-y-3 text-xs">
                <div><p className="font-semibold text-foreground">Situation</p><p className="mt-1 text-muted-foreground">{profile?.situationSummary || roomData.incident.description || "No situation summary entered."}</p></div>
                {profile?.safetyMessage ? <div className="rounded-md border border-warning/40 bg-warning/10 p-2"><p className="font-semibold">Safety message</p><p className="mt-1">{profile.safetyMessage}</p></div> : null}
                <div><p className="font-semibold text-foreground">Objectives</p><ol className="mt-1 space-y-1">{board?.objectives.map((o) => <li key={o.id} className="rounded-md border border-border p-2"><div className="flex gap-2"><span className="font-mono">{o.sequenceNo}.</span><span className="flex-1">{o.objective}</span><StatusPill tone={o.status === "active" ? "active" : "neutral"}>{o.status}</StatusPill></div>{isOwner && o.status === "active" ? <button className="mt-1 text-[11px] underline" onClick={() => objectiveStatusM.mutate({ objectiveId: o.id, status: "completed" })}>Mark complete</button> : null}</li>)}{!board?.objectives.length ? <li className="text-muted-foreground">No objectives entered.</li> : null}</ol></div>
                <div><p className="font-semibold text-foreground">ICS organization</p><div className="mt-1 space-y-1">{board?.positions.map((p) => <div key={p.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"><div className="min-w-0 flex-1"><p className="truncate font-medium">{p.label}</p><p className="truncate text-[11px] text-muted-foreground">{label(p.positionType)}{p.leaderName ? ` · ${p.leaderName}` : ""}{p.agencyName ? ` · ${p.agencyName}` : ""}</p></div><StatusPill tone={p.status === "active" ? "active" : "neutral"}>{p.status}</StatusPill>{isOwner && p.status === "active" ? <button className="text-[11px] underline" onClick={() => positionStatusM.mutate({ positionId: p.id, status: "completed" })}>close</button> : null}</div>)}{!board?.positions.length ? <p className="text-muted-foreground">No ICS positions entered.</p> : null}</div></div>

                {isOwner ? <DetailForm summary="Edit ICS command profile">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Command mode"><select className={inputClass} value={commandMode} onChange={(e) => setCommandMode(e.target.value)}><option value="single">Single Command</option><option value="unified">Unified Command</option></select></Field>
                    <Field label="Operational condition"><select className={inputClass} value={operationalCondition} onChange={(e) => setOperationalCondition(e.target.value as OperationalCondition)}><option value="nominal">Nominal</option><option value="elevated">Elevated</option><option value="emergency">Emergency</option><option value="recovery">Recovery</option></select></Field>
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

            <Panel title="Authority / Agency Coordination" description="Jurisdiction, functional authority, unresolved threat hypotheses, and participating agencies stay separate.">
              <div className="space-y-3 text-xs">
                <div className="rounded-md border border-warning/40 bg-warning/10 p-2"><p className="font-semibold">Life safety is an objective, not a jurisdiction</p><p className="mt-1 text-muted-foreground">{LIFE_SAFETY_AUTHORITY_NOTE}</p></div>
                <div><p className="font-semibold text-foreground">Authority matrix</p><div className="mt-1 space-y-1.5">{authorityRows.map((a) => <div key={a.id} className="rounded-md border border-border p-2"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="font-semibold">{a.domain}</p><p className="text-muted-foreground">{a.authorityHolder} · {label(a.authorityType)} · {label(a.basisType)}</p>{a.limitations ? <p className="mt-1 text-[11px] text-muted-foreground">Limit: {a.limitations}</p> : null}</div><StatusPill tone={a.status === "active" ? "active" : a.status === "disputed" ? "critical" : "neutral"}>{label(a.status)}</StatusPill></div>{isOwner && a.status === "active" ? <div className="mt-1 flex gap-2"><button className="text-[11px] underline" onClick={() => authorityStatusM.mutate({ authorityId: a.id, status: "disputed" })}>Dispute</button><button className="text-[11px] underline" onClick={() => authorityStatusM.mutate({ authorityId: a.id, status: "ended" })}>End</button></div> : null}</div>)}{authorityRows.length === 0 ? <p className="text-muted-foreground">No authority records have been confirmed for this incident.</p> : null}</div></div>
                {isOwner && authoritySuggestions.length ? <div><p className="font-semibold text-foreground">AIRS authority suggestions — review before recording</p><div className="mt-1 space-y-1.5">{authoritySuggestions.map((a) => <div key={a.key} className="rounded-md border border-primary/30 bg-primary/5 p-2"><p className="font-semibold">{a.domain}</p><p className="text-muted-foreground">{a.authorityHolder} · {a.reason}</p><button className={`${smallButton} mt-1`} onClick={() => confirmAuthorityM.mutate(a)}>Review + record</button></div>)}</div></div> : null}
                <div><p className="font-semibold text-foreground">Threat hypotheses</p><div className="mt-1 space-y-1.5">{threatRows.map((h) => <div key={h.id} className="rounded-md border border-border p-2"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="font-semibold">{h.title}</p><p className="text-muted-foreground">{label(h.hypothesisType)} · confidence {h.confidence}</p><p className="mt-1 text-[11px] text-muted-foreground">{h.rationale}</p></div><StatusPill tone={h.status === "confirmed" ? "critical" : h.status === "supported" ? "caution" : h.status === "open" ? "info" : "neutral"}>{label(h.status)}</StatusPill></div>{isOwner && !["ruled_out","confirmed"].includes(h.status) ? <div className="mt-1 flex gap-2"><button className="text-[11px] underline" onClick={() => threatStatusM.mutate({ hypothesisId: h.id, status: "supported" })}>Support</button><button className="text-[11px] underline" onClick={() => threatStatusM.mutate({ hypothesisId: h.id, status: "reduced" })}>Reduce</button><button className="text-[11px] underline" onClick={() => threatStatusM.mutate({ hypothesisId: h.id, status: "ruled_out" })}>Rule out</button></div> : null}</div>)}{threatRows.length === 0 ? <p className="text-muted-foreground">No command-reviewed threat hypotheses are open.</p> : null}</div></div>
                {isOwner && threatSuggestions.length ? <div><p className="font-semibold text-foreground">AIRS hypotheses — not facts</p><div className="mt-1 space-y-1.5">{threatSuggestions.map((h) => <div key={h.key} className="rounded-md border border-warning/40 bg-warning/5 p-2"><p className="font-semibold">{h.title}</p><p className="text-muted-foreground">{h.rationale}</p><button className={`${smallButton} mt-1`} onClick={() => confirmThreatM.mutate(h)}>Add for command review</button></div>)}</div></div> : null}
                {isOwner ? <DetailForm summary="Record authority manually"><div className="grid gap-2"><Field label="Domain"><input className={inputClass} value={authorityDomain} onChange={(e) => setAuthorityDomain(e.target.value)} /></Field><Field label="Authority holder"><input className={inputClass} value={authorityHolder} onChange={(e) => setAuthorityHolder(e.target.value)} /></Field><Field label="Type"><select className={inputClass} value={authorityType} onChange={(e) => setAuthorityType(e.target.value as AuthorityTypeValue)}>{["jurisdictional","regulatory","functional","command","investigative","protective","delegated","supporting"].map((v) => <option key={v}>{v}</option>)}</select></Field><Field label="Scope"><input className={inputClass} value={authorityScope} onChange={(e) => setAuthorityScope(e.target.value)} /></Field><Field label="Limitations"><textarea className={inputClass} rows={2} value={authorityLimitations} onChange={(e) => setAuthorityLimitations(e.target.value)} /></Field></div><button className={`${buttonClass} mt-2`} disabled={!authorityDomain.trim() || !authorityHolder.trim() || manualAuthorityM.isPending} onClick={() => manualAuthorityM.mutate()}>Record claimed authority</button></DetailForm> : null}
                {isOwner ? <DetailForm summary="Record threat hypothesis manually"><div className="grid gap-2"><Field label="Hypothesis"><input className={inputClass} value={threatTitle} onChange={(e) => setThreatTitle(e.target.value)} /></Field><Field label="Type"><select className={inputClass} value={threatType} onChange={(e) => setThreatType(e.target.value as ThreatTypeValue)}>{["secondary_assault","follow_on_uas","responder_targeting","coordinated_attack","explosive_hazard","cbrne","other"].map((v) => <option key={v}>{label(v)}</option>)}</select></Field><Field label="Confidence"><select className={inputClass} value={threatConfidence} onChange={(e) => setThreatConfidence(e.target.value as ThreatConfidenceValue)}>{["unknown","low","medium","high"].map((v) => <option key={v}>{v}</option>)}</select></Field><Field label="Rationale"><textarea className={inputClass} rows={2} value={threatRationale} onChange={(e) => setThreatRationale(e.target.value)} /></Field></div><button className={`${buttonClass} mt-2`} disabled={!threatTitle.trim() || manualThreatM.isPending} onClick={() => manualThreatM.mutate()}>Add hypothesis</button></DetailForm> : null}
                <div className="border-t border-border pt-2"><p className="font-semibold text-foreground">Planned / external coordination roster</p><p className="mt-1 text-[11px] text-muted-foreground">Roster presence is operational context only. It never grants AIRS access; platform authorization still comes only from accepted incident participation.</p><div className="mt-1 space-y-1.5">{coordinationRows.map((p) => <div key={p.id} className="rounded-md border border-border p-2"><div className="flex items-center justify-between gap-2"><p className="font-semibold">{p.organizationName}</p><StatusPill tone={["active","on_scene","confirmed"].includes(p.participationState) ? "active" : p.participationState === "cancelled" ? "critical" : "neutral"}>{label(p.participationState)}</StatusPill></div><p className="mt-1 text-muted-foreground">{p.operationalRole || "Coordination partner"}{p.commandPostRole ? ` · ${p.commandPostRole}` : ""} · {label(p.connectionMode)}</p>{p.primaryContact ? <p className="mt-1 text-[11px] text-muted-foreground">Contact: {p.primaryContact}</p> : null}{isOwner && !["released","cancelled"].includes(p.participationState) ? <div className="mt-1 flex gap-2"><button className="text-[11px] underline" onClick={() => coordinationPartnerStateM.mutate({ coordinationPartnerId: p.id, participationState: "confirmed" })}>Confirm</button><button className="text-[11px] underline" onClick={() => coordinationPartnerStateM.mutate({ coordinationPartnerId: p.id, participationState: "on_scene" })}>On scene</button><button className="text-[11px] underline" onClick={() => coordinationPartnerStateM.mutate({ coordinationPartnerId: p.id, participationState: "active" })}>Active</button></div> : null}</div>)}{coordinationRows.length === 0 ? <p className="text-muted-foreground">No preplanned or external coordination partners entered.</p> : null}</div></div>
                {isOwner ? <DetailForm summary="Add planned / external coordination partner"><div className="grid gap-2 sm:grid-cols-2"><Field label="Organization"><input className={inputClass} value={partnerName} onChange={(e) => setPartnerName(e.target.value)} /></Field><Field label="Operational role"><input className={inputClass} value={partnerRole} onChange={(e) => setPartnerRole(e.target.value)} placeholder="Maritime security, fire/rescue, dive, etc." /></Field><Field label="Command-post role"><input className={inputClass} value={partnerCommandRole} onChange={(e) => setPartnerCommandRole(e.target.value)} placeholder="Unified Command rep / liaison / branch" /></Field><Field label="Coordination path"><select className={inputClass} value={partnerConnection} onChange={(e) => setPartnerConnection(e.target.value as CoordinationConnectionMode)}>{["airs","external_liaison","emergency_communications","radio","phone","email","other"].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select></Field><Field label="Pre-event status"><select className={inputClass} value={partnerState} onChange={(e) => setPartnerState(e.target.value as CoordinationPartnerState)}>{["planned","invited","confirmed","on_scene","active"].map((v) => <option key={v} value={v}>{label(v)}</option>)}</select></Field><Field label="Primary contact"><input className={inputClass} value={partnerContact} onChange={(e) => setPartnerContact(e.target.value)} /></Field></div><Field label="Notes"><textarea className={`${inputClass} mt-2`} rows={2} value={partnerNotes} onChange={(e) => setPartnerNotes(e.target.value)} /></Field><button className={`${buttonClass} mt-2`} disabled={!partnerName.trim() || coordinationPartnerM.isPending} onClick={() => coordinationPartnerM.mutate()}>Add coordination partner</button></DetailForm> : null}
                <div className="border-t border-border pt-2"><p className="font-semibold text-foreground">AIRS-authorized agency participation</p><div className="mt-1 space-y-1.5"><div className="rounded-md border border-border p-2"><p className="font-semibold">{roomData.incident.orgName ?? "Originating agency"}</p><p className="text-muted-foreground">Originating organization · active</p></div>{participantRows.map((p) => <div key={p.id} className="rounded-md border border-border p-2"><div className="flex items-center justify-between gap-2"><p className="font-semibold">{p.partnerOrgName ?? p.partnerOrgId}</p><StatusPill tone={p.participationStatus === "active" ? "active" : "caution"}>{label(p.participationStatus)}</StatusPill></div><p className="mt-1 text-muted-foreground">{label(p.accessLevel)} · invitation {label(p.invitationStatus)}</p></div>)}{participantRows.length === 0 ? <p className="text-muted-foreground">No partner agency currently has AIRS incident access.</p> : null}</div></div>
              </div>
            </Panel>
          </div>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-panel">
            <div className="shrink-0 border-b border-border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold">Common Operating Picture</h2><p className="text-[11px] text-muted-foreground">{isPlannedOperation ? "Preplanned and live event geography share one COP. Planned zones/positions stay distinct from later observed or reported conditions." : "Live incident geography. Manual reports are labeled by source and retain normal AIRS precision rules."}</p></div><StatusPill tone="info">{mapItems.filter((i) => i.geometry).length} plotted</StatusPill></div>
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
            <Panel title="Resources / Assignments" description={isPlannedOperation ? "Preassigned and deployed event assets remain owned by their supplying agency and carry forward if conditions escalate." : "Committed assets retain ownership with their supplying agency."}>
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
              {[...coordinationRows.filter((p) => !["released","cancelled"].includes(p.participationState)).slice(0, 6).map((p) => `COORD · ${label(p.participationState)} · ${p.organizationName} · ${p.operationalRole || label(p.connectionMode)}`), ...threatRows.filter((h) => ["open","supported","confirmed"].includes(h.status)).slice(0, 4).map((h) => `THREAT · ${label(h.status)} · ${h.title}`), ...authorityRows.filter((a) => ["active","disputed"].includes(a.status)).slice(0, 4).map((a) => `AUTHORITY · ${label(a.status)} · ${a.domain} · ${a.authorityHolder}`), ...(board?.requests ?? []).slice(0, 6).map((r) => `${r.requestNumber} · ${label(r.status)} · ${r.quantity} ${label(r.resourceKind)}`), ...(board?.objectives ?? []).slice(0, 4).map((o) => `OBJ ${o.sequenceNo} · ${o.status} · ${o.objective}`), ...observationRows.slice(0, 6).map((o) => `OBS · ${label(o.verificationStatus)} · ${o.title}`)].map((item, index) => <span key={`${index}-${item}`} className="whitespace-nowrap border-r border-border/70 px-5 text-xs font-medium text-foreground">{item}</span>)}
              {(!board?.requests.length && !board?.objectives.length && observationRows.length === 0 && authorityRows.length === 0 && threatRows.length === 0) ? <span className="px-4 text-xs text-muted-foreground">Awaiting manually entered operational updates.</span> : null}
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
