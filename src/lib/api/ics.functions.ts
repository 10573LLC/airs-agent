import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };
const uuid = z.string().uuid();
const orgId = uuid.nullish();

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try { return { ok: true, data: await run() }; }
  catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("ICS operation failed", error);
    return { ok: false, code: "internal_error" };
  }
}

async function serverCtx() {
  const [{ readSessionToken }, { getRequestHeader, getRequestIP }] = await Promise.all([
    import("./session-cookie.server"), import("@tanstack/react-start/server"),
  ]);
  return { token: readSessionToken(), meta: { ipAddress: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequestHeader("user-agent") ?? null } };
}
const svc = () => import("@/lib/incidents/ics.server");
export const readIcsBoardFn = createServerFn({ method: "GET" })
  .validator((d: { incidentId: string; orgId?: string | null }) => z.object({ incidentId: uuid, orgId }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { readIcsBoard } = await svc(); const { token, meta } = await serverCtx();
    return readIcsBoard(token, data.orgId ?? null, data.incidentId, meta);
  }));

export const saveIcsProfileFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, commandMode: z.enum(["single","unified"]), incidentCommander: z.string().max(200).optional(),
    commandPostName: z.string().max(200).optional(), commandPostDescription: z.string().max(500).optional(),
    operationalPeriodStart: z.string().max(64).nullish(), operationalPeriodEnd: z.string().max(64).nullish(),
    situationSummary: z.string().max(4000).optional(), safetyMessage: z.string().max(2000).optional(),
    operationalCondition: z.enum(["nominal","elevated","emergency","recovery"]).optional(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { saveIcsProfile } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data;
    return saveIcsProfile(token, orgId ?? null, incidentId, input, meta);
  }));
export const addIcsObjectiveFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, sequenceNo: z.number().int().min(1).max(999).optional(), objective: z.string().min(1).max(1000), operationalPeriodLabel: z.string().max(120).nullish() }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addIcsObjective } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data; return addIcsObjective(token, orgId ?? null, incidentId, input, meta);
  }));

export const setIcsObjectiveStatusFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, objectiveId: uuid, status: z.enum(["active","completed","cancelled"]) }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setIcsObjectiveStatus } = await svc(); const { token, meta } = await serverCtx();
    return setIcsObjectiveStatus(token, data.orgId ?? null, data.incidentId, { objectiveId: data.objectiveId, status: data.status }, meta);
  }));

export const addIcsPositionFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, parentId: uuid.nullish(), positionType: z.enum(["incident_command","command_staff","operations","planning","logistics","finance_admin","branch","division","group","unit","staging_area","other"]), label: z.string().min(1).max(160), leaderName: z.string().max(200).optional(), agencyName: z.string().max(200).optional() }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addIcsPosition } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data; return addIcsPosition(token, orgId ?? null, incidentId, input, meta);
  }));
export const setIcsPositionStatusFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, positionId: uuid, status: z.enum(["active","inactive","completed"]) }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setIcsPositionStatus } = await svc(); const { token, meta } = await serverCtx();
    return setIcsPositionStatus(token, data.orgId ?? null, data.incidentId, { positionId: data.positionId, status: data.status }, meta);
  }));

export const addIncidentResourceRequestFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, requestedBy: z.string().max(200).optional(), requestedFrom: z.string().max(200).optional(),
    resourceKind: z.enum(["personnel","law_enforcement","fire_ems","aviation","uas","counter_uas","communications","public_works","medical","logistics","specialty_team","other"]),
    quantity: z.number().int().min(1).max(9999).optional(), description: z.string().min(1).max(1500),
    priority: z.enum(["immediate","high","routine"]).optional(), neededAt: z.string().max(64).nullish(),
    stagingLocation: z.string().max(300).optional(), notes: z.string().max(1500).optional(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addIncidentResourceRequest } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data; return addIncidentResourceRequest(token, orgId ?? null, incidentId, input, meta);
  }));

export const setIncidentResourceRequestStatusFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, requestId: uuid, status: z.enum(["draft","requested","acknowledged","partially_filled","filled","denied","cancelled"]) }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setIncidentResourceRequestStatus } = await svc(); const { token, meta } = await serverCtx();
    return setIncidentResourceRequestStatus(token, data.orgId ?? null, data.incidentId, { requestId: data.requestId, status: data.status }, meta);
  }));


