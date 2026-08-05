// Awareness transport layer (Stage 8). Every function resolves the session
// cookie server-side and delegates to the observation services, which run the
// full chain: session -> membership -> role permission -> ownership ->
// validation -> forced RLS -> field disclosure -> geographic precision ->
// audit event.
//
// The browser supplies ids and validated fields only: never an owner id, an
// effective disclosure profile, an effective precision, a freshness value, a
// relationship or an access outcome.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const orgIdField = uuid.nullish();
const iso = z.string().min(4).max(64).nullish();
const shortText = z.string().max(240).nullish();
const longText = z.string().max(8000).nullish();
const precision = z.enum(["withheld", "area_only", "generalized", "approximate", "exact"]).nullish();
const profile = z.enum(["summary", "operational", "aviation", "incident_command", "full"]).nullish();

const position = z.tuple([z.number(), z.number()]);
const geometry = z
  .union([
    z.object({ type: z.literal("Point"), coordinates: position }),
    z.object({ type: z.literal("LineString"), coordinates: z.array(position).min(2).max(512) }),
    z.object({
      type: z.literal("Polygon"),
      coordinates: z.array(z.array(position).min(4).max(512)).min(1).max(8),
    }),
  ])
  .nullish();

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("awareness operation failed", error);
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

const svc = () => import("@/lib/awareness/awareness.server");

const observationBody = z.object({
  incidentId: uuid.nullish(),
  observationType: z.string().max(64),
  title: z.string().min(1).max(160),
  description: longText,
  observedObject: shortText,
  observedBehavior: z.string().max(1000).nullish(),
  observedCount: z.number().int().min(0).max(1000).nullish(),
  observedAltitudeFt: z.number().int().min(-1000).max(60000).nullish(),
  observedAt: iso,
  observedTimePrecision: z.string().max(32).nullish(),
  locationKind: z.string().max(32).nullish(),
  mapFeatureId: uuid.nullish(),
  operatingAreaId: uuid.nullish(),
  resourceLocationId: uuid.nullish(),
  geometry,
  precisionPolicy: precision,
  sourceType: z.string().max(64),
  sourceDetail: z.string().max(2000).nullish(),
  reporterIdentity: shortText,
  reporterContact: shortText,
  internalNotes: z.string().max(4000).nullish(),
  internalCaseNumber: z.string().max(120).nullish(),
  sourceReliability: z.string().max(32).nullish(),
  informationCredibility: z.string().max(32).nullish(),
  confidenceLevel: z.string().max(32).nullish(),
  urgency: z.string().max(32).nullish(),
  classification: z.string().max(48).nullish(),
  disclosureProfile: profile,
  visibleUntil: iso,
});

// --- reads --------------------------------------------------------------------

export const listObservationsFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid.nullish(),
        observationType: z.string().max(64).nullish(),
        verificationStatus: z.string().max(32).nullish(),
        lifecycleStatus: z.string().max(32).nullish(),
        urgency: z.string().max(32).nullish(),
        sourceType: z.string().max(64).nullish(),
        observedAfter: iso,
        observedBefore: iso,
        includeTerminal: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listObservations } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, ...filter } = data;
      return listObservations(token, orgId ?? null, filter, meta);
    }),
  );

export const getObservationFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ orgId: orgIdField, observationId: uuid }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { getObservation } = await svc();
      const { token, meta } = await serverCtx();
      return getObservation(token, data.orgId ?? null, data.observationId, meta);
    }),
  );

export const awarenessSummaryFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ orgId: orgIdField, incidentId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { awarenessSummary } = await svc();
      const { token, meta } = await serverCtx();
      return awarenessSummary(token, data.orgId ?? null, { incidentId: data.incidentId ?? null }, meta);
    }),
  );

// --- writes -------------------------------------------------------------------

export const createObservationFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => observationBody.extend({ orgId: orgIdField }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { createObservation } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, ...input } = data;
      return createObservation(token, orgId ?? null, input, meta);
    }),
  );

export const updateObservationFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    observationBody
      .extend({
        orgId: orgIdField,
        observationId: uuid,
        expectedVersion: z.number().int().positive().optional(),
        correctionNote: z.string().max(4000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { updateObservation } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return updateObservation(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const setVerificationStatusFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        status: z.string().max(32),
        rationale: z.string().max(4000).nullish(),
        confidenceLevel: z.string().max(32).nullish(),
        expectedVersion: z.number().int().positive().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setVerificationStatus } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return setVerificationStatus(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const setObservationLifecycleFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        status: z.string().max(32),
        note: z.string().max(4000).nullish(),
        expectedVersion: z.number().int().positive().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setLifecycleStatus } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return setLifecycleStatus(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const addObservationAnnotationFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        annotationType: z.string().max(32),
        body: z.string().min(1).max(4000),
        visibility: z.enum(["internal", "shared"]).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { addAnnotation } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return addAnnotation(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const relateObservationsFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        relatedObservationId: uuid,
        relationship: z.string().max(32),
        note: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { relateObservations } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return relateObservations(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const invalidateRelationshipFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ orgId: orgIdField, relationshipId: uuid }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { invalidateRelationship } = await svc();
      const { token, meta } = await serverCtx();
      return invalidateRelationship(token, data.orgId ?? null, data.relationshipId, meta);
    }),
  );

export const addInformationGapFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        gapType: z.string().max(48),
        detail: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { addInformationGap } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return addInformationGap(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const closeInformationGapFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        gapId: uuid,
        status: z.enum(["resolved", "cancelled"]),
        resolutionNote: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { closeInformationGap } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, gapId, ...input } = data;
      return closeInformationGap(token, orgId ?? null, gapId, input, meta);
    }),
  );

export const addEvidenceReferenceFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        referenceType: z.string().max(48),
        displayName: z.string().min(1).max(160),
        description: z.string().max(1000).nullish(),
        referenceValue: z.string().max(240).nullish(),
        classification: z.string().max(48).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { addEvidenceReference } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return addEvidenceReference(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const removeEvidenceReferenceFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ orgId: orgIdField, evidenceId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { removeEvidenceReference } = await svc();
      const { token, meta } = await serverCtx();
      return removeEvidenceReference(token, data.orgId ?? null, data.evidenceId, meta);
    }),
  );

export const shareObservationFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        observationId: uuid,
        partnerOrgId: uuid,
        incidentId: uuid.nullish(),
        disclosureProfile: profile,
        precisionPolicy: precision,
        expiresAt: iso,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { shareObservation } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, observationId, ...input } = data;
      return shareObservation(token, orgId ?? null, observationId, input, meta);
    }),
  );

export const revokeObservationShareFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ orgId: orgIdField, shareId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { revokeObservationShare } = await svc();
      const { token, meta } = await serverCtx();
      return revokeObservationShare(token, data.orgId ?? null, data.shareId, meta);
    }),
  );
