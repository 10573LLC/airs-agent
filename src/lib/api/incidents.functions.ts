// Incident Room Lifecycle transport layer. Each function resolves the session
// cookie server-side and delegates to the incident services, which run the
// full chain: session -> membership -> role permission -> incident
// relationship -> incident-level access -> lifecycle rule -> forced RLS.
//
// The browser never supplies an owner id, a participation status or an access
// decision: only ids and the fields the server explicitly validates.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const orgIdField = uuid.nullish();
const iso = z.string().min(4).max(64);
const version = z.number().int().min(1);
const reason = z.string().max(1000).nullish();

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("incident operation failed", error);
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

const svc = () => import("@/lib/incidents/incidents.server");
const part = () => import("@/lib/incidents/participation.server");
const trust = () => import("@/lib/incidents/trust.server");

// --- rooms --------------------------------------------------------------------

export const listIncidentsFn = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listIncidents } = await svc();
      const { token, meta } = await serverCtx();
      return listIncidents(token, data.orgId ?? null, meta);
    }),
  );

export const readIncidentFn = createServerFn({ method: "GET" })
  .inputValidator((d: { incidentId: string; orgId?: string | null }) =>
    z.object({ incidentId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { readIncident } = await svc();
      const { token, meta } = await serverCtx();
      return readIncident(token, data.orgId ?? null, data.incidentId, meta);
    }),
  );

export const createIncidentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      name: string;
      incidentType: string;
      description?: string | null;
      externalNumber?: string | null;
      geographicDescription?: string | null;
      classification?: string | null;
      defaultShareRule?: string | null;
      scheduledStartAt?: string | null;
      scheduledExpiresAt?: string | null;
      tempDataRetentionHours?: number | null;
      orgId?: string | null;
    }) =>
      z
        .object({
          name: z.string().min(1).max(200),
          incidentType: z.string().min(2).max(64),
          description: z.string().max(4000).nullish(),
          externalNumber: z.string().max(120).nullish(),
          geographicDescription: z.string().max(500).nullish(),
          classification: z.string().max(32).nullish(),
          defaultShareRule: z.string().max(32).nullish(),
          scheduledStartAt: iso.nullish(),
          scheduledExpiresAt: iso.nullish(),
          tempDataRetentionHours: z.number().int().min(1).max(8760).nullish(),
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { createIncident } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, ...input } = data;
      return createIncident(token, orgId ?? null, input, meta);
    }),
  );

export const updateIncidentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      incidentId: string;
      expectedVersion: number;
      name?: string | null;
      description?: string | null;
      externalNumber?: string | null;
      geographicDescription?: string | null;
      classification?: string | null;
      defaultShareRule?: string | null;
      tempDataRetentionHours?: number | null;
      orgId?: string | null;
    }) =>
      z
        .object({
          incidentId: uuid,
          expectedVersion: version,
          name: z.string().min(1).max(200).nullish(),
          description: z.string().max(4000).nullish(),
          externalNumber: z.string().max(120).nullish(),
          geographicDescription: z.string().max(500).nullish(),
          classification: z.string().max(32).nullish(),
          defaultShareRule: z.string().max(32).nullish(),
          tempDataRetentionHours: z.number().int().min(1).max(8760).nullish(),
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { updateIncident } = await svc();
      const { token, meta } = await serverCtx();
      const { orgId, incidentId, ...input } = data;
      return updateIncident(token, orgId ?? null, incidentId, input, meta);
    }),
  );

export const scheduleIncidentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      incidentId: string;
      startAt: string;
      expiresAt?: string | null;
      expectedVersion: number;
      orgId?: string | null;
    }) =>
      z
        .object({
          incidentId: uuid,
          startAt: iso,
          expiresAt: iso.nullish(),
          expectedVersion: version,
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { scheduleIncident } = await svc();
      const { token, meta } = await serverCtx();
      return scheduleIncident(
        token,
        data.orgId ?? null,
        data.incidentId,
        {
          startAt: data.startAt,
          expiresAt: data.expiresAt ?? null,
          expectedVersion: data.expectedVersion,
        },
        meta,
      );
    }),
  );

const simpleTransition = z.object({
  incidentId: uuid,
  expectedVersion: version,
  orgId: orgIdField,
});
type SimpleTransition = { incidentId: string; expectedVersion: number; orgId?: string | null };

export const activateIncidentFn = createServerFn({ method: "POST" })
  .inputValidator((d: SimpleTransition) => simpleTransition.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { activateIncident } = await svc();
      const { token, meta } = await serverCtx();
      return activateIncident(
        token,
        data.orgId ?? null,
        data.incidentId,
        data.expectedVersion,
        meta,
      );
    }),
  );

export const pauseIncidentFn = createServerFn({ method: "POST" })
  .inputValidator((d: SimpleTransition) => simpleTransition.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { pauseIncident } = await svc();
      const { token, meta } = await serverCtx();
      return pauseIncident(token, data.orgId ?? null, data.incidentId, data.expectedVersion, meta);
    }),
  );

export const resumeIncidentFn = createServerFn({ method: "POST" })
  .inputValidator((d: SimpleTransition) => simpleTransition.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { resumeIncident } = await svc();
      const { token, meta } = await serverCtx();
      return resumeIncident(token, data.orgId ?? null, data.incidentId, data.expectedVersion, meta);
    }),
  );

