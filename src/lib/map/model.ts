// Portable Common Operating Picture domain model.
//
// Mirrors db/migrations/0009_common_operating_picture.sql exactly; the parity
// test in tests/map-geography.test.ts fails the build if the two ever drift.
// Pure TypeScript: no map SDK, no I/O, no platform service. Every geometry is
// plain GeoJSON in WGS 84 (SRID 4326), so the same payload feeds MapLibre, QGIS
// or any other renderer without translation.

import type { DisclosureProfile } from "@/lib/resources/disclosure";

// --- feature vocabulary -------------------------------------------------------

export const MAP_FEATURE_TYPES = [
  "staging_area",
  "landing_zone",
  "hazard",
  "point_of_interest",
  "boundary",
  "route",
  "sector",
  "search_area",
  "command_post",
] as const;
export type MapFeatureType = (typeof MAP_FEATURE_TYPES)[number];

export const MAP_FEATURE_LABELS: Record<MapFeatureType, string> = {
  staging_area: "Staging area",
  landing_zone: "Landing zone",
  hazard: "Hazard",
  point_of_interest: "Point of interest",
  boundary: "Boundary",
  route: "Route",
  sector: "Sector",
  search_area: "Search area",
  command_post: "Command post",
};

export const OPERATING_AREA_STATUSES = [
  "proposed",
  "approved",
  "active",
  "suspended",
  "completed",
  "cancelled",
] as const;
export type OperatingAreaStatus = (typeof OPERATING_AREA_STATUSES)[number];

export const OPERATING_AREA_LABELS: Record<OperatingAreaStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  active: "Active",
  suspended: "Suspended",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Only an approver may move an area into these. Default deny elsewhere. */
export const APPROVED_AREA_STATUSES: readonly OperatingAreaStatus[] = ["approved", "active"];
export const TERMINAL_AREA_STATUSES: readonly OperatingAreaStatus[] = ["completed", "cancelled"];

export const LOCATION_KINDS = ["fixed", "temporary"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Manual entry only. This stage has no telemetry, tracking or live feed. */
export const POSITION_SOURCES = ["manual", "planned", "last_known"] as const;
export type PositionSource = (typeof POSITION_SOURCES)[number];

// --- geographic precision -----------------------------------------------------

export const PRECISION_POLICIES = [
  "withheld",
  "area_only",
  "generalized",
  "approximate",
  "exact",
] as const;
export type PrecisionPolicy = (typeof PRECISION_POLICIES)[number];

/** Higher rank = more precise. Mirrors airs.geographic_precisions.rank. */
export const PRECISION_RANK: Record<PrecisionPolicy, number> = {
  withheld: 0,
  area_only: 1,
  generalized: 2,
  approximate: 3,
  exact: 4,
};

/** Rounding grid in degrees. null = not a rounding policy. */
export const PRECISION_GRID: Record<PrecisionPolicy, number | null> = {
  withheld: null,
  area_only: null,
  generalized: 0.01,
  approximate: 0.001,
  exact: null,
};

export const PRECISION_LABELS: Record<PrecisionPolicy, string> = {
  withheld: "Withheld",
  area_only: "General area only",
  generalized: "Generalized (~1 km)",
  approximate: "Approximate (~100 m)",
  exact: "Exact",
};

/** Most precise geography a disclosure profile may ever carry. */
export const PROFILE_PRECISION: Record<DisclosureProfile, PrecisionPolicy> = {
  summary: "withheld",
  operational: "area_only",
  aviation: "approximate",
  incident_command: "exact",
  full: "exact",
  custom: "area_only",
};

export function isPrecisionPolicy(value: unknown): value is PrecisionPolicy {
  return typeof value === "string" && (PRECISION_POLICIES as readonly string[]).includes(value);
}

/**
 * Resolves the precision a reader actually gets: the NARROWER of what the
 * owning organization declared and what the reader's disclosure profile
 * permits. Unknown inputs collapse to `withheld` — never to `exact`.
 */
export function resolvePrecision(
  declared: unknown,
  profile: DisclosureProfile | null | undefined,
  isOwner: boolean,
): PrecisionPolicy {
  if (isOwner) return "exact";
  const declaredRank = isPrecisionPolicy(declared) ? PRECISION_RANK[declared] : 0;
  const profileRank =
    profile && PROFILE_PRECISION[profile] ? PRECISION_RANK[PROFILE_PRECISION[profile]] : 0;
  const rank = Math.min(declaredRank, profileRank);
  return (PRECISION_POLICIES.find((p) => PRECISION_RANK[p] === rank) ??
    "withheld") as PrecisionPolicy;
}

// --- position freshness -------------------------------------------------------

export const FRESHNESS_STATES = [
  "fresh",
  "recent",
  "aging",
  "stale",
  "expired",
  "unknown",
] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  fresh: "Fresh (under 5 min)",
  recent: "Recent (under 15 min)",
  aging: "Aging (under 60 min)",
  stale: "Stale (over 60 min)",
  expired: "Expired",
  unknown: "Unknown",
};

