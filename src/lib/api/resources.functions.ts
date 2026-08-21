// Operational Resource Registry transport layer. Every function resolves the
// session cookie server-side and delegates to the resource services, which run
// the full chain: session -> membership -> role permission -> ownership
// -> lifecycle rule -> forced RLS -> audit event.
//
// The browser supplies ids and validated fields only: never an owner id, a
// relationship, a classification decision or an access outcome.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const orgIdField = uuid.nullish();
const name = z.string().min(1).max(160);
const note = z.string().max(2000).nullish();
const shortText = z.string().max(160).nullish();
const iso = z.string().min(4).max(64).nullish();
// A profile key is the ONLY disclosure input the browser may send. Field names
// are never accepted from a request except as keys of the server-side
// vocabulary, and those are re-validated in the service layer.
const disclosureProfile = z
  .enum(["summary", "operational", "aviation", "incident_command", "full", "custom"])
  .nullish();
const customFieldKeys = z.array(z.string().max(64)).max(64).nullish();

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("resource operation failed", error);
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

const res = () => import("@/lib/resources/resources.server");
const people = () => import("@/lib/resources/personnel.server");
const assign = () => import("@/lib/resources/assignments.server");

// --- registry reads -----------------------------------------------------------

export const listResourcesFn = createServerFn({ method: "GET" })
  .validator(
    (d: { orgId?: string | null; category?: string | null; includeRetired?: boolean }) =>
      z
        .object({
          orgId: orgIdField,
          category: z.string().max(40).nullish(),
          includeRetired: z.boolean().optional(),
        })
        .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listResources } = await res();
      const { token, meta } = await serverCtx();
      return listResources(
        token,
        data.orgId ?? null,
        { category: data.category ?? null, includeRetired: data.includeRetired === true },
        meta,
      );
    }),
  );

export const listSharedResourcesFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null; incidentId?: string | null }) =>
    z.object({ orgId: orgIdField, incidentId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listSharedResources } = await res();
      const { token, meta } = await serverCtx();
      return listSharedResources(token, data.orgId ?? null, data.incidentId ?? null, meta);
    }),
  );

export const readResourceFn = createServerFn({ method: "GET" })
  .validator((d: { resourceId: string; orgId?: string | null }) =>
    z.object({ resourceId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { readResource } = await res();
      const { token, meta } = await serverCtx();
      return readResource(token, data.orgId ?? null, data.resourceId, meta);
    }),
  );

export const readinessSummaryFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { readinessSummary } = await res();
      const { token, meta } = await serverCtx();
      return readinessSummary(token, data.orgId ?? null, meta);
    }),
  );

// --- registry writes ----------------------------------------------------------

const createResourceSchema = z.object({
  orgId: orgIdField,
  category: z.string().min(2).max(40),
  displayName: name,
  callsign: shortText,
  description: note,
  readinessStatus: z.string().max(40).nullish(),
  operationalStatus: z.string().max(40).nullish(),
  sharingClassification: z.string().max(40).nullish(),
  restrictedNotes: note,
});

export const createResourceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => createResourceSchema.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { createResource } = await res();
      const { token, meta } = await serverCtx();
      return createResource(token, data.orgId ?? null, data, meta);
    }),
  );

export const updateResourceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        version: z.number().int().min(1),
        displayName: name.nullish(),
        callsign: shortText,
        description: note,
        operationalStatus: z.string().max(40).nullish(),
        sharingClassification: z.string().max(40).nullish(),
        restrictedNotes: note,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { updateResource } = await res();
      const { token, meta } = await serverCtx();
      return updateResource(token, data.orgId ?? null, data, meta);
    }),
  );

export const setResourceStatusFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({ orgId: orgIdField, resourceId: uuid, readinessStatus: z.string().min(2).max(40) })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setResourceStatus } = await res();
      const { token, meta } = await serverCtx();
      return setResourceStatus(token, data.orgId ?? null, data, meta);
    }),
  );

