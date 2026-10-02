import { ResourceTasking } from "./resource-tasking";
import { readResourceOrdersFn } from "@/lib/api/resource-orders.functions";
import { FrameworkPanel } from "./framework-panel";
import { AidRequests } from "./aid-requests";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { readFrameworkFn } from "@/lib/api/framework.functions";
import { projectObservations } from "@/lib/operations/framework";
import { buildOperationalPicture } from "@/lib/operational/completeness";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { OperationalWorkspace } from "@/components/simulation/operational-workspace";
import {
  readIncidentFn,
  listParticipantsFn,
  readIncidentAuditFn,
} from "@/lib/api/incidents.functions";
import { getOrganization } from "@/lib/api/auth.functions";
import { readIcsBoardFn } from "@/lib/api/ics.functions";
import { listIncidentAssignmentsFn } from "@/lib/api/resources.functions";
import {
  listMapFeaturesFn,
  listOperatingAreasFn,
  listIncidentResourceLocationsFn,
} from "@/lib/api/map.functions";
import { listObservationsFn } from "@/lib/api/awareness.functions";
import type { WorkspaceProjection } from "@/lib/operations/workspace-model";
import { AgencyRelationships } from "./agency-relationships";

export function IncidentWorkspace({ incidentId }: { incidentId: string }) {
  const [live, setLive] = useState(true);
  const [toolPanel, setToolPanel] = useState<"aid" | "sources" | null>(null);
  const read = useServerFn(readIncidentFn),
    participants = useServerFn(listParticipantsFn),
    history = useServerFn(readIncidentAuditFn);
  const readIcs = useServerFn(readIcsBoardFn),
    listAssignments = useServerFn(listIncidentAssignmentsFn);
  const listFeatures = useServerFn(listMapFeaturesFn),
    listAreas = useServerFn(listOperatingAreasFn);
  const listLocations = useServerFn(listIncidentResourceLocationsFn),
    listObservations = useServerFn(listObservationsFn);
  const getOrg = useServerFn(getOrganization);
  const org = useQuery({ queryKey: ["org"], queryFn: () => getOrg({ data: {} }) });
  const orgId = org.data?.ok ? org.data.data.orgId : null;
  const scope = { incidentId, orgId };
  const polling = {
    enabled: Boolean(orgId),
    refetchInterval: live ? 3000 : (false as const),
    refetchIntervalInBackground: false,
  };
  const room = useQuery({
    ...polling,
    queryKey: ["workspace", "incident", orgId, incidentId],
    queryFn: () => read({ data: scope }),
  });
  const roster = useQuery({
    ...polling,
    queryKey: ["workspace", "incident-participants", orgId, incidentId],
    queryFn: () => participants({ data: scope }),
  });
  const audit = useQuery({
    ...polling,
    queryKey: ["workspace", "incident-audit", orgId, incidentId],
    queryFn: () => history({ data: scope }),
  });
  const ics = useQuery({
    ...polling,
    queryKey: ["workspace", "incident-ics", orgId, incidentId],
    queryFn: () => readIcs({ data: scope }),
  });
  const assignments = useQuery({
    ...polling,
    queryKey: ["workspace", "incident-assignments", orgId, incidentId],
    queryFn: () => listAssignments({ data: scope }),
  });
  const features = useQuery({
    ...polling,
    queryKey: ["workspace", "map-features", orgId, incidentId],
    queryFn: () => listFeatures({ data: scope }),
  });
  const areas = useQuery({
    ...polling,
    queryKey: ["workspace", "operating-areas", orgId, incidentId],
    queryFn: () => listAreas({ data: scope }),
  });
  const locations = useQuery({
    ...polling,
    queryKey: ["workspace", "incident-resource-locations", orgId, incidentId],
    queryFn: () => listLocations({ data: scope }),
  });
  const readOrders = useServerFn(readResourceOrdersFn);
  const orders = useQuery({
    ...polling,
    queryKey: ["resource-orders", incidentId, orgId],
    queryFn: () => readOrders({ data: { incidentId } }),
  });
  const readFramework = useServerFn(readFrameworkFn);
  const framework = useQuery({
    ...polling,
    queryKey: ["framework", orgId, incidentId],
    queryFn: () => readFramework({ data: { incidentId } }),
  });
  const observations = useQuery({
    ...polling,
    queryKey: ["workspace", "observations", orgId, incidentId],
    queryFn: () => listObservations({ data: { ...scope, limit: 100 } }),
  });
  if (org.isFetching || org.isPending) return <p role="status">Loading agency context…</p>;
  if (!org.data?.ok) return <p role="alert">Select an authorized agency to open this workspace.</p>;
  if (room.isPending) return <p role="status">Loading authorized incident workspace…</p>;
  if (!room.data?.ok)
    return (
      <p role="alert">
        This incident is unavailable to your active organization. Select an incident you can access.
      </p>
    );
  const incident = room.data.data.incident;
  const board = ics.data?.ok ? ics.data.data : null;
  const rosterRows = roster.data?.ok ? roster.data.data : [];
  const locationRows = locations.data?.ok ? locations.data.data : [];
  const mapItems: WorkspaceProjection["mapItems"] = [];
  for (const a of areas.data?.ok ? areas.data.data : [])
    if (a.geometry)
      mapItems.push({
        id: "area-" + a.id,
        label: a.name,
        geometry: a.geometry,
        tone: "area",
        detail: `${a.status} · ${a.altitudeFloorFt}–${a.altitudeCeilingFt} ft`,
      });
  for (const f of features.data?.ok ? features.data.data : [])
    if (f.geometry)
      mapItems.push({
        id: "feature-" + f.id,
        label: f.name,
        geometry: f.geometry,
        tone: f.relationship === "owner" ? "own" : "partner",
        detail: f.featureType,
      });
  for (const l of locationRows)
    if (l.geometry)
      mapItems.push({
        id: "location-" + l.id,
        label: l.resourceName,
        geometry: l.geometry,
        tone: "position",
        detail: `${l.freshness} · manually reported ${l.reportedAt}`,
      });
  for (const o of observations.data?.ok ? observations.data.data : [])
    if (o.geometry)
      mapItems.push({
        id: "observation-" + o.id,
        label: o.title,
        geometry: o.geometry,
        tone: "muted",
        detail: `${o.observationType} · ${o.verificationStatus}`,
      });
  const normalized = projectObservations(
    framework.data?.ok ? framework.data.data.observations : [],
    Date.now(),
  );
  for (const item of normalized)
    if (
      !(
        item.latest.dataClass === "resource_status" && item.latest.platform.startsWith("Anconison")
      ) &&
      item.latest.latitude !== null &&
      item.latest.longitude !== null
    )
      mapItems.push({
        id: "normalized-" + item.id,
        label: item.latest.label,
        geometry: { type: "Point", coordinates: [item.latest.longitude, item.latest.latitude] },
        tone: item.state === "known" ? "position" : "muted",
        detail:
          item.state +
          " · " +
          item.latest.originatingEntity +
          " · " +
          item.latest.platform +
          " · " +
          item.latest.sourceTimestamp,
      });
  const commandBoard = orders.data?.ok ? orders.data.data : null;
  for (const order of commandBoard?.orders ?? []) {
    const assignment = commandBoard?.assignments.find((a) => a.id === order.assignmentId);
    if (
      !assignment ||
      locationRows.some((l) => l.resourceId === assignment.resourceId && l.geometry)
    )
      continue;
    if (order.latitude !== null && order.longitude !== null)
      mapItems.push({
        id: `destination-${order.id}`,
        label: `${assignment.label || "Resource"} · assigned destination`,
        geometry: { type: "Point", coordinates: [order.longitude, order.latitude] },
        tone: "own",
        detail: `${order.destination} · ${order.mission} · ${order.status.replaceAll("_", " ")} · ${order.message || "Not a reported position"}`,
      });
  }
  const actions: WorkspaceProjection["actions"] = (audit.data?.ok ? audit.data.data : []).map(
    (a) => ({
      id: "audit-" + a.id,
      atSeconds: 0,
      occurredAt: a.occurredAt,
      actor: a.actorName || "Actor not disclosed",
      action: a.action.replaceAll(".", " · "),
      target: incident.name,
      channel: "Incident workspace",
      status: a.outcome,
    }),
  );
  for (const r of board?.requests ?? [])
    actions.push({
      id: "request-" + r.id,
      atSeconds: 0,
      occurredAt: r.updatedAt,
      actor: r.requestedBy || "Command",
      action: `${r.requestNumber}: ${r.description} (${r.quantity})`,
      target: r.requestedFrom || "Not specified",
      channel: "Incident workspace",
      status: r.status,
    });
  for (const order of commandBoard?.orders ?? [])
    actions.push({
      id: `order-${order.id}`,
      atSeconds: 0,
      occurredAt: order.reportedAt || order.createdAt,
      actor: order.status === "ordered" ? "Requesting agency command" : "Owning agency",
      action: order.mission,
      target: order.destination,
      channel: "Resource assignment",
      status: order.status,
    });
  actions.sort((a, b) => Date.parse(a.occurredAt!) - Date.parse(b.occurredAt!));
  const agencies: WorkspaceProjection["agencies"] = [
    {
      id: incident.orgId,
      name:
        incident.orgName || (incident.orgId === orgId ? org.data.data.name : "Originating agency"),
      role: "Command and Coordination",
      informationPath: "manual_entry",
      status: incident.status,
      sinceSeconds: 0,
      coordination: "Originating organization; incident workspace access",
    },
  ];
  for (const p of rosterRows)
    agencies.push({
      id: "participant-" + p.id,
      name: p.partnerOrgName || "Name not disclosed",
      role: `${p.accessLevel} · invitation ${p.invitationStatus}`,
      informationPath: "manual_entry",
      status: p.participationStatus,
      sinceSeconds: 0,
      coordination: "Incident workspace participation; no technical integration implied",
    });
  for (const p of board?.coordinationPartners ?? [])
    agencies.push({
      id: "coordination-" + p.id,
      name: p.organizationName,
      role: p.operationalRole,
      informationPath: p.informationPath,
      status: p.participationState,
      sinceSeconds: 0,
      coordination: p.notes || "Coordination roster only; workspace access is separate",
    });
  const pending = (board?.requests ?? []).filter(
    (r) => !["filled", "denied", "cancelled"].includes(r.status),
  );
  const projection: WorkspaceProjection = {
    incidentName: incident.name,
    incidentStatus: incident.status,
    commandLead:
      incident.orgName || (incident.orgId === orgId ? org.data.data.name : "Requesting agency"),
    priority: pending.some((r) => r.priority === "immediate")
      ? "Immediate"
      : pending.some((r) => r.priority === "high")
        ? "High"
        : pending.length
          ? "Routine"
          : "No open requests",
    agencies,
    mapItems,
    actions,
    resources: (assignments.data?.ok ? assignments.data.data : []).map((a) => {
      const l = locationRows.find((l) => a.resourceId && l.resourceId === a.resourceId);
      return {
        id: a.id,
        name: a.label || "Name not disclosed",
        owner: a.ownerOrgName || "Owner not disclosed",
        category: a.assignedRole || a.assignmentType,
        status: commandBoard?.orders.find((o) => o.assignmentId === a.id)?.status ?? a.status,
        sinceSeconds: 0,
        location: l?.geometry
          ? `Reported position · ${l.freshness}`
          : commandBoard?.orders.find((o) => o.assignmentId === a.id)?.destination
            ? `Assigned destination: ${commandBoard.orders.find((o) => o.assignmentId === a.id)!.destination}; current position unknown`
            : "Unknown or withheld position",
      };
    }),
  };
  projection.operationalPicture = buildOperationalPicture({
    ...projection,
    sourceText: [incident.description, ...normalized.map((o) => o.latest.summary)].join(" "),
  });
  projection.operationalPicture.gaps.push(...normalized.flatMap((o) => (o.gap ? [o.gap] : [])));
  if (framework.data?.ok && framework.data.data.observationsTruncated)
    projection.operationalPicture.gaps.push(
      "Observation view limited to 500 records; operational picture is incomplete.",
    );
  const queries = [
    room,
    roster,
    audit,
    ics,
    assignments,
    features,
    areas,
    locations,
    observations,
    framework,
    orders,
  ];
  const failed = queries.some((q) => q.isError || q.data?.ok === false);
  const loading = queries.some((q) => q.isPending);
  const checked = Math.min(...queries.map((q) => q.dataUpdatedAt));
  const exercise = incident.name.startsWith("EXERCISE");
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs">
        <button className="rounded border px-3 py-1.5 font-semibold" onClick={() => setLive(!live)}>
          {live ? "Pause updates" : "Resume updates"}
        </button>
        <span role="status">
          {failed
            ? "Some panels are unavailable or out of date. Access restrictions are still enforced."
            : loading
              ? "Loading panels…"
              : live
                ? "Updates every 3 seconds while visible"
                : "Updates paused"}
        </span>
        {checked > 0 && (
          <span>Last complete refresh: {new Date(checked).toLocaleTimeString()}</span>
        )}
        <a className="underline" href="/agency/systems">
          Agency relationships and directory
        </a>
        <a className="underline" href={`/incidents/${incidentId}`}>
          Manage room and assignments
        </a>
        <a className="underline" href={`/incidents/${incidentId}/command?edit=true`}>
          Command tools
        </a>
        <a className="underline" href={`/map?tools=true&incident=${incidentId}`}>
          Map tools
        </a>
        <Sheet
          modal={false}
          open={toolPanel === "aid"}
          onOpenChange={(open) => setToolPanel(open ? "aid" : null)}
        >
          <SheetTrigger asChild>
            <button className="rounded border border-primary px-3 py-1.5 font-semibold text-primary">
              Request aid / agency responses
            </button>
          </SheetTrigger>
          <SheetContent className="flex w-full flex-col gap-4 sm:w-[42rem] sm:max-w-[min(42rem,90vw)]">
            <SheetHeader className="shrink-0 pr-8">
              <SheetTitle>Request aid and agency responses</SheetTitle>
              <SheetDescription>
                Send requests and review agency replies alongside the incident picture.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
              <AidRequests incidentId={incidentId} />
            </div>
          </SheetContent>
        </Sheet>
        <Sheet
          modal={false}
          open={toolPanel === "sources"}
          onOpenChange={(open) => setToolPanel(open ? "sources" : null)}
        >
          <SheetTrigger asChild>
            <button className="rounded border px-3 py-1.5 font-semibold">Sources / sharing</button>
          </SheetTrigger>
          <SheetContent className="flex w-full flex-col gap-4 sm:w-[42rem] sm:max-w-[min(42rem,90vw)]">
            <SheetHeader className="shrink-0 pr-8">
              <SheetTitle>Incident sources and sharing</SheetTitle>
              <SheetDescription>
                Review observations, source access and sharing details.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
              <FrameworkPanel incidentId={incidentId} orgId={orgId!} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      {exercise && (
        <p className="shrink-0 rounded border border-amber-500 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-950">
          EXERCISE ONLY — simulated participants; no live emergency dispatch.
        </p>
      )}
      <div className="min-h-0 flex-1">
        <ResourceTasking
          incidentId={incidentId}
          board={commandBoard}
          locatedAssignmentIds={(commandBoard?.assignments ?? [])
            .filter((a) => locationRows.some((l) => l.resourceId === a.resourceId && l.geometry))
            .map((a) => a.id)}
        >
          {(mapControls) => (
            <OperationalWorkspace
              mapControls={mapControls}
              projection={projection}
              mode="production"
              exercise={exercise}
            />
          )}
        </ResourceTasking>
      </div>
    </div>
  );
}
