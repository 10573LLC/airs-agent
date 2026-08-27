// Common Operating Picture — server-side services.
//
// Every exported function runs through withAuthorized(), which enforces:
//   session -> account -> active membership -> organization role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
//
// On top of that this module enforces the geographic plane:
//   row access (RLS) -> ownership -> geometry validation -> GEOGRAPHIC
//   PRECISION -> freshness -> action.
//
// Precision is resolved in the DATABASE (airs.resolve_precision) and applied in
// the DATABASE (airs.apply_precision) before the coordinate ever reaches this
// process. A partner-facing payload therefore never contains a coordinate the
// server merely intended to round. Nothing here trusts a browser-supplied
// organization id, owner id, precision policy for someone else's record,
// freshness value or access outcome.
import type { QueryRunner } from "@/lib/adapters/types";
import { withAuthorized, type AuthorizedContext } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { assertOneOf, assertUuid, text, timestamp } from "@/lib/resources/resources.server";

import {
  MAP_FEATURE_TYPES,
  OPERATING_AREA_STATUSES,
  POSITION_SOURCES,
  PRECISION_POLICIES,
  LOCATION_KINDS,
  parseGeometry,
  parsePoint,
  parsePolygon,
  type Freshness,
  type Geometry,
  type LocationKind,
  type MapFeatureType,
  type OperatingAreaStatus,
  type PrecisionPolicy,
} from "./model";

const CLASSIFICATIONS = [
  "participating_orgs",
  "public_safety_only",
  "law_enforcement_sensitive",
  "aviation_personnel_only",
  "incident_command_only",
  "originating_org_only",
  "named_recipients",
] as const;

/** Terminal states an operating area can never leave. */
const TERMINAL = ["completed", "cancelled"] as const;

// --- shared shapes ------------------------------------------------------------

export interface GeographyEnvelope {
  /** Precision actually applied to `geometry`. Owner reads are always "exact". */
  precision: PrecisionPolicy;
  /**
   * GeoJSON in SRID 4326, already reduced to `precision`. ABSENT (not null,
   * not zeroed) when the reader is not entitled to any geography, so no
   * coordinate, extent or existence of a coordinate can be inferred.
   */
  geometry?: Geometry;
}