export const retireResourceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({ orgId: orgIdField, resourceId: uuid, reason: z.string().max(500).nullish() })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { retireResource } = await res();
      const { token, meta } = await serverCtx();
      return retireResource(token, data.orgId ?? null, data, meta);
    }),
  );

export const restoreResourceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        readinessStatus: z.string().max(40).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { restoreResource } = await res();
      const { token, meta } = await serverCtx();
      return restoreResource(token, data.orgId ?? null, data, meta);
    }),
  );

export const saveResourceDetailFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        detail: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { saveResourceDetail } = await res();
      const { token, meta } = await serverCtx();
      return saveResourceDetail(token, data.orgId ?? null, data, meta);
    }),
  );

// --- sharing ------------------------------------------------------------------

export const shareResourceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        incidentId: uuid,
        classification: z.string().max(40).nullish(),
        expiresAt: iso,
        namedRecipientOrgIds: z.array(uuid).max(50).nullish(),
        disclosureProfile,
        customFieldKeys,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { shareResource } = await res();
      const { token, meta } = await serverCtx();
      return shareResource(token, data.orgId ?? null, data, meta);
    }),
  );

export const setShareDisclosureFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        incidentId: uuid,
        profile: z.enum([
          "summary",
          "operational",
          "aviation",
          "incident_command",
          "full",
          "custom",
        ]),
        customFieldKeys,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setShareDisclosure } = await res();
      const { token, meta } = await serverCtx();
      return setShareDisclosure(token, data.orgId ?? null, data, meta);
    }),
  );

export const revokeResourceShareFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        resourceId: uuid,
        incidentId: uuid,
        reason: z.string().max(500).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { revokeResourceShare } = await res();
      const { token, meta } = await serverCtx();
      return revokeResourceShare(token, data.orgId ?? null, data, meta);
    }),
  );

export const listResourceSharesFn = createServerFn({ method: "GET" })
  .validator((d: { resourceId: string; orgId?: string | null }) =>
    z.object({ resourceId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listResourceShares } = await res();
      const { token, meta } = await serverCtx();
      return listResourceShares(token, data.orgId ?? null, data.resourceId, meta);
    }),
  );

// --- personnel ----------------------------------------------------------------

export const listPersonnelFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listPersonnel } = await people();
      const { token, meta } = await serverCtx();
      return listPersonnel(token, data.orgId ?? null, meta);
    }),
  );

export const listWorkingPersonnelFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listWorkingPersonnel } = await people();
      const { token, meta } = await serverCtx();
      return listWorkingPersonnel(token, data.orgId ?? null, meta);
    }),
  );

export const upsertPersonnelFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        personId: uuid.nullish(),
        userId: uuid.nullish(),
        displayName: name,
        callsign: z.string().max(60).nullish(),
        employeeIdentifier: z.string().max(60).nullish(),
        operationalRoles: z.array(z.string().max(40)).max(12).nullish(),
        availabilityStatus: z.string().max(40).nullish(),
        operationalStatus: z.string().max(40).nullish(),
        qualificationSummary: z.string().max(500).nullish(),
        dutyContact: z.string().max(160).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { upsertPersonnel } = await people();
      const { token, meta } = await serverCtx();
      return upsertPersonnel(token, data.orgId ?? null, data, meta);
    }),
  );

export const setPersonnelAvailabilityFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({ orgId: orgIdField, personId: uuid, availabilityStatus: z.string().min(2).max(40) })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setPersonnelAvailability } = await people();
      const { token, meta } = await serverCtx();
      return setPersonnelAvailability(token, data.orgId ?? null, data, meta);
    }),
  );

// --- qualifications -----------------------------------------------------------

export const listQualificationsFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null; personId?: string | null }) =>
    z.object({ orgId: orgIdField, personId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listQualifications } = await people();
      const { token, meta } = await serverCtx();
      return listQualifications(token, data.orgId ?? null, data.personId ?? null, meta);
    }),
  );