export const archiveIncidentFn = createServerFn({ method: "POST" })
  .inputValidator((d: SimpleTransition) => simpleTransition.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { archiveIncident } = await svc();
      const { token, meta } = await serverCtx();
      return archiveIncident(
        token,
        data.orgId ?? null,
        data.incidentId,
        data.expectedVersion,
        meta,
      );
    }),
  );

export const beginClosureFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { incidentId: string; reason: string; expectedVersion: number; orgId?: string | null }) =>
      z
        .object({
          incidentId: uuid,
          reason: z.string().min(1).max(1000),
          expectedVersion: version,
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { beginClosure } = await svc();
      const { token, meta } = await serverCtx();
      return beginClosure(
        token,
        data.orgId ?? null,
        data.incidentId,
        { reason: data.reason, expectedVersion: data.expectedVersion },
        meta,
      );
    }),
  );

export const closeIncidentFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      incidentId: string;
      reason?: string | null;
      expectedVersion: number;
      orgId?: string | null;
    }) =>
      z
        .object({
          incidentId: uuid,
          reason,
          expectedVersion: version,
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { closeIncident } = await svc();
      const { token, meta } = await serverCtx();
      return closeIncident(
        token,
        data.orgId ?? null,
        data.incidentId,
        { reason: data.reason ?? null, expectedVersion: data.expectedVersion },
        meta,
      );
    }),
  );

export const readIncidentAuditFn = createServerFn({ method: "GET" })
  .inputValidator((d: { incidentId: string; orgId?: string | null }) =>
    z.object({ incidentId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { readIncidentAudit } = await svc();
      const { token, meta } = await serverCtx();
      return readIncidentAudit(token, data.orgId ?? null, data.incidentId, meta);
    }),
  );

// --- trusted agencies -----------------------------------------------------------

export const listTrustedAgenciesFn = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listTrustedAgencies } = await trust();
      const { token, meta } = await serverCtx();
      return listTrustedAgencies(token, data.orgId ?? null, meta);
    }),
  );

export const setTrustedAgencyStatusFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { partnerOrgId: string; status: string; note?: string | null; orgId?: string | null }) =>
      z
        .object({
          partnerOrgId: uuid,
          status: z.string().min(2).max(32),
          note: z.string().max(1000).nullish(),
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { setTrustedAgencyStatus } = await trust();
      const { token, meta } = await serverCtx();
      return setTrustedAgencyStatus(
        token,
        data.orgId ?? null,
        { partnerOrgId: data.partnerOrgId, status: data.status, note: data.note ?? null },
        meta,
      );
    }),
  );

// --- participation --------------------------------------------------------------

export const listParticipantsFn = createServerFn({ method: "GET" })
  .inputValidator((d: { incidentId: string; orgId?: string | null }) =>
    z.object({ incidentId: uuid, orgId: orgIdField }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listParticipants } = await part();
      const { token, meta } = await serverCtx();
      return listParticipants(token, data.orgId ?? null, data.incidentId, meta);
    }),
  );

export const invitePartnerFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      incidentId: string;
      partnerOrgId: string;
      accessLevel: string;
      invitationExpiresAt: string;
      participationExpiresAt?: string | null;
      requiresApproval?: boolean;
      reason?: string | null;
      orgId?: string | null;
    }) =>
      z
        .object({
          incidentId: uuid,
          partnerOrgId: uuid,
          accessLevel: z.string().min(2).max(32),
          invitationExpiresAt: iso,
          participationExpiresAt: iso.nullish(),
          requiresApproval: z.boolean().optional(),
          reason,
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { invitePartner } = await part();
      const { token, meta } = await serverCtx();
      const { orgId, incidentId, ...input } = data;
      return invitePartner(
        token,
        orgId ?? null,
        incidentId,
        {
          partnerOrgId: input.partnerOrgId,
          accessLevel: input.accessLevel,
          invitationExpiresAt: input.invitationExpiresAt,
          participationExpiresAt: input.participationExpiresAt ?? null,
          requiresApproval: input.requiresApproval,
          reason: input.reason ?? null,
        },
        meta,
      );
    }),
  );

export const ownerParticipantActionFn = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      incidentId: string;
      participantId: string;
      action: string;
      reason?: string | null;
      orgId?: string | null;
    }) =>
      z
        .object({
          incidentId: uuid,
          participantId: uuid,
          action: z.enum([
            "revoke_invitation",
            "approve_partner",
            "restrict_partner",
            "revoke_partner",
            "remove_partner",
          ]),
          reason,
          orgId: orgIdField,
        })
        .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { ownerParticipantAction } = await part();
      const { token, meta } = await serverCtx();
      return ownerParticipantAction(
        token,
        data.orgId ?? null,
        data.incidentId,
        data.participantId,
        data.action,
        meta,
        data.reason ?? null,
      );
    }),
  );

export const listPendingInvitationsFn = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { listPendingInvitations } = await part();
      const { token, meta } = await serverCtx();
      return listPendingInvitations(token, data.orgId ?? null, meta);
    }),
  );

export const partnerParticipationActionFn = createServerFn({ method: "POST" })
  .inputValidator((d: { participantId: string; action: string; orgId?: string | null }) =>
    z
      .object({
        participantId: uuid,
        action: z.enum(["accept", "decline", "withdraw"]),
        orgId: orgIdField,
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { partnerParticipationAction } = await part();
      const { token, meta } = await serverCtx();
      return partnerParticipationAction(
        token,
        data.orgId ?? null,
        data.participantId,
        data.action,
        meta,
      );
    }),
  );