export interface MapFeatureView extends GeographyEnvelope {
  id: string;
  orgId: string;
  incidentId: string | null;
  featureType: MapFeatureType;
  name: string;
  description: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
  relationship: "owner" | "partner";
  ownerOrgName: string | null;
  /** Owner-only bookkeeping; absent for partners. */
  classification?: string;
  declaredPrecision?: PrecisionPolicy;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface OperatingAreaView extends GeographyEnvelope {
  id: string;
  orgId: string;
  incidentId: string;
  name: string;
  purpose: string;
  altitudeFloorFt: number;
  altitudeCeilingFt: number;
  startsAt: string;
  endsAt: string | null;
  status: OperatingAreaStatus;
  version: number;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  relationship: "owner" | "partner";
  ownerOrgName: string | null;
  classification?: string;
  declaredPrecision?: PrecisionPolicy;
}

export interface ResourceLocationView extends GeographyEnvelope {
  id: string;
  orgId: string;
  resourceId: string;
  resourceName: string;
  resourceCategory: string;
  incidentId: string | null;
  locationKind: LocationKind;
  positionSource: string;
  note: string;
  altitudeFt: number | null;
  accuracyMeters: number | null;
  reportedAt: string;
  expiresAt: string | null;
  /** Computed by the database clock, never by the browser. */
  freshness: Freshness;
  relationship: "owner" | "partner";
  ownerOrgName: string | null;
  declaredPrecision?: PrecisionPolicy;
}

/**
 * Turns a database row into a payload. A withheld geometry is DELETED rather
 * than nulled, matching the Stage 6 field-disclosure rule: a partner cannot
 * distinguish "no geography recorded" from "geography withheld".
 */
function envelope(policy: string, geojson: string | null): GeographyEnvelope {
  const precision = (PRECISION_POLICIES as readonly string[]).includes(policy)
    ? (policy as PrecisionPolicy)
    : "withheld";
  if (precision === "withheld" || !geojson) return { precision };
  try {
    const parsed = parseGeometry(JSON.parse(geojson));
    return parsed ? { precision, geometry: parsed } : { precision: "withheld" };
  } catch {
    return { precision: "withheld" };
  }
}

/** Owner-plane columns are stripped from partner payloads by construction. */
function ownerOnly<T extends Record<string, unknown>>(row: T, isOwner: boolean, keys: string[]): T {
  if (isOwner) return row;
  for (const key of keys) delete row[key];
  return row;
}

function assertPrecision(value: unknown, fallback: PrecisionPolicy): PrecisionPolicy {
  if (value == null || value === "") return fallback;
  return assertOneOf(value, PRECISION_POLICIES, "precision policy");
}

function geometryOrThrow(value: unknown, kind: "any" | "polygon" | "point"): Geometry {
  const parsed =
    kind === "polygon"
      ? parsePolygon(value)
      : kind === "point"
        ? parsePoint(value)
        : parseGeometry(value);
  if (!parsed) throw new AccessError("invalid_geometry");
  return parsed;
}

function integer(value: unknown, label: string, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return n;
}

// --- reads --------------------------------------------------------------------

const FEATURE_SELECT = `
  f.id, f.org_id AS "orgId", f.incident_id AS "incidentId",
  f.feature_type AS "featureType", f.name, f.description, f.status, f.version,
  f.classification, f.precision_policy AS "declaredPrecision",
  to_json(f.effective_from)#>>'{}' AS "effectiveFrom",
  to_json(f.effective_to)#>>'{}' AS "effectiveTo",
  to_json(f.created_at)#>>'{}' AS "createdAt",
  to_json(f.updated_at)#>>'{}' AS "updatedAt",
  airs.related_org_name(f.org_id) AS "ownerOrgName",
  (f.org_id = $1) AS "isOwner",
  p.policy AS "policy",
  public.ST_AsGeoJSON(airs.apply_precision(f.geom, p.policy)) AS "geojson"
`;

const FEATURE_FROM = `
  FROM airs.map_features f
  CROSS JOIN LATERAL (
    SELECT airs.resolve_precision(
      f.precision_policy,
      CASE WHEN f.incident_id IS NULL THEN 'summary'
           ELSE airs.incident_geo_profile(f.incident_id) END,
      f.org_id = $1) AS policy
  ) p
`;

interface RawGeoRow {
  isOwner: boolean;
  policy: string;
  geojson: string | null;
  [key: string]: unknown;
}

function toFeature(row: RawGeoRow): MapFeatureView {
  const { isOwner, policy, geojson, ...rest } = row;
  const view = {
    ...(rest as unknown as MapFeatureView),
    relationship: isOwner ? ("owner" as const) : ("partner" as const),
    ...envelope(policy, geojson),
  };
  return ownerOnly(view as unknown as Record<string, unknown>, isOwner, [
    "classification",
    "declaredPrecision",
    "effectiveFrom",
    "effectiveTo",
  ]) as unknown as MapFeatureView;
}

export async function listMapFeatures(
  token: string | null | undefined,
  orgId: string | null,
  filter: { incidentId?: string | null; includeArchived?: boolean } = {},
  meta?: RequestMeta,
): Promise<MapFeatureView[]> {
  const incidentId = filter.incidentId ? assertUuid(filter.incidentId, "incident id") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.read",
      action: "map.features.list",
      resourceType: "map_feature",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<RawGeoRow>(
        `SELECT ${FEATURE_SELECT} ${FEATURE_FROM}
          WHERE ($2::uuid IS NULL OR f.incident_id = $2)
            AND ($3::boolean OR f.status = 'active')
          ORDER BY f.feature_type, f.name`,
        [ctx.orgId, incidentId, filter.includeArchived === true],
      );
      return rows.map(toFeature);
    },
  );
}

