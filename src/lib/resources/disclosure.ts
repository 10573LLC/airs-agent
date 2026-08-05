// Field-level disclosure model (Stage 6 closure).
//
// RLS decides WHICH ROWS an organization may reach. This module decides WHICH
// FIELDS of a reachable row may be returned. Both are required: RLS cannot
// express "this partner may see the model but not the serial number", and a
// projection layer cannot be trusted to hide a row the database already handed
// over. Neither layer is allowed to widen the other.
//
// Pure and portable: no I/O, no SQL, no platform SDK. Mirrored in the database
// by airs.disclosure_fields (see db/migrations/0008_disclosure_profiles.sql);
// tests/disclosure.test.ts and db/tests/disclosure_projection.sql fail the
// build if the two ever drift.
//
// The client never names fields or columns. It may at most reference a profile
// key that the ORIGINATING organization stored on the share; every field name
// below is a server-side constant.

import type { DetailKind } from "./model";

export const DISCLOSURE_PROFILES = [
  "summary",
  "operational",
  "aviation",
  "incident_command",
  "full",
  "custom",
] as const;
export type DisclosureProfile = (typeof DISCLOSURE_PROFILES)[number];

export const DISCLOSURE_PROFILE_LABELS: Record<DisclosureProfile, string> = {
  summary: "Summary",
  operational: "Operational",
  aviation: "Aviation",
  incident_command: "Incident command",
  full: "Full authorized record",
  custom: "Custom approved profile",
};

/** Where a projected value is read from once RLS has already released the row. */
type FieldSource = "resource" | "detail" | "extra" | "personnel" | "qualification";

export interface FieldDef {
  /** Source object the value is copied from. */
  source: FieldSource;
  /** Property on that source object. Never client supplied. */
  column: string;
  /** Sensitive fields are excluded from every partner profile by default. */
  sensitive?: true;
  /** Detail fields only apply to these category kinds. */
  kinds?: readonly DetailKind[];
}

/**
 * The complete server-controlled field vocabulary. A key that is not in this
 * table cannot be disclosed by any profile, custom list, query parameter,
 * header or body value — there is no path from a request to a column name.
 */
