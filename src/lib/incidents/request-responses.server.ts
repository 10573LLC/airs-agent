import { z } from "zod";
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { withIncidentAction, readIncident } from "./incidents.server";
import { invitePartner, listParticipants } from "./participation.server";
import { RESOURCE_REQUEST_KINDS } from "./ics.server";

export interface AgencyRequestResponse {
  id: string;
  requestId: string;
  incidentId: string;
  orgId: string;
  orgName: string;
  status: string;
  message: string;
  createdAt: string;
}
export const responseInput = z.object({
  requestId: z.string().uuid(),
  incidentId: z.string().uuid(),
  status: z.enum(["acknowledged", "partially_filled", "filled", "denied"]),
  message: z.string().trim().min(1).max(2000),
});
export const aidInput = z.object({
  incidentId: z.string().uuid(),
  batchId: z.string().uuid(),
  recipients: z.array(z.string().uuid()).min(1).max(30),
  description: z.string().trim().min(1).max(1500),
  resourceKind: z.enum(RESOURCE_REQUEST_KINDS),
  quantity: z.number().int().min(1).max(100),
  priority: z.enum(["immediate", "high", "routine"]),
  stagingLocation: z.string().trim().max(300),
});

export async function readAgencyRequests(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  meta: RequestMeta = {},
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "read", meta, audit: false },
    async (ctx, q, access) => {
      const requests = await q.query<{
        id: string;
        recipientOrgId: string | null;
        requestedFrom: string;
        description: string;
        quantity: number;
        resourceKind: string;
        status: string;
        stagingLocation: string;
      }>(
        `SELECT r.id,r.recipient_org_id AS "recipientOrgId",r.requested_from AS "requestedFrom",r.description,r.quantity,r.resource_kind AS "resourceKind",r.status,r.staging_location AS "stagingLocation" FROM airs.incident_resource_requests r WHERE r.incident_id=$1 AND r.recipient_org_id IS NOT NULL ORDER BY r.created_at`,
        [incidentId],
      );
      const responses = await q.query<AgencyRequestResponse>(
        `SELECT p.id,p.request_id AS "requestId",p.incident_id AS "incidentId",p.org_id AS "orgId",airs.related_org_name(p.org_id) AS "orgName",p.status,p.message,to_json(p.created_at)#>>'{}' AS "createdAt" FROM airs.incident_request_responses p WHERE p.incident_id=$1 ORDER BY p.created_at,p.id`,
        [incidentId],
      );
      const directory = await q.query<{ id: string; name: string; entity_type: string }>(
        "SELECT * FROM airs.framework_entity_directory() WHERE id<>$1 ORDER BY name",
        [ctx.orgId],
      );
      const exerciseUpdates = await q.query<{id:string;requestId:string;orgName:string;summary:string;createdAt:string}>(
        `SELECT id,split_part(observation->>'sourceRecordId',':',1) AS "requestId",airs.related_org_name(org_id) AS "orgName",observation->>'summary' AS summary,received_at::text AS "createdAt" FROM airs.operational_observations WHERE incident_id=$1 AND expires_at>now() AND airs.framework_incident_active(incident_id) AND (grant_id IS NULL OR airs.framework_grant_valid(grant_id)) AND observation->>'dataClass'='exercise_update' ORDER BY received_at DESC LIMIT 100`, [incidentId]);
      return {
        requests,
        responses,
        exerciseUpdates,
        directory,
        orgId: ctx.orgId,
        canRequest:
          access.relationship === "origin_admin" &&
          ctx.permissions.has("incident.invite_partner") &&
          ctx.permissions.has("incident.update"),
        canRespond: ctx.permissions.has("resource.assign_incident"),
        active: access.incident.status === "active",
      };
    },
  );
}