export const addQualificationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        personId: uuid,
        qualificationType: z.string().min(2).max(64),
        issuingOrganization: z.string().max(160).nullish(),
        effectiveDate: z.string().max(10).nullish(),
        expiresOn: z.string().max(10).nullish(),
        restrictions: z.string().max(500).nullish(),
        sharingClassification: z.string().max(40).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { addQualification } = await people();
      const { token, meta } = await serverCtx();
      return addQualification(token, data.orgId ?? null, data, meta);
    }),
  );

export const verifyQualificationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ orgId: orgIdField, qualificationId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { verifyQualification } = await people();
      const { token, meta } = await serverCtx();
      return verifyQualification(token, data.orgId ?? null, data, meta);
    }),
  );

export const revokeQualificationFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({ orgId: orgIdField, qualificationId: uuid, reason: z.string().max(500).nullish() })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { revokeQualification } = await people();
      const { token, meta } = await serverCtx();
      return revokeQualification(token, data.orgId ?? null, data, meta);
    }),
  );

export const processQualificationExpiryFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { processQualificationExpiry } = await people();
      const { token, meta } = await serverCtx();
      return processQualificationExpiry(token, data.orgId ?? null, meta);
    }),
  );

// --- shifts -------------------------------------------------------------------

export const listShiftsFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listShifts } = await people();
      const { token, meta } = await serverCtx();
      return listShifts(token, data.orgId ?? null, meta);
    }),
  );

export const createShiftFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        personId: uuid,
        operationalRole: z.string().min(2).max(40),
        startsAt: z.string().min(4).max(64),
        endsAt: z.string().min(4).max(64),
        availabilityStatus: z.string().max(40).nullish(),
        incidentId: uuid.nullish(),
        notes: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { createShift } = await people();
      const { token, meta } = await serverCtx();
      return createShift(token, data.orgId ?? null, data, meta);
    }),
  );

export const updateShiftFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        shiftId: uuid,
        availabilityStatus: z.string().max(40).nullish(),
        startsAt: iso,
        endsAt: iso,
        notes: z.string().max(1000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { updateShift } = await people();
      const { token, meta } = await serverCtx();
      return updateShift(token, data.orgId ?? null, data, meta);
    }),
  );

// --- incident assignments -----------------------------------------------------

export const listIncidentAssignmentsFn = createServerFn({ method: "GET" })
  .validator((d: { incidentId: string; orgId?: string | null }) =>
    z.object({ incidentId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listIncidentAssignments } = await assign();
      const { token, meta } = await serverCtx();
      return listIncidentAssignments(token, data.orgId ?? null, data.incidentId, meta);
    }),
  );

export const assignToIncidentFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        incidentId: uuid,
        assignmentType: z.enum(["resource", "person"]),
        resourceId: uuid.nullish(),
        personId: uuid.nullish(),
        assignedRole: z.string().max(40).nullish(),
        visibilityClassification: z.string().max(40).nullish(),
        startsAt: iso,
        endsAt: iso,
        disclosureProfile,
        customFieldKeys,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { assignToIncident } = await assign();
      const { token, meta } = await serverCtx();
      return assignToIncident(token, data.orgId ?? null, data, meta);
    }),
  );

export const setAssignmentStatusFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ orgId: orgIdField, assignmentId: uuid, status: z.string().min(2).max(40) }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setAssignmentStatus } = await assign();
      const { token, meta } = await serverCtx();
      return setAssignmentStatus(token, data.orgId ?? null, data, meta);
    }),
  );

export const endAssignmentFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        orgId: orgIdField,
        assignmentId: uuid,
        status: z.enum(["released", "completed", "cancelled"]),
        reason: z.string().max(500).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { endAssignment } = await assign();
      const { token, meta } = await serverCtx();
      return endAssignment(token, data.orgId ?? null, data, meta);
    }),
  );
