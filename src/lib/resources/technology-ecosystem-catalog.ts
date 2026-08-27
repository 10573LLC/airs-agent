// AIRS Agency Systems & Integrations — technology ecosystem catalog (foundation).
//
// Pure, deterministic, vendor-neutral domain module: no I/O, no routes, no
// persistence, no connectors, no credentials, no network calls.
//
// Concepts kept deliberately distinct:
//
//  1. Catalog knowledge   — which vendor ecosystems exist and which components
//                           they offer, normalized into AIRS capability keys.
//                           Every ecosystem is modeled as an independent vendor;
//                           the catalog never implies that one vendor owns
//                           another vendor's products.
//  2. Advisory suggestions — selecting ecosystems yields SUGGESTIONS only.
//                           A suggestion is explicitly advisory and never
//                           becomes a confirmed installation on its own.
//  3. Confirmed components — the agency explicitly confirms what it actually
//                           uses. Confirmation creates a record whose default
//                           integration state is NOT connected, NOT authorized,
//                           NOT credentialed and NOT data-access-capable.
//
// Default deny everywhere: unknown ecosystem or component IDs are ignored and
// never widen capabilities, suggestions, or access.

// ---------------------------------------------------------------------------
// Normalized AIRS capability vocabulary (vendor-neutral keys)
// ---------------------------------------------------------------------------

export const AIRS_CAPABILITIES = [
  "cad_incident_feed",
  "unit_locations",
  "uas_telemetry",
  "aircraft_location",
  "dock_status",
  "live_video",
  "sensor_detections",
  "remote_id",
  "adsb",
  "evidence",
  "dispatch_status",
  "personnel_availability",
  "alerts_events",
  "airspace_awareness",
  "counter_uas_detection",
  "counter_uas_tracking",
  "counter_uas_identification",
  "counter_uas_mitigation",
  "rtcc_video_aggregation",
  "program_management",
  "mapping_photogrammetry",
  "lpr",
  "gunshot_detection",
  "medical_delivery",
] as const;

export type AirsCapability = (typeof AIRS_CAPABILITIES)[number];