export const FIELD_DEFS = {
  // --- resource identity / summary -----------------------------------------
  resourceId: { source: "resource", column: "id" },
  displayName: { source: "resource", column: "displayName" },
  category: { source: "resource", column: "category" },
  callsign: { source: "resource", column: "callsign" },
  readinessStatus: { source: "resource", column: "readinessStatus" },
  originatingOrganization: { source: "extra", column: "ownerOrgName" },

  // --- operational ----------------------------------------------------------
  description: { source: "resource", column: "description" },
  operationalStatus: { source: "resource", column: "operationalStatus" },
  lifecycleStatus: { source: "resource", column: "lifecycleStatus" },
  assignmentStatus: { source: "extra", column: "assignmentStatus" },
  currentIncidentRole: { source: "extra", column: "currentIncidentRole" },
  broadAvailability: { source: "extra", column: "broadAvailability" },
  serviceStatus: { source: "detail", column: "service_status" },
  operationalLimitations: {
    source: "detail",
    column: "operational_limitations",
    kinds: ["launch_site"],
  },
  vehicleType: { source: "detail", column: "vehicle_type", kinds: ["vehicle"] },
  vehicleIdentifier: { source: "detail", column: "vehicle_identifier", kinds: ["vehicle"] },
  assignedUnit: { source: "detail", column: "assigned_unit", kinds: ["vehicle"] },
  supportedEquipment: { source: "detail", column: "supported_equipment", kinds: ["vehicle"] },
  dockName: { source: "detail", column: "dock_name", kinds: ["dock"] },
  connectivityStatus: { source: "detail", column: "connectivity_status", kinds: ["dock", "sensor"] },
  powerStatus: { source: "detail", column: "power_status", kinds: ["dock"] },
  siteName: { source: "detail", column: "site_name", kinds: ["launch_site"] },
  owningOrganizationLabel: {
    source: "detail",
    column: "owning_organization",
    kinds: ["launch_site"],
  },
  supportedCategories: { source: "detail", column: "supported_categories", kinds: ["launch_site"] },
  sensorCategory: { source: "detail", column: "sensor_category", kinds: ["sensor"] },
  mounting: { source: "detail", column: "mounting", kinds: ["sensor"] },
  detectionCategory: { source: "detail", column: "detection_category", kinds: ["sensor"] },
  agencyIdentifier: { source: "detail", column: "agency_identifier", kinds: ["sensor"] },

  // --- aviation -------------------------------------------------------------
  manufacturer: { source: "detail", column: "manufacturer", kinds: ["aircraft", "dock", "sensor"] },
  model: { source: "detail", column: "model", kinds: ["aircraft", "dock", "sensor"] },
  aircraftType: { source: "detail", column: "aircraft_type", kinds: ["aircraft"] },
  thermalCapable: { source: "detail", column: "thermal_capable", kinds: ["aircraft"] },
  parachuteEquipped: { source: "detail", column: "parachute_equipped", kinds: ["aircraft"] },
  dockCompatible: { source: "detail", column: "dock_compatible", kinds: ["aircraft"] },
  maxApprovedAltitudeFt: {
    source: "detail",
    column: "max_approved_altitude_ft",
    kinds: ["aircraft"],
  },
  supportedAircraftType: { source: "detail", column: "supported_aircraft_type", kinds: ["dock"] },
  batteryReadiness: { source: "detail", column: "battery_readiness", kinds: ["aircraft"] },
  qualificationType: { source: "qualification", column: "qualificationType" },
  qualificationCurrent: { source: "qualification", column: "isCurrent" },

  // --- incident command -----------------------------------------------------
  locationDescription: { source: "detail", column: "location_description", kinds: ["launch_site"] },
  qualificationExpiresOn: { source: "qualification", column: "expiresOn" },
  assignmentWindow: { source: "extra", column: "assignmentWindow" },
  sharedUntil: { source: "extra", column: "sharedUntil" },

  // --- personnel readiness --------------------------------------------------
  personDisplayName: { source: "personnel", column: "displayName" },
  personCallsign: { source: "personnel", column: "callsign" },
  personAvailabilityStatus: { source: "personnel", column: "availabilityStatus" },
  personOperationalRoles: { source: "personnel", column: "operationalRoles" },
  personOperationalStatus: { source: "personnel", column: "operationalStatus" },

  // --- sensitive: never in a partner profile unless explicitly full-authorized
  serialNumber: { source: "detail", column: "serial_number", sensitive: true, kinds: ["aircraft"] },
  faaRegistration: {
    source: "detail",
    column: "faa_registration",
    sensitive: true,
    kinds: ["aircraft"],
  },
  remoteId: { source: "detail", column: "remote_id", sensitive: true, kinds: ["aircraft"] },
  restrictedNotes: { source: "resource", column: "restrictedNotes", sensitive: true },
  detailRestrictedNotes: { source: "detail", column: "restricted_notes", sensitive: true },
  maintenanceStatus: {
    source: "detail",
    column: "maintenance_status",
    sensitive: true,
    kinds: ["aircraft", "sensor"],
  },
  personDutyContact: { source: "personnel", column: "dutyContact", sensitive: true },
  personEmployeeIdentifier: { source: "personnel", column: "employeeIdentifier", sensitive: true },
  personQualificationSummary: {
    source: "personnel",
    column: "qualificationSummary",
    sensitive: true,
  },
  qualificationRestrictions: { source: "qualification", column: "restrictions", sensitive: true },
  qualificationIssuer: {
    source: "qualification",
    column: "issuingOrganization",
    sensitive: true,
  },
  qualificationVerification: {
    source: "qualification",
    column: "verificationStatus",
    sensitive: true,
  },
} as const satisfies Record<string, FieldDef>;

export type FieldKey = keyof typeof FIELD_DEFS;

export const FIELD_KEYS = Object.keys(FIELD_DEFS) as FieldKey[];

/** Widened view of the literal table above, for lookup by key. */
export const FIELD_DEF: Record<FieldKey, FieldDef> = FIELD_DEFS;

/** Hidden from partners by default; only the full-authorized path may add them. */
export const SENSITIVE_FIELD_KEYS: readonly FieldKey[] = FIELD_KEYS.filter(
  (k) => FIELD_DEF[k].sensitive === true,
);

const SUMMARY: readonly FieldKey[] = [
  "resourceId",
  "displayName",
  "category",
  "callsign",
  "readinessStatus",
  "originatingOrganization",
  "personDisplayName",
  "personCallsign",
  "personAvailabilityStatus",
];

const OPERATIONAL_ADDS: readonly FieldKey[] = [
  "description",
  "operationalStatus",
  "lifecycleStatus",
  "assignmentStatus",
  "currentIncidentRole",
  "broadAvailability",
  "serviceStatus",
  "operationalLimitations",
  "vehicleType",
  "vehicleIdentifier",
  "assignedUnit",
  "supportedEquipment",
  "dockName",
  "connectivityStatus",
  "powerStatus",
  "siteName",
  "owningOrganizationLabel",
  "supportedCategories",
  "sensorCategory",
  "mounting",
  "detectionCategory",
  "agencyIdentifier",
  "personOperationalRoles",
  "personOperationalStatus",
];

