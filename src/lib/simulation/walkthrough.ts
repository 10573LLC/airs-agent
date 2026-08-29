import type { Geometry } from "@/lib/map/model";
import type { SimulationEvent, SimConfidence, SimSource } from "./model";
import type { SimAgencyInformationPath, SimOperationalProjection } from "./operational";

export type SimWalkthroughRole = "agency_admin" | "incident_command" | "dispatch_rtcc" | "airspace_operator";
export type SimWalkthroughEntryKind = "command_update" | "observation" | "resource_request" | "coordination" | "map_report";

export const WALKTHROUGH_ROLE_LABELS: Record<SimWalkthroughRole, string> = {
  agency_admin: "Agency Administrator",
  incident_command: "Incident Command / Supervisor",
  dispatch_rtcc: "Dispatch / RTCC",
  airspace_operator: "Airspace / UAS Operator",
};

interface WalkthroughBase {
  id: string;
  atSeconds: number;
  role: SimWalkthroughRole;
  kind: SimWalkthroughEntryKind;
}

export interface WalkthroughCommandUpdate extends WalkthroughBase {
  kind: "command_update";
  situation: string;
  commandLead?: string;
  priority?: string;
}
export interface WalkthroughObservation extends WalkthroughBase {
  kind: "observation";
  source: SimSource;
  title: string;
  detail: string;
  confidence: SimConfidence;
}

export interface WalkthroughResourceRequest extends WalkthroughBase {
  kind: "resource_request";
  resourceName: string;
  quantity: number;
  requestedFrom: string;
  location?: string;
}

export interface WalkthroughCoordination extends WalkthroughBase {
  kind: "coordination";
  organizationName: string;
  operationalRole: string;
  informationPath: SimAgencyInformationPath;
}

export interface WalkthroughMapReport extends WalkthroughBase {
  kind: "map_report";
  label: string;
  detail: string;
  latitude: number;
  longitude: number;
}

export type SimWalkthroughEntry = WalkthroughCommandUpdate | WalkthroughObservation | WalkthroughResourceRequest | WalkthroughCoordination | WalkthroughMapReport;
function entryHeadline(entry: SimWalkthroughEntry) {
  switch (entry.kind) {
    case "command_update": return "Agency command / situation update";
    case "observation": return entry.title;
    case "resource_request": return `Resource request: ${entry.quantity} × ${entry.resourceName}`;
    case "coordination": return `Coordination update: ${entry.organizationName}`;
    case "map_report": return `COP report: ${entry.label}`;
  }
}

function entryDetail(entry: SimWalkthroughEntry) {
  switch (entry.kind) {
    case "command_update": return [entry.situation, entry.commandLead ? `Command lead: ${entry.commandLead}.` : "", entry.priority ? `Priority: ${entry.priority}.` : ""].filter(Boolean).join(" ");
    case "observation": return entry.detail;
    case "resource_request": return `${entry.quantity} × ${entry.resourceName} requested from ${entry.requestedFrom || "any available organization"}. ${entry.location ? `Requested location/staging: ${entry.location}.` : "Location not reported."}`;
    case "coordination": return `${entry.organizationName} represented for ${entry.operationalRole || "operational coordination"} through ${entry.informationPath.replaceAll("_", " ")}.`;
    case "map_report": return `${entry.detail} Reported exercise position ${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}.`;
  }
}

function entryDomains(entry: SimWalkthroughEntry) {
  if (entry.kind === "resource_request") return ["resources", "command"];
  if (entry.kind === "coordination") return ["command", "coordination"];
  if (entry.kind === "map_report") return ["common operating picture"];
  if (entry.kind === "command_update") return ["command"];
  return ["agency report"];
}
export function walkthroughEvents(entries: readonly SimWalkthroughEntry[]): SimulationEvent[] {
  return entries.map((entry) => ({
    id: `agency-entry-${entry.id}`,
    atSeconds: entry.atSeconds,
    timeLabel: "Agency entry",
    source: entry.kind === "observation" ? entry.source : "Agency Entry",
    domains: entryDomains(entry),
    provenance: "agency_entry",
    confidence: entry.kind === "observation" ? entry.confidence : "reported",
    headline: entryHeadline(entry),
    detail: entryDetail(entry),
  }));
}

function point(longitude: number, latitude: number): Geometry {
  return { type: "Point", coordinates: [longitude, latitude] };
}

export function applyWalkthroughEntries(
  base: SimOperationalProjection,
  entries: readonly SimWalkthroughEntry[],
  clockSeconds: number,
): SimOperationalProjection {
  const visible = entries.filter((entry) => entry.atSeconds <= clockSeconds);
  if (!visible.length) return base;

  const projection: SimOperationalProjection = {
    ...base,
    agencies: [...base.agencies],
    resources: [...base.resources],
    mapItems: [...base.mapItems],
    actions: [...base.actions],
  };
  for (const entry of visible) {
    const actor = WALKTHROUGH_ROLE_LABELS[entry.role];
    if (entry.kind === "command_update") {
      projection.incidentStatus = "Agency-entered operational update received";
      if (entry.commandLead?.trim()) projection.commandLead = entry.commandLead.trim();
      if (entry.priority?.trim()) projection.priority = entry.priority.trim();
      projection.actions.push({ id: `walkthrough-${entry.id}`, atSeconds: entry.atSeconds, actor, action: "Record situation / command update", target: entry.situation, channel: "Incident workspace", status: "completed" });
    }
    if (entry.kind === "observation") {
      projection.actions.push({ id: `walkthrough-${entry.id}`, atSeconds: entry.atSeconds, actor, action: "Submit agency observation", target: entry.title, channel: "Incident workspace", status: "completed" });
    }
    if (entry.kind === "resource_request") {
      projection.resources.push({ id: `walkthrough-resource-${entry.id}`, name: `${entry.quantity} × ${entry.resourceName}`, owner: entry.requestedFrom || "Any available organization", category: "Agency-entered request", status: "requested", sinceSeconds: entry.atSeconds, location: entry.location?.trim() || "Location not reported" });
      projection.actions.push({ id: `walkthrough-${entry.id}`, atSeconds: entry.atSeconds, actor, action: "Issue resource request", target: `${entry.quantity} × ${entry.resourceName}`, channel: "Incident workspace", status: "pending" });
    }
    if (entry.kind === "coordination") {
      projection.agencies.push({ id: `walkthrough-agency-${entry.id}`, name: entry.organizationName, role: entry.operationalRole || "Operational coordination", informationPath: entry.informationPath, status: "active", sinceSeconds: entry.atSeconds, coordination: "Agency-entered exercise coordination record. Workspace access and technical integration remain separate." });
      projection.actions.push({ id: `walkthrough-${entry.id}`, atSeconds: entry.atSeconds, actor, action: "Add coordination organization", target: entry.organizationName, channel: "Incident workspace", status: "completed" });
    }
    if (entry.kind === "map_report") {
      projection.mapItems.push({ id: `walkthrough-map-${entry.id}`, label: entry.label, geometry: point(entry.longitude, entry.latitude), tone: "position", detail: `${entry.detail} Agency-entered exercise position.` });
      projection.actions.push({ id: `walkthrough-${entry.id}`, atSeconds: entry.atSeconds, actor, action: "Add reported COP position", target: entry.label, channel: "Incident workspace", status: "completed" });
    }
  }
  projection.agencies = projection.agencies.filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index);
  projection.resources = projection.resources.filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index);
  projection.mapItems = projection.mapItems.filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index);
  projection.actions = projection.actions
    .filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  return projection;
}
