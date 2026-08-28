import type { Geometry } from "@/lib/map/model";
import type { CompiledScenario } from "./model";

export type SimAgencyConnection = "airs_room" | "external_liaison" | "regional_mutual_aid";
export type SimAgencyStatus = "requested" | "invited" | "active" | "notified";

export interface SimAgency {
  id: string;
  name: string;
  role: string;
  connection: SimAgencyConnection;
  status: SimAgencyStatus;
  sinceSeconds: number;
  coordination: string;
}

export interface SimResource {
  id: string;
  name: string;
  owner: string;
  category: string;
  status: "on_scene" | "en_route" | "requested" | "active" | "unknown_location";
  sinceSeconds: number;
  location: string;
}

export interface SimMapItem {
  id: string;
  label: string;
  geometry?: Geometry;
  tone: "own" | "partner" | "area" | "position" | "muted";
  detail: string;
}
export interface SimCoordinationAction {
  id: string;
  atSeconds: number;
  actor: string;
  action: string;
  target: string;
  channel: "AIRS room" | "External liaison" | "Emergency communications" | "System";
  status: "completed" | "pending" | "active";
}

export interface SimOperationalProjection {
  incidentName: string;
  incidentStatus: string;
  commandLead: string;
  priority: string;
  agencies: SimAgency[];
  resources: SimResource[];
  mapItems: SimMapItem[];
  actions: SimCoordinationAction[];
}

const PORT: [number, number] = [-73.75611, 42.626389];
const RENSSELAER_APPROACH: [number, number] = [-73.7395, 42.6268];
const RAILYARD_APPROACH: [number, number] = [-73.7658, 42.6207];
const CORNING_PRESERVE: [number, number] = [-73.732007, 42.6656];
const RIVER_NEAR_PORT: [number, number] = [-73.7508, 42.6264];

const point = (coordinates: [number, number]): Geometry => ({ type: "Point", coordinates });
const line = (coordinates: [number, number][]): Geometry => ({ type: "LineString", coordinates });
const approximateBox = (center: [number, number], lngRadius: number, latRadius: number): Geometry => ({
  type: "Polygon",
  coordinates: [[
    [center[0] - lngRadius, center[1] - latRadius],
    [center[0] + lngRadius, center[1] - latRadius],
    [center[0] + lngRadius, center[1] + latRadius],
    [center[0] - lngRadius, center[1] + latRadius],
    [center[0] - lngRadius, center[1] - latRadius],
  ]],
});

function textThrough(scenario: CompiledScenario, clockSeconds: number) {
  return scenario.events
    .filter((event) => event.atSeconds <= clockSeconds)
    .map((event) => event.detail)
    .join(" ");
}

function agency(id: string, name: string, role: string, connection: SimAgencyConnection, status: SimAgencyStatus, sinceSeconds: number, coordination: string): SimAgency {
  return { id, name, role, connection, status, sinceSeconds, coordination };
}

function resource(id: string, name: string, owner: string, category: string, status: SimResource["status"], sinceSeconds: number, location: string): SimResource {
  return { id, name, owner, category, status, sinceSeconds, location };
}