export async function sendAgencyAidRequest(
  token: string | null,
  orgId: string | null,
  raw: z.infer<typeof aidInput>,
  meta: RequestMeta = {},
) {
  const input = aidInput.parse(raw);
  const recipients = [...new Set(input.recipients)];
  // Preflight every recipient and owner permission before creating invitations.
  const directory = await withIncidentAction(
    { token, orgId, incidentId: input.incidentId, action: "invite_partner", meta, audit: false },
    async (ctx, q, access) => {
      if (!ctx.permissions.has("incident.update") || access.incident.status !== "active")
        throw new AccessError("forbidden");
      const rows = await q.query<{ id: string; name: string }>(
        "SELECT id,name FROM airs.framework_entity_directory() WHERE id=ANY($1::uuid[]) AND id<>$2",
        [recipients, ctx.orgId],
      );
      if (rows.length !== recipients.length) throw new AccessError("invalid_input");
      return rows;
    },
  );
  const participants = await listParticipants(token, orgId, input.incidentId, meta);
  const incident = (await readIncident(token, orgId, input.incidentId, meta)).incident;
  const expiresAt = new Date(
    Math.min(
      Date.now() + 86400000,
      incident.scheduledExpiresAt ? Date.parse(incident.scheduledExpiresAt) : Infinity,
    ),
  ).toISOString();
  const results: { orgId: string; ok: boolean; code?: string }[] = [];
  for (const recipient of directory) {
    try {
      const p = participants.find((p) => p.partnerOrgId === recipient.id);
      if (p && !["invited", "active", "pending_approval"].includes(p.participationStatus))
        throw new AccessError("participation_inactive");
      if (!p)
        await invitePartner(
          token,
          orgId,
          input.incidentId,
          {
            partnerOrgId: recipient.id,
            accessLevel: "operational",
            requiresApproval: false,
            invitationExpiresAt: expiresAt,
            participationExpiresAt: expiresAt,
            reason: input.description,
          },
          meta,
        );
      await withIncidentAction(
        {
          token,
          orgId,
          incidentId: input.incidentId,
          action: "update",
          meta,
          detail: { recipientOrgId: recipient.id },
        },
        async (ctx, q, access) => {
          if (
            !(await q.query("SELECT * FROM airs.lock_framework_incident($1)", [input.incidentId]))
              .length
          )
            throw new AccessError("incident_state_invalid");
          await q.query(
            `INSERT INTO airs.incident_resource_requests(incident_id,org_id,recipient_org_id,request_number,requested_by,requested_from,resource_kind,quantity,description,priority,staging_location,created_by_account,updated_by_account) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT(incident_id,request_number) DO NOTHING`,
            [
              input.incidentId,
              access.incident.orgId,
              recipient.id,
              `AID-${input.batchId}-${recipient.id}`,
              ctx.orgName,
              recipient.name,
              input.resourceKind,
              input.quantity,
              input.description,
              input.priority,
              input.stagingLocation,
              ctx.accountId,
            ],
          );
        },
      );
      results.push({ orgId: recipient.id, ok: true });
    } catch (error) {
      results.push({
        orgId: recipient.id,
        ok: false,
        code: error instanceof AccessError ? error.code : "internal_error",
      });
    }
  }
  return results;
}
export async function respondToAgencyRequest(
  token: string | null,
  orgId: string | null,
  raw: z.infer<typeof responseInput>,
  meta: RequestMeta = {},
) {
  const input = responseInput.parse(raw);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.assign_incident",
      action: "incident.request.respond",
      resourceType: "incident_resource_request",
      resourceId: input.requestId,
      detail: { incidentId: input.incidentId, status: input.status },
      meta,
    },
    async (ctx, q) => {
      const room = await q.query("SELECT * FROM airs.lock_framework_incident($1)", [
        input.incidentId,
      ]);
      if (!room.length) throw new AccessError("incident_state_invalid");
      // Request cancellation and submission serialize on the same request row;
      // the recipient check stays in both this function and the insertion policy.
      const request = await q.query<{ recipient: string; status: string }>(
        "SELECT * FROM airs.lock_agency_request($1,$2)",
        [input.requestId, input.incidentId],
      );
      if (
        request[0]?.recipient !== ctx.orgId ||
        ["cancelled", "filled", "denied"].includes(request[0]?.status)
      )
        throw new AccessError("forbidden");
      const result = await q.query<{ id: string }>(
        `INSERT INTO airs.incident_request_responses(request_id,incident_id,org_id,responder_account_id,status,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.requestId, input.incidentId, ctx.orgId, ctx.accountId, input.status, input.message],
      );
      return result[0];
    },
  );
}