const AREA_SELECT = `
  a.id, a.org_id AS "orgId", a.incident_id AS "incidentId", a.name, a.purpose,
  a.altitude_floor_ft AS "altitudeFloorFt", a.altitude_ceiling_ft AS "altitudeCeilingFt",
  to_json(a.starts_at)#>>'{}' AS "startsAt", to_json(a.ends_at)#>>'{}' AS "endsAt",
  a.status, a.version, a.classification, a.precision_policy AS "declaredPrecision",
  to_json(a.approved_at)#>>'{}' AS "approvedAt",
  to_json(a.created_at)#>>'{}' AS "createdAt",
  to_json(a.updated_at)#>>'{}' AS "updatedAt",
  airs.related_org_name(a.org_id) AS "ownerOrgName",
  (a.org_id = $1) AS "isOwner",
  p.policy AS "policy",
  public.ST_AsGeoJSON(airs.apply_precision(a.area, p.policy)) AS "geojson"
`;

const AREA_FROM = `
  FROM airs.operating_areas a
  CROSS JOIN LATERAL (
    SELECT airs.resolve_precision(a.precision_policy,
                                  airs.incident_geo_profile(a.incident_id),
                                  a.org_id = $1) AS policy
  ) p
`;

function toArea(row: RawGeoRow): OperatingAreaView {
  const { isOwner, policy, geojson, ...rest } = row;
  const view = {
    ...(rest as unknown as OperatingAreaView),
    relationship: isOwner ? ("owner" as const) : ("partner" as const),
    ...envelope(policy, geojson),
  };
  return ownerOnly(view as unknown as Record<string, unknown>, isOwner, [
    "classification",
    "declaredPrecision",
  ]) as unknown as OperatingAreaView;
}

export async function listOperatingAreas(
  token: string | null | undefined,
  orgId: string | null,
  filter: { incidentId?: string | null; includeTerminal?: boolean } = {},
  meta?: RequestMeta,
): Promise<OperatingAreaView[]> {
  const incidentId = filter.incidentId ? assertUuid(filter.incidentId, "incident id") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.read",
      action: "map.operating_areas.list",
      resourceType: "operating_area",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<RawGeoRow>(
        `SELECT ${AREA_SELECT} ${AREA_FROM}
          WHERE ($2::uuid IS NULL OR a.incident_id = $2)
            AND ($3::boolean OR a.status NOT IN ('completed','cancelled'))
          ORDER BY a.starts_at DESC, a.name`,
        [ctx.orgId, incidentId, filter.includeTerminal === true],
      );
      return rows.map(toArea);
    },
  );
}

const LOCATION_SELECT = `
  l.id, l.org_id AS "orgId", l.resource_id AS "resourceId",
  r.display_name AS "resourceName", r.category AS "resourceCategory",
  l.incident_id AS "incidentId", l.location_kind AS "locationKind",
  l.position_source AS "positionSource", l.note,
  l.altitude_ft AS "altitudeFt", l.accuracy_meters AS "accuracyMeters",
  to_json(l.reported_at)#>>'{}' AS "reportedAt",
  to_json(l.expires_at)#>>'{}' AS "expiresAt",
  airs.location_freshness(l.reported_at, l.expires_at) AS "freshness",
  l.precision_policy AS "declaredPrecision",
  airs.related_org_name(l.org_id) AS "ownerOrgName",
  (l.org_id = $1) AS "isOwner",
  p.policy AS "policy",
  public.ST_AsGeoJSON(airs.apply_precision(l.geom, p.policy)) AS "geojson"
`;

const LOCATION_FROM = `
  FROM airs.resource_locations l
  JOIN airs.resources r ON r.id = l.resource_id
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT d.profile FROM airs.effective_disclosure(l.resource_id) d LIMIT 1),
                    'summary') AS profile
  ) e
  CROSS JOIN LATERAL (
    SELECT airs.resolve_precision(l.precision_policy, e.profile, l.org_id = $1) AS policy
  ) p
`;