function action(id: string, atSeconds: number, actor: string, actionText: string, target: string, channel: SimCoordinationAction["channel"], status: SimCoordinationAction["status"] = "completed"): SimCoordinationAction {
  return { id, atSeconds, actor, action: actionText, target, channel, status };
}
function buildAgencies(text: string): SimAgency[] {
  const rows: SimAgency[] = [];
  if (/Navy|ship/i.test(text)) rows.push(agency("navy", "U.S. Navy / Ship Command", "Shipboard force protection and damage control", "external_liaison", "active", 0, "On-scene ship command liaison; represented in AIRS without implying platform membership."));
  if (/Albany Fire Department|Albany FD/i.test(text)) rows.push(agency("afd", "Albany Fire Department", "Initial incident command, fire, rescue, MCI", "airs_room", "active", 8 * 60, "Simulated AIRS incident-room participant and initial command lead."));
  if (/Albany PD/i.test(text)) rows.push(agency("apd", "Albany Police Department", "Law enforcement, perimeter, investigations", "airs_room", "active", 8 * 60, "Simulated AIRS incident-room participant."));
  if (/Coast Guard|Captain of the Port/i.test(text)) rows.push(agency("uscg", "U.S. Coast Guard", "Waterway safety/security and marine traffic", "external_liaison", "active", 10 * 60, "External maritime liaison and interoperable communications; no AIRS membership assumed."));
  if (/Albany County Emergency Communications|Albany County 911/i.test(text)) rows.push(agency("acec", "Albany County 911 / Emergency Communications", "Dispatch and regional mutual aid coordination", "airs_room", "active", 6 * 60, "Simulated AIRS participant feeding incident and mutual-aid status."));
  if (/Rensselaer, Schenectady, and Saratoga counties/i.test(text)) rows.push(agency("regional-ems", "Regional EMS Mutual Aid", "Ambulance surge and patient movement", "regional_mutual_aid", "requested", 12 * 60, "Brought in through county mutual-aid/ECC channels; individual providers need not be AIRS members."));
  if (/Albany Medical Center|St\. Peter's Hospital|Samaritan Hospital/i.test(text)) rows.push(agency("hospitals", "Regional Receiving Hospitals", "Trauma and overflow receiving", "external_liaison", "notified", 12 * 60, "EMS council / hospital coordination represented as an external operational dependency."));
  if (/NCIS/i.test(text)) rows.push(agency("ncis", "NCIS", "Navy crime-scene and investigative authority", "external_liaison", "active", 15 * 60, "Federal investigative liaison; no AIRS membership assumed."));
  if (/FBI/i.test(text)) rows.push(agency("fbi", "FBI Albany Field Office / JTTF", "Federal criminal/terrorism investigation", "external_liaison", "notified", 15 * 60, "External federal liaison/request tracked in the incident room."));
  if (/FAA/i.test(text)) rows.push(agency("faa", "FAA", "National airspace restriction and UAS enforcement coordination", "external_liaison", "active", 18 * 60, "Airspace authority represented through external coordination and TFR status."));
  return rows;
}function addLaterAgencies(rows: SimAgency[], text: string) {
  if (/State Police aviation|NY State Police Troop G|State Police Bomb Disposal/i.test(text)) rows.push(agency("nysp", "New York State Police", "Aviation, patrol, bomb disposal, counter terrorism", "airs_room", /dispatched/i.test(text) ? "active" : "requested", 20 * 60, "Simulated AIRS partner request/participation; specialized assets remain separately tracked."));
  if (/DHSES|State Emergency Operations Center/i.test(text)) rows.push(agency("dh-ses", "NYS DHSES / State EOC", "State resource coordination", "external_liaison", "notified", 25 * 60, "State EOC liaison represented outside the AIRS participant roster unless separately invited."));
  if (/Albany County Sheriff/i.test(text)) rows.push(agency("acso", "Albany County Sheriff's Office", "Marine, patrol, county support", "airs_room", "active", 30 * 60, "Simulated AIRS incident-room participant."));
  if (/Albany County Emergency Management/i.test(text)) rows.push(agency("acem", "Albany County Emergency Management", "County EOC, mutual aid, consequence management", "airs_room", "active", 30 * 60, "Simulated AIRS incident-room participant and Unified Command/EOC bridge."));
  if (/DEC Police/i.test(text)) rows.push(agency("dec", "NYS DEC Police", "Environmental spill/waterway response", "external_liaison", "requested", 35 * 60, "External agency request tracked by liaison/status update."));
  if (/WMD Civil Support Team/i.test(text)) rows.push(agency("wmd-cst", "New York National Guard WMD Civil Support Team", "Technical CBRNE assessment", "external_liaison", "requested", 35 * 60, "External military support request tracked as a capability dependency."));
  if (/ATF/i.test(text)) rows.push(agency("atf", "ATF", "Explosives/post-blast support if confirmed", "external_liaison", "notified", 120 * 60, "Conditional external investigative coordination."));
  if (/Red Cross/i.test(text)) rows.push(agency("red-cross", "American Red Cross", "Family reunification and mass care", "external_liaison", "active", 120 * 60, "NGO coordination represented as an external partner function."));
  return rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index);
}