export function isAirsCapability(value: unknown): value is AirsCapability {
  return typeof value === "string" && (AIRS_CAPABILITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Integration-state vocabulary (compatible dimensions, not one exclusive enum)
// ---------------------------------------------------------------------------
//
// The agency vocabulary — "in use", "connected to AIRS", "available but not
// connected", "read only integration", "bidirectional integration",
// "manual only", "planned" — mixes three compatible dimensions. Modeling them
// separately means "in use" + "available but not connected" + "manual only"
// can coexist, which is exactly the safe default.

export const USAGE_STATUSES = ["in_use", "planned"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export const CONNECTION_STATUSES = ["connected_to_airs", "available_not_connected"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const INTEGRATION_MODES = ["read_only", "bidirectional", "manual_only"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export interface IntegrationState {
  usage: UsageStatus;
  connection: ConnectionStatus;
  mode: IntegrationMode;
  /** Explicit connector authorization. Never granted by catalog helpers. */
  authorized: boolean;
  /** Credentials on file for a live connector. Never granted here. */
  credentialed: boolean;
  /** Whether AIRS may actually read data from this component. Never granted here. */
  dataAccessCapable: boolean;
}

/**
 * The only integration state this module ever produces: in use for planning
 * purposes, but explicitly NOT connected, NOT authorized, NOT credentialed,
 * and NOT capable of data access. Connecting a component is a separate,
 * explicit server-side flow that does not exist in this module.
 */
export function createDefaultIntegrationState(): IntegrationState {
  return {
    usage: "in_use",
    connection: "available_not_connected",
    mode: "manual_only",
    authorized: false,
    credentialed: false,
    dataAccessCapable: false,
  };
}

// ---------------------------------------------------------------------------
// Catalog data — independent vendor ecosystems and their components
// ---------------------------------------------------------------------------

export interface CatalogComponent {
  id: string;
  /** The vendor ecosystem this component actually belongs to. */
  ecosystemId: EcosystemId;
  /** Human-readable component name. */
  name: string;
  /** Recognizable product family or acquired brand retained for agency matching. */
  productFamily?: string;
  /** Legacy/current names an agency may use for this component. */
  aliases?: readonly string[];
  /** Normalized AIRS capabilities this component can provide (if ever connected). */
  capabilities: readonly AirsCapability[];
}

export const ECOSYSTEM_IDS = [
  "axon",
  "motorola_solutions",
  "flock_safety",
  "dronesense",
  "skydio",
  "dji",
  "pulsiam",
  "brinc",
  "skysafe",
  "autel",
  "parrot",
  "teal_red_cat",
  "versaterm",
  "sifly",
  "skyfireai",
  "paladin",
  "ondas",
  "easy_aerial",
  "droneshield",
  "draganfly",
] as const;

export type EcosystemId = (typeof ECOSYSTEM_IDS)[number];

export function isEcosystemId(value: unknown): value is EcosystemId {
  return typeof value === "string" && (ECOSYSTEM_IDS as readonly string[]).includes(value);
}

export interface Ecosystem {
  id: EcosystemId;
  vendorName: string;
}

/** Each ecosystem is an independent vendor. No ownership relationships are modeled. */
export const ECOSYSTEMS: readonly Ecosystem[] = [
  { id: "axon", vendorName: "Axon" },
  { id: "motorola_solutions", vendorName: "Motorola Solutions" },
  { id: "flock_safety", vendorName: "Flock Safety" },
  { id: "dronesense", vendorName: "DroneSense" },
  { id: "skydio", vendorName: "Skydio" },
  { id: "dji", vendorName: "DJI" },
  { id: "pulsiam", vendorName: "Pulsiam" },
  { id: "brinc", vendorName: "BRINC" },
  { id: "skysafe", vendorName: "SkySafe" },
  { id: "autel", vendorName: "Autel Robotics" },
  { id: "parrot", vendorName: "Parrot" },
  { id: "teal_red_cat", vendorName: "Teal Drones / Red Cat" },
  { id: "versaterm", vendorName: "Versaterm" },
  { id: "sifly", vendorName: "SiFly" },
  { id: "skyfireai", vendorName: "SkyfireAI" },
  { id: "paladin", vendorName: "Paladin" },
  { id: "ondas", vendorName: "Ondas / Airobotics" },
  { id: "easy_aerial", vendorName: "Easy Aerial" },
  { id: "droneshield", vendorName: "DroneShield" },
  { id: "draganfly", vendorName: "Draganfly" },
];

export const CATALOG_COMPONENTS: readonly CatalogComponent[] = [
  // Axon
  {
    id: "axon_digital_evidence",
    ecosystemId: "axon",
    name: "Digital evidence management",
    capabilities: ["evidence"],
  },
  {
    id: "axon_body_worn_camera",
    ecosystemId: "axon",
    name: "Body-worn camera",
    capabilities: ["live_video", "evidence"],
  },
  {
    id: "axon_air",
    ecosystemId: "axon",
    name: "Axon Air",
    productFamily: "Axon Air",
    capabilities: ["program_management", "uas_telemetry", "aircraft_location", "live_video"],
  },
  {
    id: "axon_respond",
    ecosystemId: "axon",
    name: "Axon Respond",
    productFamily: "Axon Respond",
    capabilities: ["live_video", "rtcc_video_aggregation", "alerts_events"],
  },
  {
    id: "axon_prepared_911",
    ecosystemId: "axon",
    name: "Prepared by Axon",
    productFamily: "Prepared",
    aliases: ["Prepared 911", "Prepare 911"],
    capabilities: ["cad_incident_feed", "live_video", "alerts_events"],
  },
  {
    id: "axon_carbyne_911",
    ecosystemId: "axon",
    name: "Carbyne 911",
    productFamily: "Carbyne",
    aliases: ["Carbyne", "Carbide"],
    capabilities: ["cad_incident_feed", "live_video", "alerts_events"],
  },
  {
    id: "axon_dedrone_airspace_security",
    ecosystemId: "axon",
    name: "Dedrone by Axon",
    productFamily: "Dedrone",
    aliases: ["Dedrone", "DedroneTracker", "DedroneBeyond"],
    capabilities: ["airspace_awareness", "counter_uas_detection", "counter_uas_tracking", "counter_uas_identification", "sensor_detections", "remote_id", "alerts_events"],
  },
  // Fusus
  {
    id: "axon_fusus_real_time_operations",
    ecosystemId: "axon",
    name: "Axon Fusus real-time operations platform",
    productFamily: "Fusus",
    aliases: ["Fusus", "Axon Fusus"],
    capabilities: ["live_video", "sensor_detections", "alerts_events", "rtcc_video_aggregation"],
  },
  {
    id: "axon_fusus_camera_registry",
    ecosystemId: "axon",
    name: "Axon Fusus community camera registry",
    productFamily: "Fusus",
    aliases: ["Fusus camera registry"],
    capabilities: ["live_video", "rtcc_video_aggregation"],
  },
  // Motorola Solutions
  {
    id: "motorola_cad",
    ecosystemId: "motorola_solutions",
    name: "Computer-aided dispatch",
    capabilities: [
      "cad_incident_feed",
      "unit_locations",
      "dispatch_status",
      "personnel_availability",
      "alerts_events",
    ],
  },
  {
    id: "motorola_land_mobile_radio",
    ecosystemId: "motorola_solutions",
    name: "Land mobile radio system",
    capabilities: ["unit_locations", "alerts_events"],
  },
  {
    id: "motorola_commandcentral",
    ecosystemId: "motorola_solutions",
    name: "CommandCentral",
    productFamily: "CommandCentral",
    capabilities: ["cad_incident_feed", "unit_locations", "live_video", "rtcc_video_aggregation", "lpr", "dispatch_status", "alerts_events"],
  },
  {
    id: "motorola_cape",
    ecosystemId: "motorola_solutions",
    name: "CAPE Aerial Telepresence",
    productFamily: "CAPE",
    aliases: ["Cape Productions", "CAPE"],
    capabilities: ["program_management", "uas_telemetry", "aircraft_location", "live_video"],
  },
  {
    id: "motorola_dfend_enforceair",
    ecosystemId: "motorola_solutions",
    name: "D-Fend EnforceAir",
    productFamily: "D-Fend Solutions",
    aliases: ["D-Fend", "D-Fend Solutions", "EnforceAir", "Defend"],
    capabilities: ["airspace_awareness", "counter_uas_detection", "counter_uas_tracking", "counter_uas_identification", "counter_uas_mitigation", "alerts_events"],
  },
  // Flock Safety
  {
    id: "flock_alpha", ecosystemId: "flock_safety", name: "Flock Alpha drone",
    productFamily: "Flock DFR", aliases: ["Alpha"],
    capabilities: ["uas_telemetry", "aircraft_location", "live_video", "lpr"],
  },
  {
    id: "flock_dfr", ecosystemId: "flock_safety", name: "Flock DFR",
    productFamily: "Flock DFR", aliases: ["Aerodome"],
    capabilities: ["program_management", "uas_telemetry", "aircraft_location", "live_video", "alerts_events"],
  },
  {
    id: "flock_falcon_lpr", ecosystemId: "flock_safety", name: "Flock Falcon LPR",
    productFamily: "Falcon", capabilities: ["lpr", "sensor_detections", "alerts_events"],
  },
  {
    id: "flock_raven", ecosystemId: "flock_safety", name: "Flock Raven gunshot detection",
    productFamily: "Raven", capabilities: ["gunshot_detection", "sensor_detections", "alerts_events"],
  },
  // DroneSense
  {
    id: "dronesense_flight_platform",
    ecosystemId: "dronesense",
    name: "UAS flight operations platform",
    capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id", "adsb"],
  },
  // Skydio
  {
    id: "skydio_uas",
    ecosystemId: "skydio",
    name: "Autonomous UAS",
    capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"],
  },
  {
    id: "skydio_dock",
    ecosystemId: "skydio",
    name: "UAS dock",
    capabilities: ["dock_status", "uas_telemetry"],
  },
  // DJI
  {
    id: "dji_uas",
    ecosystemId: "dji",
    name: "UAS aircraft",
    capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"],
  },
  {
    id: "dji_dock",
    ecosystemId: "dji",
    name: "UAS dock",
    capabilities: ["dock_status", "uas_telemetry"],
  },
  // Pulsiam
  {
    id: "pulsiam_cad",
    ecosystemId: "pulsiam",
    name: "Computer-aided dispatch",
    capabilities: ["cad_incident_feed", "unit_locations", "dispatch_status", "personnel_availability"],
  },
  // BRINC
  { id: "brinc_responder", ecosystemId: "brinc", name: "BRINC Responder", productFamily: "Responder", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "brinc_lemur_2", ecosystemId: "brinc", name: "BRINC Lemur 2", productFamily: "Lemur", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "brinc_sky_command", ecosystemId: "brinc", name: "BRINC Sky Command", productFamily: "Sky Command", capabilities: ["program_management", "uas_telemetry", "aircraft_location", "live_video", "alerts_events"] },
  // SkySafe
  { id: "skysafe_airspace_intelligence", ecosystemId: "skysafe", name: "SkySafe airspace intelligence", capabilities: ["airspace_awareness", "counter_uas_detection", "counter_uas_tracking", "counter_uas_identification", "sensor_detections", "remote_id", "alerts_events"] },
  // Additional airframes and DFR specialists
  { id: "autel_enterprise_uas", ecosystemId: "autel", name: "Autel enterprise UAS", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "parrot_anafi", ecosystemId: "parrot", name: "Parrot ANAFI", productFamily: "ANAFI", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "teal_2", ecosystemId: "teal_red_cat", name: "Teal 2", productFamily: "Teal", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "versaterm_cad", ecosystemId: "versaterm", name: "Versaterm CAD/RMS", capabilities: ["cad_incident_feed", "unit_locations", "dispatch_status", "personnel_availability", "alerts_events"] },
  { id: "sifly_long_endurance_uas", ecosystemId: "sifly", name: "SiFly long-endurance UAS", capabilities: ["uas_telemetry", "aircraft_location", "live_video", "remote_id"] },
  { id: "skyfireai_program_services", ecosystemId: "skyfireai", name: "SkyfireAI DFR program services", capabilities: ["program_management", "mapping_photogrammetry"] },
  { id: "paladin_turnkey_dfr", ecosystemId: "paladin", name: "Paladin turnkey DFR", capabilities: ["program_management", "uas_telemetry", "aircraft_location", "live_video"] },
  { id: "ondas_airobotics_optimus", ecosystemId: "ondas", name: "Airobotics Optimus drone-in-a-box", productFamily: "Optimus", capabilities: ["dock_status", "uas_telemetry", "aircraft_location", "live_video"] },
  { id: "easy_aerial_easy_guard", ecosystemId: "easy_aerial", name: "Easy Aerial Easy Guard", productFamily: "Easy Guard", capabilities: ["dock_status", "uas_telemetry", "aircraft_location", "live_video"] },
  { id: "droneshield_counter_uas", ecosystemId: "droneshield", name: "DroneShield counter-UAS", capabilities: ["airspace_awareness", "counter_uas_detection", "counter_uas_tracking", "counter_uas_identification", "counter_uas_mitigation", "alerts_events"] },
  { id: "draganfly_medical_delivery", ecosystemId: "draganfly", name: "Draganfly medical delivery UAS", capabilities: ["uas_telemetry", "aircraft_location", "medical_delivery"] },
];

export function findCatalogComponent(componentId: string): CatalogComponent | null {
  return CATALOG_COMPONENTS.find((c) => c.id === componentId) ?? null;
}

// ---------------------------------------------------------------------------
// Advisory cross-ecosystem relations ("works with", never "owns")
// ---------------------------------------------------------------------------

export interface AdvisoryRelation {
  /** Selecting this ecosystem may make the suggested component relevant. */
  fromEcosystemId: EcosystemId;
  /** The suggested component; its true ecosystemId stays with its own vendor. */
  suggestedComponentId: string;
  /** Why the suggestion is offered. Always framed as interoperability. */
  reason: string;
}

const WORKS_WITH =
  "supported interoperability path; separate vendors — advisory suggestion only, not ownership, installation, or connection";
const STRATEGIC_ALLIANCE =
  "strategic alliance or investment relationship — advisory suggestion only, not ownership, installation, or connection";
const HARDWARE_PARTNER =
  "documented hardware/software partnership — advisory suggestion only, not ownership, installation, or connection";

export const ADVISORY_RELATIONS: readonly AdvisoryRelation[] = [
  { fromEcosystemId: "axon", suggestedComponentId: "skydio_uas", reason: HARDWARE_PARTNER },
  { fromEcosystemId: "axon", suggestedComponentId: "skydio_dock", reason: HARDWARE_PARTNER },
  { fromEcosystemId: "skydio", suggestedComponentId: "axon_air", reason: HARDWARE_PARTNER },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "brinc_responder", reason: STRATEGIC_ALLIANCE },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "brinc_sky_command", reason: STRATEGIC_ALLIANCE },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "skysafe_airspace_intelligence", reason: STRATEGIC_ALLIANCE },
  { fromEcosystemId: "brinc", suggestedComponentId: "motorola_commandcentral", reason: STRATEGIC_ALLIANCE },
  { fromEcosystemId: "skysafe", suggestedComponentId: "motorola_commandcentral", reason: STRATEGIC_ALLIANCE },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "dji_uas", reason: WORKS_WITH },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "skydio_uas", reason: WORKS_WITH },
  { fromEcosystemId: "motorola_solutions", suggestedComponentId: "autel_enterprise_uas", reason: WORKS_WITH },
  { fromEcosystemId: "dji", suggestedComponentId: "motorola_cape", reason: WORKS_WITH },
  { fromEcosystemId: "skydio", suggestedComponentId: "motorola_cape", reason: WORKS_WITH },
  { fromEcosystemId: "autel", suggestedComponentId: "motorola_cape", reason: WORKS_WITH },
  { fromEcosystemId: "dronesense", suggestedComponentId: "dji_uas", reason: WORKS_WITH },
  { fromEcosystemId: "dronesense", suggestedComponentId: "skydio_uas", reason: WORKS_WITH },
  { fromEcosystemId: "dronesense", suggestedComponentId: "autel_enterprise_uas", reason: WORKS_WITH },
  { fromEcosystemId: "dronesense", suggestedComponentId: "parrot_anafi", reason: WORKS_WITH },
  { fromEcosystemId: "dji", suggestedComponentId: "dronesense_flight_platform", reason: WORKS_WITH },
  { fromEcosystemId: "skydio", suggestedComponentId: "dronesense_flight_platform", reason: WORKS_WITH },
  { fromEcosystemId: "autel", suggestedComponentId: "dronesense_flight_platform", reason: WORKS_WITH },
  { fromEcosystemId: "parrot", suggestedComponentId: "dronesense_flight_platform", reason: WORKS_WITH },
  { fromEcosystemId: "versaterm", suggestedComponentId: "sifly_long_endurance_uas", reason: HARDWARE_PARTNER },
  { fromEcosystemId: "sifly", suggestedComponentId: "versaterm_cad", reason: HARDWARE_PARTNER },
  { fromEcosystemId: "skyfireai", suggestedComponentId: "brinc_responder", reason: WORKS_WITH },
  { fromEcosystemId: "skyfireai", suggestedComponentId: "ondas_airobotics_optimus", reason: WORKS_WITH },
];