function toLocation(row: RawGeoRow): ResourceLocationView {
  const { isOwner, policy, geojson, ...rest } = row;
  const view = {
    ...(rest as unknown as ResourceLocationView),
    relationship: isOwner ? ("owner" as const) : ("partner" as const),
    ...envelope(policy, geojson),
  };
  return ownerOnly(view as unknown as Record<string, unknown>, isOwner, [
    "declaredPrecision",
  ]) as unknown as ResourceLocationView;
}

/**
 * Current positions only: superseded rows are history and are never rendered.
 * Expired temporary positions are still returned so the board can show them as
 * expired rather than silently dropping a resource off the picture.
 */
export async function listResourceLocations(
  token: string | null | undefined,
  orgId: string | null,
  filter: { incidentId?: string | null; kind?: string | null } = {},
  meta?: RequestMeta,
): Promise<ResourceLocationView[]> {
  const incidentId = filter.incidentId ? assertUuid(filter.incidentId, "incident id") : null;
  const kind = filter.kind ? assertOneOf(filter.kind, LOCATION_KINDS, "location kind") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.read",
      action: "map.locations.list",
      resourceType: "resource_location",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<RawGeoRow>(
        `SELECT ${LOCATION_SELECT} ${LOCATION_FROM}
          WHERE l.superseded_at IS NULL
            AND ($2::uuid IS NULL OR l.incident_id = $2)
            AND ($3::text IS NULL OR l.location_kind = $3)
          ORDER BY l.reported_at DESC`,
        [ctx.orgId, incidentId, kind],
      );
      return rows.map(toLocation);
    },
  );
}


/**
 * Current locations for resources actively committed to one incident room.
 * A partner resource is returned only through that room's live resource share,
 * and its geography is reduced using that exact share's disclosure profile.
 */
export async function listIncidentResourceLocations(
  token: string | null | undefined,
  orgId: string | null,
  incidentId: string,
  meta?: RequestMeta,
): Promise<ResourceLocationView[]> {
  const inc = assertUuid(incidentId, "incident id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.read",
      action: "map.incident_resource_locations.list",
      resourceType: "resource_location",
      resourceId: inc,
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<RawGeoRow>(
        `SELECT ${LOCATION_SELECT}
           FROM airs.resource_locations l
           JOIN airs.resources r ON r.id = l.resource_id
           JOIN airs.incident_assignments a
             ON a.resource_id = l.resource_id AND a.incident_id = $2
           JOIN airs.incident_rooms ir ON ir.id = a.incident_id
           LEFT JOIN airs.resource_shares s
             ON s.resource_id = l.resource_id AND s.incident_id = a.incident_id
           CROSS JOIN LATERAL (
             SELECT CASE WHEN l.org_id = $1 THEN 'full'
                         ELSE COALESCE(s.disclosure_profile, 'summary') END AS profile
           ) e
           CROSS JOIN LATERAL (
             SELECT airs.resolve_precision(l.precision_policy, e.profile, l.org_id = $1) AS policy
           ) p
          WHERE l.superseded_at IS NULL
            AND a.assignment_type = 'resource'
            AND a.status IN ('proposed','assigned','deploying','active')
            AND (
              a.org_id = $1
              OR (
                s.id IS NOT NULL
                AND s.org_id <> $1
                AND s.revoked_at IS NULL
                AND (s.expires_at IS NULL OR s.expires_at > now())
                AND s.classification <> 'originating_org_only'
                AND (s.classification <> 'named_recipients'
                     OR $1 = ANY (s.named_recipient_org_ids))
                AND ir.status NOT IN ('closed','archived')
                AND airs.has_incident_access(a.incident_id)
              )
            )
          ORDER BY l.reported_at DESC`,
        [ctx.orgId, inc],
      );
      return rows.map(toLocation);
    },
  );
}

// --- writes -------------------------------------------------------------------