function buildResources(text: string): SimResource[] {
  const rows: SimResource[] = [];
  if (/USS Cohoes|Navy.*ship|ship/i.test(text)) rows.push(resource("uss-cohoes", "USS Cohoes", "U.S. Navy", "Vessel / protected asset", "on_scene", 0, "Port of Albany pier"));
  if (/small-boat security element|security boat/i.test(text)) rows.push(resource("navy-security-boat", "Ship security boat", "U.S. Navy", "Marine security", "on_scene", 0, "Hudson River safety zone"));
  if (/Albany Fire Department engine|First-due Albany Fire/i.test(text)) rows.push(resource("afd-engine", "First-due Albany Fire engine", "Albany Fire Department", "Fire apparatus", "on_scene", 8 * 60, "Initial command post / foot of pier"));
  if (/Albany PD patrol units/i.test(text)) rows.push(resource("apd-patrol", "Albany PD patrol units", "Albany Police Department", "Law enforcement units", "on_scene", 8 * 60, "Initial command post / port perimeter"));
  if (/Coast Guard small boats|Auxiliary vessels/i.test(text)) rows.push(resource("uscg-boats", "Coast Guard / Auxiliary small boats", "U.S. Coast Guard", "Marine response", "en_route", 10 * 60, "Exact position not reported"));
  if (/ambulances from Rensselaer, Schenectady, and Saratoga/i.test(text)) rows.push(resource("ems-mutual-aid", "Regional ambulance mutual aid", "Regional EMS", "EMS transport", "en_route", 12 * 60, "Multiple jurisdictions; exact unit positions not yet reported"));
  return rows;
}function addLaterResources(rows: SimResource[], text: string) {
  if (/counter-UAS detection element is requested|counter-UAS detection element are requested/i.test(text)) rows.push(resource("cuas-element", "Counter-UAS detection element", "Requested capability", "C-UAS detection", "requested", 20 * 60, "Deployment location not yet reported"));
  if (/State Police aviation/i.test(text)) rows.push(resource("nysp-aviation", "State Police Aviation", "New York State Police", "Manned aviation", "requested", 20 * 60, "Position not yet reported"));
  if (/medevac helicopter/i.test(text)) rows.push(resource("medevac", "Medevac aviation requirement", "EMS / receiving system", "Emergency aviation", "requested", 20 * 60, "Protected approach corridor required; exact aircraft position not reported"));
  if (/Bomb Disposal Unit/i.test(text)) rows.push(resource("nysp-bdu", "State Police Bomb Disposal Unit", "New York State Police", "EOD", "en_route", 25 * 60, "Exact unit position not reported"));
  if (/Counter Terrorism Unit/i.test(text)) rows.push(resource("nysp-ctu", "State Police Counter Terrorism Unit", "New York State Police", "Counter terrorism", "en_route", 25 * 60, "Exact unit position not reported"));
  if (/dive\/underwater recovery teams are requested/i.test(text)) rows.push(resource("dive-teams", "Dive / underwater recovery teams", "Albany Fire / State Police", "Water rescue/recovery", "requested", 35 * 60, "Hudson River incident area"));
  if (/WMD Civil Support Team is requested/i.test(text)) rows.push(resource("wmd-cst-team", "WMD Civil Support Team", "New York National Guard", "CBRNE assessment", "requested", 35 * 60, "Staging location not reported"));
  if (/press staging area goes up/i.test(text)) rows.push(resource("press-staging", "Press staging area / JIC", "Unified Command", "Public information", "active", 60 * 60, "Well back from operational zone; exact location not specified"));
  return rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index);
}

