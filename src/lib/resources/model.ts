// Portable resource + readiness domain model.
// Mirrors db/migrations/0007_resource_registry.sql exactly; a parity test
// (tests/resource-registry.test.ts) fails the build if the two ever drift.

export const RESOURCE_CATEGORIES = [
  "aircraft",
  "ground_vehicle",
  "dock",
  "launch_site",
  "remote_id_receiver",
  "radar",
  "rf_detector",
  "adsb_receiver",
  "weather_station",
  "camera",
  "counter_uas",
  "portable_trailer",
  "other",
] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const SENSOR_CATEGORIES = [
  "remote_id_receiver",
  "radar",
  "rf_detector",
  "adsb_receiver",
  "weather_station",
  "camera",
  "counter_uas",
  "other",
] as const;
export type SensorCategory = (typeof SENSOR_CATEGORIES)[number];

export const READINESS_STATUSES = [
  "available",
  "assigned",
  "deploying",
  "deployed",
  "airborne",
  "returning",
  "charging",
  "degraded",
  "offline",
  "restricted",
  "inactive",
  "maintenance",
  "unavailable",
  "out_of_service",
  "retired",
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

const SENSOR_STATUSES: readonly ReadinessStatus[] = [
  "available",
  "assigned",
  "deployed",
  "degraded",
  "offline",
  "maintenance",
  "unavailable",
  "out_of_service",
  "retired",
];

/** Explicit category -> readiness-status validation model. Default deny. */
export const CATEGORY_STATUSES: Record<ResourceCategory, readonly ReadinessStatus[]> = {
  aircraft: [
    "available",
    "assigned",
    "deploying",
    "deployed",
    "airborne",
    "returning",
    "charging",
    "degraded",
    "maintenance",
    "unavailable",
    "out_of_service",
    "retired",
  ],
  ground_vehicle: [
    "available",
    "assigned",
    "deploying",
    "deployed",
    "degraded",
    "maintenance",
    "unavailable",
    "out_of_service",
    "retired",
  ],
  dock: ["available", "degraded", "offline", "maintenance", "out_of_service", "retired"],
  launch_site: ["available", "restricted", "inactive", "unavailable", "retired"],
  portable_trailer: [
    "available",
    "assigned",
    "deploying",
    "deployed",
    "degraded",
    "maintenance",
    "unavailable",
    "out_of_service",
    "retired",
  ],
  remote_id_receiver: SENSOR_STATUSES,
  radar: SENSOR_STATUSES,
  rf_detector: SENSOR_STATUSES,
  adsb_receiver: SENSOR_STATUSES,
  weather_station: SENSOR_STATUSES,
  camera: SENSOR_STATUSES,
  counter_uas: SENSOR_STATUSES,
  other: SENSOR_STATUSES,
};

export function statusAllowedForCategory(
  category: ResourceCategory,
  status: ReadinessStatus,
): boolean {
  return (CATEGORY_STATUSES[category] ?? []).includes(status);
}

export const OPERATIONAL_STATUSES = [
  "operational",
  "limited",
  "non_operational",
  "unknown",
] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export const SHARING_CLASSIFICATIONS = [
  "participating_orgs",
  "public_safety_only",
  "law_enforcement_sensitive",
  "aviation_personnel_only",
  "incident_command_only",
  "originating_org_only",
  "named_recipients",
] as const;
export type SharingClassification = (typeof SHARING_CLASSIFICATIONS)[number];

export const QUALIFICATION_TYPES = [
  "rpic",
  "visual_observer",
  "airspace_supervisor",
  "dfr_operator",
  "sensor_operator",
  "incident_commander",
  "intel_analyst",
  "counter_uas_operator",
  "instructor",
  "other",
] as const;
export type QualificationType = (typeof QUALIFICATION_TYPES)[number];

export const OPERATIONAL_ROLES = [
  "rpic",
  "visual_observer",
  "airspace_supervisor",
  "dfr_operator",
  "sensor_operator",
  "incident_commander",
  "intel_analyst",
  "counter_uas_operator",
  "dispatcher",
  "other",
] as const;
export type OperationalRole = (typeof OPERATIONAL_ROLES)[number];

export const AVAILABILITY_STATUSES = [
  "scheduled",
  "available",
  "assigned",
  "deploying",
  "deployed",
  "unavailable",
  "off_duty",
] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const SHIFT_STATUSES = [...AVAILABILITY_STATUSES, "cancelled"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const PERSONNEL_STATUSES = ["active", "unavailable", "suspended", "inactive"] as const;
export type PersonnelStatus = (typeof PERSONNEL_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "proposed",
  "assigned",
  "deploying",
  "active",
  "released",
  "cancelled",
  "completed",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ACTIVE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  "proposed",
  "assigned",
  "deploying",
  "active",
];

export const TERMINAL_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  "released",
  "cancelled",
  "completed",
];

export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  aircraft: "Aircraft",
  ground_vehicle: "Ground vehicle",
  dock: "Dock",
  launch_site: "Launch site",
  remote_id_receiver: "Remote ID receiver",
  radar: "Radar",
  rf_detector: "RF detector",
  adsb_receiver: "ADS-B receiver",
  weather_station: "Weather station",
  camera: "Camera",
  counter_uas: "Counter-UAS system",
  portable_trailer: "Portable trailer",
  other: "Other",
};

export const STATUS_LABELS: Record<ReadinessStatus, string> = {
  available: "Available",
  assigned: "Assigned",
  deploying: "Deploying",
  deployed: "Deployed",
  airborne: "Airborne",
  returning: "Returning",
  charging: "Charging",
  degraded: "Degraded",
  offline: "Offline",
  restricted: "Restricted",
  inactive: "Inactive",
  maintenance: "Maintenance",
  unavailable: "Unavailable",
  out_of_service: "Out of service",
  retired: "Retired",
};

/** Detail category grouping used by the UI and by the service layer. */
export function detailKindFor(category: ResourceCategory): DetailKind {
  if (category === "aircraft") return "aircraft";
  if (category === "ground_vehicle" || category === "portable_trailer") return "vehicle";
  if (category === "dock") return "dock";
  if (category === "launch_site") return "launch_site";
  return "sensor";
}
export type DetailKind = "aircraft" | "vehicle" | "dock" | "launch_site" | "sensor";

/** A qualification is current only when every condition holds. Default deny. */
export function qualificationIsCurrent(q: {
  status: string;
  verificationStatus: string;
  revokedAt?: string | null;
  effectiveDate: string;
  expiresOn?: string | null;
}): boolean {
  if (q.status !== "active" || q.verificationStatus !== "verified" || q.revokedAt) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (q.effectiveDate > today) return false;
  if (q.expiresOn && q.expiresOn < today) return false;
  return true;
}