/** Confirms the active organization owns a room before it may place geography in it. */
async function assertOwnsRoom(ctx: AuthorizedContext, q: QueryRunner, incidentId: string) {
  const rows = await q.query<{ orgId: string; status: string }>(
    `SELECT org_id AS "orgId", status FROM airs.incident_rooms WHERE id = $1`,
    [incidentId],
  );
  const room = rows[0];
  if (!room) throw new AccessError("incident_not_found");
  if (room.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
  if (room.status === "closed" || room.status === "archived") {
    throw new AccessError("incident_closed");
  }
  return room;
}

export interface CreateMapFeatureInput {
  incidentId?: string | null;
  featureType: string;
  name: string;
  description?: string | null;
  geometry: unknown;
  classification?: string | null;
  precisionPolicy?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export async function createMapFeature(
  token: string | null | undefined,
  orgId: string | null,
  input: CreateMapFeatureInput,
  meta?: RequestMeta,
): Promise<MapFeatureView> {
  const featureType = assertOneOf(input.featureType, MAP_FEATURE_TYPES, "feature type");
  const name = text(input.name, "name", 160, true) as string;
  const description = text(input.description, "description", 2000) ?? "";
  const geometry = geometryOrThrow(input.geometry, "any");
  const classification = input.classification
    ? assertOneOf(input.classification, CLASSIFICATIONS, "classification")
    : "originating_org_only";
  const precision = assertPrecision(input.precisionPolicy, "approximate");
  const incidentId = input.incidentId ? assertUuid(input.incidentId, "incident id") : null;
  const effectiveFrom = timestamp(input.effectiveFrom, "effective from");
  const effectiveTo = timestamp(input.effectiveTo, "effective to");

  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.feature.manage",
      action: "map.feature.created",
      resourceType: "map_feature",
      detail: { featureType, incidentId, precision, classification },
      meta,
    },
    async (ctx, q) => {
      if (incidentId) await assertOwnsRoom(ctx, q, incidentId);
      const rows = await q.query<{ id: string }>(
        `INSERT INTO airs.map_features
           (org_id, incident_id, feature_type, name, description, geom, classification,
            precision_policy, effective_from, effective_to, created_by_account, updated_by_account)
         VALUES ($1,$2,$3,$4,$5,
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($6), 4326),
                 $7,$8,$9,$10,$11,$11)
         RETURNING id`,
        [
          ctx.orgId,
          incidentId,
          featureType,
          name,
          description,
          JSON.stringify(geometry),
          classification,
          precision,
          effectiveFrom,
          effectiveTo,
          ctx.accountId,
        ],
      );
      return readFeature(q, ctx.orgId, rows[0]!.id);
    },
  );
}

async function readFeature(q: QueryRunner, orgId: string, id: string): Promise<MapFeatureView> {
  const rows = await q.query<RawGeoRow>(
    `SELECT ${FEATURE_SELECT} ${FEATURE_FROM} WHERE f.id = $2`,
    [orgId, id],
  );
  if (!rows[0]) throw new AccessError("map_feature_not_found");
  return toFeature(rows[0]);
}

export async function updateMapFeature(
  token: string | null | undefined,
  orgId: string | null,
  featureId: string,
  input: {
    name?: string | null;
    description?: string | null;
    classification?: string | null;
    expectedVersion: number;
  },
  meta?: RequestMeta,
): Promise<MapFeatureView> {
  const id = assertUuid(featureId, "feature id");
  const name = text(input.name, "name", 160);
  const description = text(input.description, "description", 2000);
  const classification = input.classification
    ? assertOneOf(input.classification, CLASSIFICATIONS, "classification")
    : null;
  const expected = integer(input.expectedVersion, "expected version", 1, 2_000_000_000);

  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.feature.manage",
      action: "map.feature.updated",
      resourceType: "map_feature",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.map_features
            SET name = COALESCE($3, name),
                description = COALESCE($4, description),
                classification = COALESCE($5, classification),
                updated_by_account = $6,
                version = version + 1
          WHERE id = $2 AND org_id = $1 AND version = $7 AND status = 'active'
        RETURNING id`,
        [ctx.orgId, id, name, description, classification, ctx.accountId, expected],
      );
      if (!rows[0]) throw new AccessError("version_conflict");
      return readFeature(q, ctx.orgId, id);
    },
  );
}

/** Precision is a separate privilege: widening what partners see is its own act. */
export async function setFeaturePrecision(
  token: string | null | undefined,
  orgId: string | null,
  featureId: string,
  policy: string,
  meta?: RequestMeta,
): Promise<MapFeatureView> {
  const id = assertUuid(featureId, "feature id");
  const precision = assertOneOf(policy, PRECISION_POLICIES, "precision policy");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.precision.manage",
      action: "map.feature.precision_set",
      resourceType: "map_feature",
      resourceId: id,
      detail: { precision },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.map_features SET precision_policy = $3, version = version + 1,
                updated_by_account = $4
          WHERE id = $2 AND org_id = $1 RETURNING id`,
        [ctx.orgId, id, precision, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("map_feature_not_found");
      return readFeature(q, ctx.orgId, id);
    },
  );
}

