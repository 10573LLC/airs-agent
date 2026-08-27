// Common Operating Picture transport layer. Every function resolves the session
// cookie server-side and delegates to the map services, which run the full
// chain: session -> membership -> role permission -> ownership -> geometry
// validation -> forced RLS -> geographic precision -> audit event.
//
// The browser supplies ids, validated fields and GeoJSON only: never an owner
// id, a relationship, an effective precision, a freshness value or an access
// outcome. Precision is decided and applied in the database.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const orgIdField = uuid.nullish();
const name = z.string().min(1).max(160);
const note = z.string().max(2000).nullish();
const iso = z.string().min(4).max(64).nullish();
const precision = z
  .enum(["withheld", "area_only", "generalized", "approximate", "exact"])
  .nullish();

// GeoJSON is accepted structurally here and re-validated coordinate by
// coordinate in the service layer, then again by PostGIS.
const position = z.tuple([z.number(), z.number()]);
const geometry = z.union([
  z.object({ type: z.literal("Point"), coordinates: position }),
  z.object({ type: z.literal("LineString"), coordinates: z.array(position).min(2).max(512) }),
  z.object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(position).min(4).max(512)).min(1).max(8),
  }),
]);
const polygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(position).min(4).max(512)).min(1).max(8),
});
const point = z.object({ type: z.literal("Point"), coordinates: position });

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("map operation failed", error);
    return { ok: false, code: "internal_error" };
  }
}

async function serverCtx() {
  const [{ readSessionToken }, { getRequestHeader, getRequestIP }] = await Promise.all([
    import("./session-cookie.server"),
    import("@tanstack/react-start/server"),
  ]);
  return {
    token: readSessionToken(),
    meta: {
      ipAddress: getRequestIP({ xForwardedFor: true }) ?? null,
      userAgent: getRequestHeader("user-agent") ?? null,
    },
  };
}

const map = () => import("@/lib/map/map.server");

// --- reads --------------------------------------------------------------------

export const listMapFeaturesFn = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid.nullish(),
        includeArchived: z.boolean().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listMapFeatures } = await map();
      const { token, meta } = await serverCtx();
      return listMapFeatures(
        token,
        data.orgId ?? null,
        { incidentId: data.incidentId ?? null, includeArchived: data.includeArchived === true },
        meta,
      );
    }),
  );

export const listOperatingAreasFn = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid.nullish(),
        includeTerminal: z.boolean().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listOperatingAreas } = await map();
      const { token, meta } = await serverCtx();
      return listOperatingAreas(
        token,
        data.orgId ?? null,
        { incidentId: data.incidentId ?? null, includeTerminal: data.includeTerminal === true },
        meta,
      );
    }),
  );

export const listResourceLocationsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid.nullish(),
        kind: z.enum(["fixed", "temporary"]).nullish(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listResourceLocations } = await map();
      const { token, meta } = await serverCtx();
      return listResourceLocations(
        token,
        data.orgId ?? null,
        { incidentId: data.incidentId ?? null, kind: data.kind ?? null },
        meta,
      );
    }),
  );


export const listIncidentResourceLocationsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) =>
    z.object({ orgId: orgIdField, incidentId: uuid }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listIncidentResourceLocations } = await map();
      const { token, meta } = await serverCtx();
      return listIncidentResourceLocations(token, data.orgId ?? null, data.incidentId, meta);
    }),
  );

// --- map features -------------------------------------------------------------

export const createMapFeatureFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid.nullish(),
        featureType: z.string().min(2).max(40),
        name,
        description: note,
        geometry,
        classification: z.string().max(40).nullish(),
        precisionPolicy: precision,
        effectiveFrom: iso,
        effectiveTo: iso,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { createMapFeature } = await map();
      const { token, meta } = await serverCtx();
      return createMapFeature(token, data.orgId ?? null, data, meta);
    }),
  );

export const updateMapFeatureFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        featureId: uuid,
        name: name.nullish(),
        description: note,
        classification: z.string().max(40).nullish(),
        expectedVersion: z.number().int().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { updateMapFeature } = await map();
      const { token, meta } = await serverCtx();
      return updateMapFeature(token, data.orgId ?? null, data.featureId, data, meta);
    }),
  );

export const setFeaturePrecisionFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        featureId: uuid,
        precisionPolicy: z.enum(["withheld", "area_only", "generalized", "approximate", "exact"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setFeaturePrecision } = await map();
      const { token, meta } = await serverCtx();
      return setFeaturePrecision(
        token,
        data.orgId ?? null,
        data.featureId,
        data.precisionPolicy,
        meta,
      );
    }),
  );

export const archiveMapFeatureFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ orgId: orgIdField, featureId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { archiveMapFeature } = await map();
      const { token, meta } = await serverCtx();
      return archiveMapFeature(token, data.orgId ?? null, data.featureId, meta);
    }),
  );

// --- operating areas ----------------------------------------------------------

export const createOperatingAreaFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid,
        name,
        purpose: note,
        area: polygon,
        altitudeFloorFt: z.number().int().min(0).max(18000).nullish(),
        altitudeCeilingFt: z.number().int().min(0).max(18000).nullish(),
        startsAt: iso,
        endsAt: iso,
        classification: z.string().max(40).nullish(),
        precisionPolicy: precision,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { createOperatingArea } = await map();
      const { token, meta } = await serverCtx();
      return createOperatingArea(token, data.orgId ?? null, data, meta);
    }),
  );

export const setOperatingAreaStatusFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        areaId: uuid,
        status: z.enum(["approved", "active", "suspended", "completed", "cancelled"]),
        expectedVersion: z.number().int().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setOperatingAreaStatus } = await map();
      const { token, meta } = await serverCtx();
      return setOperatingAreaStatus(
        token,
        data.orgId ?? null,
        data.areaId,
        data.status,
        data.expectedVersion,
        meta,
      );
    }),
  );

export const setOperatingAreaPrecisionFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        areaId: uuid,
        precisionPolicy: z.enum(["withheld", "area_only", "generalized", "approximate", "exact"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setOperatingAreaPrecision } = await map();
      const { token, meta } = await serverCtx();
      return setOperatingAreaPrecision(
        token,
        data.orgId ?? null,
        data.areaId,
        data.precisionPolicy,
        meta,
      );
    }),
  );

// --- positions ----------------------------------------------------------------

export const reportResourceLocationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        locationKind: z.enum(["fixed", "temporary"]),
        point,
        incidentId: uuid.nullish(),
        altitudeFt: z.number().int().min(-1000).max(18000).nullish(),
        accuracyMeters: z.number().int().min(0).max(100000).nullish(),
        positionSource: z.enum(["manual", "planned", "last_known"]).nullish(),
        note: z.string().max(1000).nullish(),
        precisionPolicy: precision,
        validForHours: z.number().int().min(1).max(72).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { reportResourceLocation } = await map();
      const { token, meta } = await serverCtx();
      return reportResourceLocation(token, data.orgId ?? null, data, meta);
    }),
  );

export const clearResourceLocationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ orgId: orgIdField, locationId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { clearResourceLocation } = await map();
      const { token, meta } = await serverCtx();
      return clearResourceLocation(token, data.orgId ?? null, data.locationId, meta);
    }),
  );