export const addCoordinationPartnerFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, partnerOrgId: uuid.nullish(), organizationName: z.string().min(1).max(240),
    operationalRole: z.string().max(500).optional(), commandPostRole: z.string().max(300).optional(),
    informationPath: z.enum(["system_integration","command_post_liaison","dispatch","radio","phone","email","manual_entry","mutual_aid_coordination","other"]).optional(),
    participationState: z.enum(["planned","invited","confirmed","on_scene","active","released","cancelled"]).optional(),
    primaryContact: z.string().max(240).optional(), notes: z.string().max(2000).optional(),
    plannedFrom: z.string().max(64).nullish(), plannedTo: z.string().max(64).nullish(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addCoordinationPartner } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data;
    return addCoordinationPartner(token, orgId ?? null, incidentId, input, meta);
  }));

export const setCoordinationPartnerStateFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, coordinationPartnerId: uuid,
    participationState: z.enum(["planned","invited","confirmed","on_scene","active","released","cancelled"]),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setCoordinationPartnerState } = await svc(); const { token, meta } = await serverCtx();
    return setCoordinationPartnerState(token, data.orgId ?? null, data.incidentId,
      { coordinationPartnerId: data.coordinationPartnerId, participationState: data.participationState }, meta);
  }));

export const addIncidentAuthorityFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, domain: z.string().min(2).max(160), authorityHolder: z.string().min(2).max(240),
    authorityType: z.enum(["jurisdictional","regulatory","functional","command","investigative","protective","delegated","supporting"]),
    geographicScope: z.string().max(1000).optional(), functionalScope: z.string().max(1000).optional(),
    basisType: z.enum(["baseline","incident_confirmed","claimed","delegated","unresolved"]).optional(),
    basisReference: z.string().max(1200).optional(), sourceReference: z.string().max(1200).optional(),
    limitations: z.string().max(2000).optional(), confidence: z.enum(["confirmed","probable","reported","unresolved"]).optional(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addIncidentAuthority } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data; return addIncidentAuthority(token, orgId ?? null, incidentId, input, meta);
  }));

export const setIncidentAuthorityStatusFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({ incidentId: uuid, orgId, authorityId: uuid, status: z.enum(["active","disputed","superseded","ended"]) }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setIncidentAuthorityStatus } = await svc(); const { token, meta } = await serverCtx();
    return setIncidentAuthorityStatus(token, data.orgId ?? null, data.incidentId, { authorityId: data.authorityId, status: data.status }, meta);
  }));

export const addThreatHypothesisFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId,
    hypothesisType: z.enum(["secondary_assault","follow_on_uas","responder_targeting","coordinated_attack","explosive_hazard","cbrne","other"]),
    title: z.string().min(2).max(240), confidence: z.enum(["unknown","low","medium","high"]).optional(),
    rationale: z.string().max(3000).optional(), indicators: z.array(z.string().min(1).max(300)).max(20).optional(),
    protectiveImplications: z.string().max(3000).optional(), sourceBasis: z.string().max(1600).optional(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { addThreatHypothesis } = await svc(); const { token, meta } = await serverCtx();
    const { incidentId, orgId, ...input } = data; return addThreatHypothesis(token, orgId ?? null, incidentId, input, meta);
  }));

export const setThreatHypothesisStatusFn = createServerFn({ method: "POST" })
  .validator((d: any) => z.object({
    incidentId: uuid, orgId, hypothesisId: uuid,
    status: z.enum(["open","supported","reduced","ruled_out","confirmed"]),
    confidence: z.enum(["unknown","low","medium","high"]).optional(),
  }).parse(d))
  .handler(async ({ data }) => guard(async () => {
    const { setThreatHypothesisStatus } = await svc(); const { token, meta } = await serverCtx();
    return setThreatHypothesisStatus(token, data.orgId ?? null, data.incidentId,
      { hypothesisId: data.hypothesisId, status: data.status, confidence: data.confidence }, meta);
  }));