export async function archiveMapFeature(
  token: string | null | undefined,
  orgId: string | null,
  featureId: string,
  meta?: RequestMeta,
): Promise<{ id: string; status: string }> {
  const id = assertUuid(featureId, "feature id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.feature.manage",
      action: "map.feature.archived",
      resourceType: "map_feature",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string; status: string }>(
        `UPDATE airs.map_features SET status = 'archived', version = version + 1,
                updated_by_account = $3
          WHERE id = $2 AND org_id = $1 AND status = 'active'
        RETURNING id, status`,
        [ctx.orgId, id, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("map_feature_not_found");
      return rows[0];
    },
  );
}

export interface CreateOperatingAreaInput {
  incidentId: string;
  name: string;
  purpose?: string | null;
  area: unknown;
  altitudeFloorFt?: number | null;
  altitudeCeilingFt?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  classification?: string | null;
  precisionPolicy?: string | null;
}

export async function createOperatingArea(
  token: string | null | undefined,
  orgId: string | null,
  input: CreateOperatingAreaInput,
  meta?: RequestMeta,
): Promise<OperatingAreaView> {
  const incidentId = assertUuid(input.incidentId, "incident id");
  const name = text(input.name, "name", 160, true) as string;
  const purpose = text(input.purpose, "purpose", 2000) ?? "";
  const area = geometryOrThrow(input.area, "polygon");
  const floor = integer(input.altitudeFloorFt, "altitude floor", 0, 18000) ?? 0;
  const ceiling = integer(input.altitudeCeilingFt, "altitude ceiling", 0, 18000) ?? 400;
  if (ceiling < floor) throw new AccessError("invalid_altitude_block");
  const startsAt = timestamp(input.startsAt, "start time");
  const endsAt = timestamp(input.endsAt, "end time");
  if (startsAt && endsAt && endsAt <= startsAt) throw new AccessError("invalid_time_window");
  const classification = input.classification
    ? assertOneOf(input.classification, CLASSIFICATIONS, "classification")
    : "participating_orgs";
  const precision = assertPrecision(input.precisionPolicy, "exact");

  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.operating_area.propose",
      action: "map.operating_area.proposed",
      resourceType: "operating_area",
      detail: { incidentId, floor, ceiling, precision, classification },
      meta,
    },
    async (ctx, q) => {
      await assertOwnsRoom(ctx, q, incidentId);
      const rows = await q.query<{ id: string }>(
        `INSERT INTO airs.operating_areas
           (org_id, incident_id, name, purpose, area, altitude_floor_ft, altitude_ceiling_ft,
            starts_at, ends_at, classification, precision_policy, created_by_account)
         VALUES ($1,$2,$3,$4,
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($5), 4326),
                 $6,$7, COALESCE($8::timestamptz, now()), $9,$10,$11,$12)
         RETURNING id`,
        [
          ctx.orgId,
          incidentId,
          name,
          purpose,
          JSON.stringify(area),
          floor,
          ceiling,
          startsAt,
          endsAt,
          classification,
          precision,
          ctx.accountId,
        ],
      );
      return readArea(q, ctx.orgId, rows[0]!.id);
    },
  );
}