const AVIATION_ADDS: readonly FieldKey[] = [
  "manufacturer",
  "model",
  "aircraftType",
  "thermalCapable",
  "parachuteEquipped",
  "dockCompatible",
  "maxApprovedAltitudeFt",
  "supportedAircraftType",
  "batteryReadiness",
  "qualificationType",
  "qualificationCurrent",
];

const INCIDENT_COMMAND_ADDS: readonly FieldKey[] = [
  "locationDescription",
  "qualificationExpiresOn",
  "assignmentWindow",
  "sharedUntil",
];

/** Cumulative allow-lists. Anything absent is denied — there is no wildcard. */
export const PROFILE_FIELDS: Record<DisclosureProfile, readonly FieldKey[]> = {
  summary: SUMMARY,
  operational: [...SUMMARY, ...OPERATIONAL_ADDS],
  aviation: [...SUMMARY, ...OPERATIONAL_ADDS, ...AVIATION_ADDS],
  incident_command: [
    ...SUMMARY,
    ...OPERATIONAL_ADDS,
    ...AVIATION_ADDS,
    ...INCIDENT_COMMAND_ADDS,
  ],
  full: FIELD_KEYS,
  // A custom profile can only ever be assembled from non-sensitive keys.
  custom: FIELD_KEYS.filter((k) => !FIELD_DEF[k].sensitive),
};

/** Keys an originating organization may put in a custom approved profile. */
export const CUSTOM_SELECTABLE_FIELDS: readonly FieldKey[] = PROFILE_FIELDS.custom;

export function isFieldKey(value: unknown): value is FieldKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FIELD_DEFS, value);
}

export function isDisclosureProfile(value: unknown): value is DisclosureProfile {
  return (
    typeof value === "string" && (DISCLOSURE_PROFILES as readonly string[]).includes(value)
  );
}

export interface DisclosureRequest {
  profile: DisclosureProfile;
  /** Stored on the share by the ORIGINATING organization. Never client supplied. */
  customFieldKeys?: readonly string[] | null;
  /** True only for the originating organization. */
  owner: boolean;
  /**
   * True when the reader is an explicitly named recipient of the share. Only a
   * named recipient may ever be granted the full authorized record.
   */
  namedRecipient?: boolean;
}

/**
 * Resolves the effective, ordered set of disclosable keys. Default deny:
 *  - an unknown profile collapses to `summary`
 *  - `full` collapses to `incident_command` unless owner or named recipient
 *  - custom keys outside CUSTOM_SELECTABLE_FIELDS are dropped, not rejected
 *    loudly, so a partner cannot probe key names through error text
 */
export function resolveDisclosedFields(req: DisclosureRequest): FieldKey[] {
  if (req.owner) return [...FIELD_KEYS];

  const profile: DisclosureProfile = isDisclosureProfile(req.profile) ? req.profile : "summary";

  if (profile === "full") {
    return req.namedRecipient === true ? [...FIELD_KEYS] : [...PROFILE_FIELDS.incident_command];
  }
  if (profile === "custom") {
    const allowed = new Set<FieldKey>(CUSTOM_SELECTABLE_FIELDS);
    const chosen = (req.customFieldKeys ?? []).filter(
      (k): k is FieldKey => isFieldKey(k) && allowed.has(k),
    );
    // A custom profile always keeps the summary floor so a record stays
    // identifiable; it can never drop below it nor rise above non-sensitive.
    const merged = new Set<FieldKey>([...SUMMARY, ...chosen]);
    return FIELD_KEYS.filter((k) => merged.has(k));
  }
  return [...PROFILE_FIELDS[profile]];
}

export type ProjectedValue = string | number | boolean | string[] | null;

export interface ProjectionSources {
  resource?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  personnel?: Record<string, unknown> | null;
  qualification?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
}

function jsonSafe(value: unknown): ProjectedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Builds the response object. Keys the caller is not authorized for are ABSENT
 * from the result — not null, not empty string, not present-but-masked — so no
 * value, length or existence can be inferred from the payload.
 */
export function projectFields(
  keys: readonly FieldKey[],
  sources: ProjectionSources,
  detailKind?: DetailKind | null,
): Record<string, ProjectedValue> {
  const out: Record<string, ProjectedValue> = {};
  for (const key of keys) {
    const def = FIELD_DEF[key];
    if (def.kinds && (!detailKind || !def.kinds.includes(detailKind))) continue;
    const bag = sources[def.source];
    if (!bag || !(def.column in bag)) continue;
    out[key] = jsonSafe(bag[def.column]);
  }
  return out;
}

/** Convenience: the disclosed-field list a UI may render as an explanation. */
export function describeProfile(profile: DisclosureProfile): string {
  return DISCLOSURE_PROFILE_LABELS[profile] ?? DISCLOSURE_PROFILE_LABELS.summary;
}