/** Mirrors airs.location_freshness(). Age is computed, never client asserted. */
export function freshnessFor(
  reportedAt: string | null | undefined,
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): Freshness {
  if (!reportedAt) return "unknown";
  const reported = Date.parse(reportedAt);
  if (Number.isNaN(reported)) return "unknown";
  if (expiresAt) {
    const expires = Date.parse(expiresAt);
    if (!Number.isNaN(expires) && expires <= now) return "expired";
  }
  const minutes = (now - reported) / 60000;
  if (minutes < 5) return "fresh";
  if (minutes < 15) return "recent";
  if (minutes < 60) return "aging";
  return "stale";
}

// --- GeoJSON ------------------------------------------------------------------

export type Position = [number, number];
export interface PointGeometry {
  type: "Point";
  coordinates: Position;
}
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}
export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}
export type Geometry = PointGeometry | PolygonGeometry | LineStringGeometry;

export const MAX_RING_VERTICES = 512;

export function isFiniteLngLat(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

/**
 * Structural validation of untrusted GeoJSON. Returns null when the value is
 * not a geometry this system stores; callers turn that into `invalid_geometry`.
 * PostGIS validity (self-intersection etc.) is still checked in the database.
 */
export function parseGeometry(value: unknown): Geometry | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown; coordinates?: unknown };
  if (g.type === "Point") {
    return isFiniteLngLat(g.coordinates) ? { type: "Point", coordinates: g.coordinates } : null;
  }
  if (g.type === "LineString") {
    const coords = g.coordinates;
    if (!Array.isArray(coords) || coords.length < 2 || coords.length > MAX_RING_VERTICES)
      return null;
    if (!coords.every(isFiniteLngLat)) return null;
    return { type: "LineString", coordinates: coords as Position[] };
  }
  if (g.type === "Polygon") {
    const rings = g.coordinates;
    if (!Array.isArray(rings) || rings.length < 1 || rings.length > 8) return null;
    const parsed: Position[][] = [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_RING_VERTICES) return null;
      if (!ring.every(isFiniteLngLat)) return null;
      const first = ring[0] as Position;
      const last = ring[ring.length - 1] as Position;
      if (first[0] !== last[0] || first[1] !== last[1]) return null; // must be closed
      parsed.push(ring as Position[]);
    }
    return { type: "Polygon", coordinates: parsed };
  }
  return null;
}

export function parsePolygon(value: unknown): PolygonGeometry | null {
  const geom = parseGeometry(value);
  return geom && geom.type === "Polygon" ? geom : null;
}

export function parsePoint(value: unknown): PointGeometry | null {
  const geom = parseGeometry(value);
  return geom && geom.type === "Point" ? geom : null;
}

/** Bounding box helper the UI uses to frame the map. Pure, no map SDK. */
export function bounds(
  geoms: readonly (Geometry | null | undefined)[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (p: Position) => {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const geom of geoms) {
    if (!geom) continue;
    if (geom.type === "Point") visit(geom.coordinates);
    else if (geom.type === "LineString") geom.coordinates.forEach(visit);
    else geom.coordinates.forEach((ring) => ring.forEach(visit));
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

export const ALTITUDE_CEILING_FT = 18000;

export function altitude(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > ALTITUDE_CEILING_FT) {
    throw new RangeError(`invalid ${label}`);
  }
  return n;
}