async function readArea(q: QueryRunner, orgId: string, id: string): Promise<OperatingAreaView> {
  const rows = await q.query<RawGeoRow>(`SELECT ${AREA_SELECT} ${AREA_FROM} WHERE a.id = $2`, [
    orgId,
    id,
  ]);
  if (!rows[0]) throw new AccessError("operating_area_not_found");
  return toArea(rows[0]);
}

/**
 * Approval is a distinct permission from proposal: an agency may let dispatch
 * draft an operating volume without letting it authorize one.
 */
export async function setOperatingAreaStatus(
  token: string | null | undefined,
  orgId: string | null,
  areaId: string,
  status: string,
  expectedVersion: number,
  meta?: RequestMeta,
): Promise<OperatingAreaView> {
  const id = assertUuid(areaId, "operating area id");
  const next = assertOneOf(status, OPERATING_AREA_STATUSES, "operating area status");
  if (next === "proposed") throw new AccessError("operating_area_state_invalid");
  const expected = integer(expectedVersion, "expected version", 1, 2_000_000_000);
  const needsApproval = next === "approved" || next === "active";

  return withAuthorized(
    {
      token,
      orgId,
      permission: needsApproval ? "map.operating_area.approve" : "map.operating_area.propose",
      action: `map.operating_area.${next}`,
      resourceType: "operating_area",
      resourceId: id,
      detail: { status: next },
      meta,
    },
    async (ctx, q) => {
      const current = await q.query<{ status: string; version: number; orgId: string }>(
        `SELECT status, version, org_id AS "orgId" FROM airs.operating_areas WHERE id = $1`,
        [id],
      );
      const row = current[0];
      if (!row) throw new AccessError("operating_area_not_found");
      if (row.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
      if ((TERMINAL as readonly string[]).includes(row.status)) {
        throw new AccessError("operating_area_state_invalid");
      }
      if (Number(row.version) !== expected) throw new AccessError("version_conflict");

      const approve = needsApproval;
      const updated = await q.query<{ id: string }>(
        `UPDATE airs.operating_areas
            SET status = $3,
                approved_at = CASE WHEN $4 THEN COALESCE(approved_at, now()) ELSE approved_at END,
                approved_by_account = CASE WHEN $4 THEN COALESCE(approved_by_account, $5)
                                           ELSE approved_by_account END,
                version = version + 1
          WHERE id = $2 AND org_id = $1 AND version = $6
        RETURNING id`,
        [ctx.orgId, id, next, approve, ctx.accountId, expected],
      );
      if (!updated[0]) throw new AccessError("version_conflict");
      return readArea(q, ctx.orgId, id);
    },
  );
}

export async function setOperatingAreaPrecision(
  token: string | null | undefined,
  orgId: string | null,
  areaId: string,
  policy: string,
  meta?: RequestMeta,
): Promise<OperatingAreaView> {
  const id = assertUuid(areaId, "operating area id");
  const precision = assertOneOf(policy, PRECISION_POLICIES, "precision policy");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.precision.manage",
      action: "map.operating_area.precision_set",
      resourceType: "operating_area",
      resourceId: id,
      detail: { precision },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.operating_areas SET precision_policy = $3, version = version + 1
          WHERE id = $2 AND org_id = $1 RETURNING id`,
        [ctx.orgId, id, precision],
      );
      if (!rows[0]) throw new AccessError("operating_area_not_found");
      return readArea(q, ctx.orgId, id);
    },
  );
}

export interface ReportLocationInput {
  resourceId: string;
  locationKind: string;
  point: unknown;
  incidentId?: string | null;
  altitudeFt?: number | null;
  accuracyMeters?: number | null;
  positionSource?: string | null;
  note?: string | null;
  precisionPolicy?: string | null;
  /** Hours the temporary position stays current. Fixed sites never expire. */
  validForHours?: number | null;
}

/**
 * Records a MANUAL position. There is no telemetry, tracking feed or automatic
 * update in this stage: a position is a dated operator statement, it supersedes
 * the previous one rather than editing it, and it ages visibly.
 */
export async function reportResourceLocation(
  token: string | null | undefined,
  orgId: string | null,
  input: ReportLocationInput,
  meta?: RequestMeta,
): Promise<ResourceLocationView> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  const kind = assertOneOf(input.locationKind, LOCATION_KINDS, "location kind");
  const point = geometryOrThrow(input.point, "point");
  const incidentId =
    kind === "temporary" && input.incidentId ? assertUuid(input.incidentId, "incident id") : null;
  const altitudeFt = integer(input.altitudeFt, "altitude", -1000, 18000);
  const accuracyMeters = integer(input.accuracyMeters, "accuracy", 0, 100000);
  const source = input.positionSource
    ? assertOneOf(input.positionSource, POSITION_SOURCES, "position source")
    : "manual";
  const note = text(input.note, "note", 1000) ?? "";
  const precision = assertPrecision(input.precisionPolicy, "approximate");
  const validForHours =
    kind === "temporary" ? (integer(input.validForHours, "validity", 1, 72) ?? 4) : null;

  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.position.report",
      action: "map.location.reported",
      resourceType: "resource_location",
      resourceId,
      detail: { locationKind: kind, positionSource: source, precision, validForHours },
      meta,
    },
    async (ctx, q) => {
      const owner = await q.query<{ orgId: string; lifecycle: string }>(
        `SELECT org_id AS "orgId", lifecycle_status AS lifecycle
           FROM airs.resources WHERE id = $1`,
        [resourceId],
      );
      const res = owner[0];
      if (!res) throw new AccessError("resource_not_found");
      if (res.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
      if (res.lifecycle === "retired") throw new AccessError("resource_retired");
      if (incidentId) await assertOwnsRoom(ctx, q, incidentId);

      // A new report supersedes the previous current one of the same kind; the
      // old row is retained as evidence, never deleted or rewritten.
      await q.query(
        `UPDATE airs.resource_locations SET superseded_at = now()
          WHERE resource_id = $1 AND org_id = $2 AND location_kind = $3 AND superseded_at IS NULL`,
        [resourceId, ctx.orgId, kind],
      );

      const rows = await q.query<{ id: string }>(
        `INSERT INTO airs.resource_locations
           (org_id, resource_id, incident_id, location_kind, geom, altitude_ft, accuracy_meters,
            position_source, note, precision_policy, reported_at, expires_at, reported_by_account)
         VALUES ($1,$2,$3,$4,
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($5), 4326),
                 $6,$7,$8,$9,$10, now(),
                 CASE WHEN $11::int IS NULL THEN NULL ELSE now() + ($11 || ' hours')::interval END,
                 $12)
         RETURNING id`,
        [
          ctx.orgId,
          resourceId,
          incidentId,
          kind,
          JSON.stringify(point),
          altitudeFt,
          accuracyMeters,
          source,
          note,
          precision,
          validForHours,
          ctx.accountId,
        ],
      );
      const view = await q.query<RawGeoRow>(
        `SELECT ${LOCATION_SELECT} ${LOCATION_FROM} WHERE l.id = $2`,
        [ctx.orgId, rows[0]!.id],
      );
      if (!view[0]) throw new AccessError("resource_not_found");
      return toLocation(view[0]);
    },
  );
}

/** Removes a resource from the picture without deleting the position history. */
export async function clearResourceLocation(
  token: string | null | undefined,
  orgId: string | null,
  locationId: string,
  meta?: RequestMeta,
): Promise<{ id: string }> {
  const id = assertUuid(locationId, "location id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "map.position.report",
      action: "map.location.cleared",
      resourceType: "resource_location",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.resource_locations SET superseded_at = now()
          WHERE id = $2 AND org_id = $1 AND superseded_at IS NULL RETURNING id`,
        [ctx.orgId, id],
      );
      if (!rows[0]) throw new AccessError("resource_not_found");
      return rows[0];
    },
  );
}