// ---------------------------------------------------------------------------
// Suggestions (advisory only)
// ---------------------------------------------------------------------------

export type SuggestionKind = "ecosystem_component" | "related_product";

export interface ComponentSuggestion {
  componentId: string;
  /** The component's OWN vendor ecosystem — never re-attributed to the selecting one. */
  ecosystemId: EcosystemId;
  name: string;
  capabilities: readonly AirsCapability[];
  /** Suggestions are always advisory. They never confirm, install, or connect anything. */
  advisory: true;
  kind: SuggestionKind;
  reason: string;
}

/**
 * Suggests likely components for a set of selected ecosystems.
 *
 * Deterministic and pure: results follow catalog declaration order, unknown
 * ecosystem IDs are silently ignored, and duplicates are removed. The result
 * is advisory only — it carries no integration state and never marks anything
 * confirmed, installed, connected, authorized, credentialed, or data-capable.
 */
export function suggestComponentsForEcosystems(
  selectedEcosystemIds: readonly string[],
): ComponentSuggestion[] {
  const selected = new Set(selectedEcosystemIds.filter(isEcosystemId));
  const suggestions: ComponentSuggestion[] = [];
  const seen = new Set<string>();

  // Components belonging to the selected ecosystems themselves.
  for (const component of CATALOG_COMPONENTS) {
    if (!selected.has(component.ecosystemId) || seen.has(component.id)) continue;
    seen.add(component.id);
    suggestions.push({
      componentId: component.id,
      ecosystemId: component.ecosystemId,
      name: component.name,
      capabilities: component.capabilities,
      advisory: true,
      kind: "ecosystem_component",
      reason: "offered within a selected vendor ecosystem; advisory suggestion only",
    });
  }

  // Cross-vendor "works with" relations, attributed to the component's own vendor.
  for (const relation of ADVISORY_RELATIONS) {
    if (!selected.has(relation.fromEcosystemId)) continue;
    const component = findCatalogComponent(relation.suggestedComponentId);
    if (!component || seen.has(component.id)) continue;
    seen.add(component.id);
    suggestions.push({
      componentId: component.id,
      ecosystemId: component.ecosystemId,
      name: component.name,
      capabilities: component.capabilities,
      advisory: true,
      kind: "related_product",
      reason: relation.reason,
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Confirmed installations (agency-declared; never auto-connected)
// ---------------------------------------------------------------------------

export interface ConfirmedComponent {
  componentId: string;
  ecosystemId: EcosystemId;
  name: string;
  capabilities: readonly AirsCapability[];
  /** Always "agency_confirmed": only an explicit agency action creates one. */
  source: "agency_confirmed";
  /** Starts as the default NOT-connected state; this module never changes it. */
  integration: IntegrationState;
}

/**
 * Creates an agency-confirmed installed-component record for a KNOWN catalog
 * component. Unknown IDs return null (default deny — no widening).
 *
 * The record's integration state is always the default disconnected state:
 * confirmation records what the agency uses, and nothing more.
 */
export function confirmComponent(componentId: string): ConfirmedComponent | null {
  const component = findCatalogComponent(componentId);
  if (!component) return null;
  return {
    componentId: component.id,
    ecosystemId: component.ecosystemId,
    name: component.name,
    capabilities: component.capabilities,
    source: "agency_confirmed",
    integration: createDefaultIntegrationState(),
  };
}

/**
 * Accepting a suggestion is just an explicit confirmation of that component.
 * It NEVER carries over any implied connection, authorization, credentials,
 * or data access — the result uses the default disconnected state.
 */
export function acceptSuggestion(suggestion: ComponentSuggestion): ConfirmedComponent | null {
  return confirmComponent(suggestion.componentId);
}

/**
 * Normalizes the AIRS capabilities represented by a set of confirmed component
 * IDs. Unknown IDs are ignored; the result is deduplicated and returned in the
 * stable vendor-neutral vocabulary order. This describes what the components
 * COULD provide — it says nothing about connection or data access.
 */
export function normalizedCapabilitiesForComponents(
  confirmedComponentIds: readonly string[],
): AirsCapability[] {
  const found = new Set<AirsCapability>();
  for (const id of confirmedComponentIds) {
    const component = findCatalogComponent(id);
    if (!component) continue;
    for (const capability of component.capabilities) {
      found.add(capability);
    }
  }
  return AIRS_CAPABILITIES.filter((capability) => found.has(capability));
}