function buildMapItems(text: string): SimMapItem[] {
  const items: SimMapItem[] = [];
  if (/USS Cohoes|Navy.*ship|ship/i.test(text)) items.push({ id: "ship", label: "USS Cohoes — exercise position", geometry: point(PORT), tone: "partner", detail: "Fictional Navy vessel moored at the Port of Albany. Exercise geometry only." });
  if (/multiple small UAS inbound|dozen-plus quadcopters/i.test(text)) {
    items.push({ id: "uas-east-vector", label: "Reported UAS approach — Rensselaer side", geometry: line([RENSSELAER_APPROACH, PORT]), tone: "muted", detail: "Reported inbound vector; not a precision track." });
    items.push({ id: "uas-railyard-vector", label: "Reported UAS approach — rail-yard parcel", geometry: line([RAILYARD_APPROACH, PORT]), tone: "muted", detail: "Reported inbound vector from wooded rail-yard area; exercise approximation." });
  }
  if (/explosions and impacts|start a fire/i.test(text)) items.push({ id: "ship-fire", label: "Blast / fire hazard", geometry: point(PORT), tone: "position", detail: "Reported fire, blast, and structural/material damage near flight deck and pier-side brow." });
  if (/sightseeing cruise boat.*fire|cruise boat near its stern/i.test(text)) items.push({ id: "cruise-boat", label: "Damaged sightseeing vessel", geometry: point(RIVER_NEAR_PORT), tone: "position", detail: "Exercise approximation of the damaged civilian vessel near the incident area." });
  return items;
}function addLaterMapItems(items: SimMapItem[], text: string) {
  if (/some go down in the river|ordnance floating/i.test(text)) items.push({ id: "river-wreckage", label: "Unaccounted / downed UAS hazard area", geometry: approximateBox(RIVER_NEAR_PORT, 0.004, 0.003), tone: "area", detail: "Exercise hazard area for downed UAS/debris; not a surveyed boundary." });
  if (/establish an initial command post at the foot of the pier/i.test(text)) items.push({ id: "initial-cp", label: "Initial command post", geometry: point([-73.7572, 42.6272]), tone: "own", detail: "Albany Fire / Albany PD initial command post, exercise approximation." });
  if (/emergency safety\/security zone/i.test(text)) items.push({ id: "uscg-zone", label: "USCG emergency safety/security zone", geometry: approximateBox(PORT, 0.009, 0.008), tone: "area", detail: "Exercise visualization only; scenario does not provide the legal zone coordinates." });
  if (/Temporary Flight Restriction/i.test(text)) items.push({ id: "tfr", label: "FAA TFR active — geometry not authoritative", geometry: approximateBox(PORT, 0.03, 0.025), tone: "area", detail: "Exercise visualization only. AIRS must ingest the actual FAA TFR geometry in a live operation." });
  if (/Corning Preserve|riverfront park just north/i.test(text)) items.push({ id: "civilian-uas-launch", label: "Reported civilian UAS launch activity", geometry: point(CORNING_PRESERVE), tone: "position", detail: "Reported hobbyist/livestreamer launch activity near Corning Preserve/riverfront." });
  if (/Unified Command stands up at a staging area on port property/i.test(text)) items.push({ id: "unified-command", label: "Unified Command / staging", geometry: point([-73.7590, 42.6285]), tone: "own", detail: "Exercise approximation on port property; exact staging location was not specified." });
  if (/fuel sheen/i.test(text)) items.push({ id: "fuel-sheen", label: "Fuel sheen / environmental hazard", geometry: approximateBox(RIVER_NEAR_PORT, 0.003, 0.002), tone: "position", detail: "Exercise approximation of reported fuel sheen from damaged vessels." });
  return items;
}

function buildActions(text: string): SimCoordinationAction[] {
  const rows: SimCoordinationAction[] = [];
  if (/Albany County 911 is flooded with calls/i.test(text)) rows.push(action("room-create", 6 * 60, "Albany County 911 / command staff", "Spin up AIRS incident room from converging emergency calls", "Port of Albany multi-agency incident", "AIRS room"));
  if (/Albany Fire Department.*Albany PD patrol units arrive/i.test(text)) {
    rows.push(action("afd-lead", 8 * 60, "Initial command post", "Set initial life-safety command lead", "Albany Fire Department", "AIRS room"));
    rows.push(action("apd-add", 8 * 60, "Initial command post", "Add law-enforcement participant", "Albany Police Department", "AIRS room"));
  }
  if (/Coast Guard.*notified/i.test(text)) rows.push(action("uscg-liaison", 10 * 60, "Command post", "Open external maritime coordination", "U.S. Coast Guard / Captain of the Port", "External liaison"));
  if (/regional mutual-aid MCI plan/i.test(text)) rows.push(action("ems-request", 12 * 60, "Albany County Emergency Communications", "Send regional MCI resource requests", "Rensselaer, Schenectady, and Saratoga EMS", "Emergency communications"));
  if (/Albany Medical Center.*disaster alert/i.test(text)) rows.push(action("hospital-notify", 12 * 60, "EMS coordination", "Notify receiving hospitals and open surge plan", "Regional hospital system", "External liaison"));
  return rows;
}function addLaterActions(rows: SimCoordinationAction[], text: string) {
  if (/NCIS agents.*secure the ship/i.test(text)) rows.push(action("ncis-add", 15 * 60, "Command post", "Add federal investigative liaison", "NCIS", "External liaison"));
  if (/notify the FBI/i.test(text)) rows.push(action("fbi-notify", 15 * 60, "Albany PD / County", "Notify and request federal investigative response", "FBI Albany Field Office / JTTF", "External liaison"));
  if (/FAA issues an emergency Temporary Flight Restriction/i.test(text)) rows.push(action("tfr-layer", 18 * 60, "Airspace function", "Publish TFR status into common operating picture", "Incident airspace", "System"));
  if (/State Police aviation and a counter-UAS detection element are requested/i.test(text)) {
    rows.push(action("nysp-aviation-request", 20 * 60, "Incident air operations", "Request public safety aviation support", "New York State Police Aviation", "AIRS room", "pending"));
    rows.push(action("cuas-request", 20 * 60, "Incident air operations", "Request dedicated C-UAS detect/track/identify capability", "Counter-UAS detection element", "AIRS room", "pending"));
    rows.push(action("airspace-classification", 20 * 60, "AIRS", "Separate civilian, emergency, public safety, and unresolved threat aircraft", "Common operating picture", "System", "active"));
  }
  if (/NY State Police Troop G.*dispatched/i.test(text)) rows.push(action("nysp-add", 25 * 60, "Command post", "Add state police response and specialized assets", "New York State Police", "AIRS room"));
  if (/State Emergency Operations Center goes to alert/i.test(text)) rows.push(action("state-eoc", 25 * 60, "County / command", "Open State EOC coordination path", "NYS DHSES / State EOC", "External liaison"));
  if (/Unified Command stands up/i.test(text)) rows.push(action("uc-establish", 30 * 60, "Command post", "Establish Unified Command roster and authority matrix", "Navy, NCIS, Albany Fire, Albany PD, Sheriff, USCG, FBI, County EM", "AIRS room", "active"));
  if (/dive\/underwater recovery teams are requested/i.test(text)) rows.push(action("dive-request", 35 * 60, "Unified Command", "Request dive / underwater capability", "Albany Fire and State Police dive teams", "AIRS room", "pending"));
  if (/WMD Civil Support Team is requested/i.test(text)) rows.push(action("wmd-request", 35 * 60, "Unified Command", "Request technical CBRNE assessment", "New York National Guard WMD CST", "External liaison", "pending"));
  if (/Joint Information Center/i.test(text)) rows.push(action("jic", 60 * 60, "Unified Command", "Stand up Joint Information Center", "Navy PA, FBI, Albany PD, Coast Guard", "External liaison", "active"));
  if (/Red Cross open a family reunification center/i.test(text)) rows.push(action("red-cross", 120 * 60, "County Emergency Management", "Open family reunification / mass care coordination", "American Red Cross", "External liaison", "active"));
  return rows;
}export function buildOperationalProjection(scenario: CompiledScenario, clockSeconds: number): SimOperationalProjection {
  const text = textThrough(scenario, clockSeconds);
  const agencies = addLaterAgencies(buildAgencies(text), text);
  const resources = addLaterResources(buildResources(text), text);
  const mapItems = addLaterMapItems(buildMapItems(text), text);
  const actions = addLaterActions(buildActions(text), text).sort((a, b) => a.atSeconds - b.atSeconds);

  let incidentStatus = "Incoming report / not yet organized";
  let commandLead = "Not yet established";
  let priority = /multiple small UAS inbound|attached payloads/i.test(text)
    ? "Immediate airspace threat / life safety"
    : "Awaiting incident classification";
  if (/Albany County 911 is flooded with calls/i.test(text)) incidentStatus = "Incident room spinning up";
  if (/establish an initial command post/i.test(text)) {
    incidentStatus = "Active response / initial command";
    commandLead = "Initial command post established; rescue/EMS and hostile-threat/security functional leads remain distinct pending jurisdictional resolution";
  }
  if (/county-wide Mass Casualty Incident/i.test(text)) priority = "Mass casualty + active airspace threat";
  if (/Unified Command stands up/i.test(text)) {
    incidentStatus = "Active Unified Command";
    commandLead = "Unified Command; participating agencies retain their own jurisdictional and functional authority";
  }
  if (/scene shifts from rescue to recovery and investigation/i.test(text)) {
    incidentStatus = "Recovery / investigation transition";
    priority = "Evidence recovery, residual hazards, security, and consequence management";
  }

  return {
    incidentName: scenario.title,
    incidentStatus,
    commandLead,
    priority,
    agencies,
    resources,
    mapItems,
    actions,
  };
}