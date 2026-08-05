// Incident participation: invitation, acceptance, approval, restriction,
// revocation, removal, withdrawal and expiration.
//
// Owner-side actions run through withIncidentAction() (originating org only).
// Partner-side actions (accept / decline / withdraw) run through
// withAuthorized() and are constrained to the partner's OWN participation row
// by both application checks and the airs.incident_participant_guard trigger.
import { recordAudit } from "@/lib/audit.server";
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import { hashToken, randomToken } from "@/lib/auth/tokens";
import type { RequestMeta } from "@/lib/auth/types";

import { withIncidentAction } from "./incidents.server";
import { ACCESS_LEVELS, type AccessLevel, type IncidentAction } from "./lifecycle";
import { assertInvitationEligibility } from "./trust.server";

export interface ParticipantRow {
  id: string;
  incidentId: string;
  orgId: string;
  partnerOrgId: string;
  partnerOrgName: string | null;
  invitationStatus: string;
  participationStatus: string;
  accessLevel: AccessLevel;
  requiresApproval: boolean;
  invitedAt: string;
  invitationExpiresAt: string;
  acceptedAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  restrictedAt: string | null;
  revokedAt: string | null;
  removedAt: string | null;
  reason: string | null;
}

const P = `
  p.id, p.incident_id AS "incidentId", p.org_id AS "orgId",
  p.partner_org_id AS "partnerOrgId", airs.related_org_name(p.partner_org_id) AS "partnerOrgName",
  p.invitation_status AS "invitationStatus", p.participation_status AS "participationStatus",
  p.access_level AS "accessLevel", p.requires_approval AS "requiresApproval",
  to_json(p.invited_at)#>>'{}' AS "invitedAt",
  to_json(p.invitation_expires_at)#>>'{}' AS "invitationExpiresAt",
  to_json(p.accepted_at)#>>'{}' AS "acceptedAt",
  to_json(p.approved_at)#>>'{}' AS "approvedAt",
  to_json(p.expires_at)#>>'{}' AS "expiresAt",
  to_json(p.restricted_at)#>>'{}' AS "restrictedAt",
  to_json(p.revoked_at)#>>'{}' AS "revokedAt",
  to_json(p.removed_at)#>>'{}' AS "removedAt",
  p.reason
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrThrow(value: string, label: string) {
  if (!UUID.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
  return value;
}

function futureTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  const iso = new Date(value).toISOString();
  if (Date.parse(iso) <= Date.now())
    throw new AccessError("invalid_input", `${label} is in the past`);
  return iso;
}

// --- owner side ---------------------------------------------------------------

export async function listParticipants(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  meta: RequestMeta,
): Promise<ParticipantRow[]> {
  return withIncidentAction(
    { token, orgId, incidentId, action: "view_participants", meta, audit: false },
    async (_ctx, q) =>
      q.query<ParticipantRow>(
        `SELECT ${P} FROM airs.incident_participants p
          WHERE p.incident_id = $1 ORDER BY p.invited_at`,
        [incidentId],
      ),
  );
}

export interface InvitePartnerInput {
  partnerOrgId: string;
  accessLevel: string;
  invitationExpiresAt: string;
  participationExpiresAt?: string | null;
  requiresApproval?: boolean;
  reason?: string | null;
}

export async function invitePartner(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  input: InvitePartnerInput,
  meta: RequestMeta,
): Promise<{ participant: ParticipantRow; invitationToken: string }> {
  return withIncidentAction(
    { token, orgId, incidentId, action: "invite_partner", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (["closing", "closed", "archived"].includes(incident.status)) {
        throw new AccessError("incident_state_invalid");
      }
      const partnerOrgId = uuidOrThrow(input.partnerOrgId, "partner organization");
      if (partnerOrgId === ctx.orgId) throw new AccessError("invalid_input", "self invitation");
      const accessLevel = input.accessLevel;
      if (!(ACCESS_LEVELS as readonly string[]).includes(accessLevel)) {
        throw new AccessError("invalid_input", "unknown access level");
      }
      const invitationExpiresAt = futureTimestamp(
        input.invitationExpiresAt,
        "invitation expiration",
      );
      const participationExpiresAt = input.participationExpiresAt
        ? futureTimestamp(input.participationExpiresAt, "participation expiration")
        : null;
      // Eligibility is approved-trust only; there is no emergency bypass.
      const eligibility = await assertInvitationEligibility(q, ctx.orgId, partnerOrgId);

      const raw = randomToken(32);
      const tokenHash = await hashToken(raw);
      const rows = await q.query<ParticipantRow>(
        `INSERT INTO airs.incident_participants
           (incident_id, org_id, partner_org_id, access_level, requires_approval, token_hash,
            invited_by_org_id, invited_by_user, invitation_expires_at, expires_at, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$2,$7,$8,$9,$10)
         ON CONFLICT (incident_id, partner_org_id) DO UPDATE
            SET access_level = EXCLUDED.access_level,
                requires_approval = EXCLUDED.requires_approval,
                token_hash = EXCLUDED.token_hash,
                invitation_status = 'pending',
                participation_status = 'invited',
                invited_by_user = EXCLUDED.invited_by_user,
                invited_at = now(),
                invitation_expires_at = EXCLUDED.invitation_expires_at,
                expires_at = EXCLUDED.expires_at,
                accepted_at = NULL, approved_at = NULL, revoked_at = NULL,
                removed_at = NULL, restricted_at = NULL,
                reason = EXCLUDED.reason, updated_at = now()
          WHERE airs.incident_participants.participation_status <> 'removed'
         RETURNING ${P.replace(/p\./g, "airs.incident_participants.")}`,
        [
          incidentId,
          ctx.orgId,
          partnerOrgId,
          accessLevel,
          input.requiresApproval !== false,
          tokenHash,
          ctx.userId,
          invitationExpiresAt,
          participationExpiresAt,
          input.reason ?? null,
        ],
      );
      const participant = rows[0];
      if (!participant) throw new AccessError("incident_state_invalid");
      await recordAudit(q, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: "incident.partner_invited",
        resourceType: "incident_room",
        resourceId: incidentId,
        outcome: "allow",
        detail: {
          actor_org_id: ctx.orgId,
          target_org_id: partnerOrgId,
          participant_id: participant.id,
          access_level: accessLevel,
          eligibility,
          prior_state: null,
          new_state: "invited",
        },
        ipAddress: meta.ipAddress ?? null,
        correlationId: meta.correlationId ?? null,
      });
      // The raw token is returned exactly once and never persisted.
      return { participant, invitationToken: raw };
    },
  );
}

type OwnerParticipantAction =
  | "revoke_invitation"
  | "approve_partner"
  | "restrict_partner"
  | "revoke_partner"
  | "remove_partner";

const OWNER_ACTION_MAP: Record<
  OwnerParticipantAction,
  { incidentAction: IncidentAction; audit: string }
> = {
  revoke_invitation: { incidentAction: "invite_partner", audit: "incident.invitation_revoked" },
  approve_partner: { incidentAction: "approve_partner", audit: "incident.participant_approved" },
  restrict_partner: {
    incidentAction: "restrict_partner",
    audit: "incident.participant_restricted",
  },
  revoke_partner: { incidentAction: "revoke_partner", audit: "incident.participant_revoked" },
  remove_partner: { incidentAction: "remove_partner", audit: "incident.participant_removed" },
};

export async function ownerParticipantAction(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  participantId: string,
  action: OwnerParticipantAction,
  meta: RequestMeta,
  reason?: string | null,
): Promise<ParticipantRow> {
  const mapped = OWNER_ACTION_MAP[action];
  if (!mapped) throw new AccessError("invalid_input", "unknown participant action");
  return withIncidentAction(
    { token, orgId, incidentId, action: mapped.incidentAction, meta, audit: false },
    async (ctx, q) => {
      uuidOrThrow(participantId, "participant id");
      const current = await q.query<{
        id: string;
        partnerOrgId: string;
        invitationStatus: string;
        participationStatus: string;
        requiresApproval: boolean;
      }>(
        `SELECT p.id, p.partner_org_id AS "partnerOrgId",
                p.invitation_status AS "invitationStatus",
                p.participation_status AS "participationStatus",
                p.requires_approval AS "requiresApproval"
           FROM airs.incident_participants p
          WHERE p.id = $1 AND p.incident_id = $2 AND p.org_id = $3`,
        [participantId, incidentId, ctx.orgId],
      );
      const row = current[0];
      if (!row) throw new AccessError("incident_not_found");

      let sql: string;
      const params: unknown[] = [participantId];
      switch (action) {
        case "revoke_invitation":
          if (row.invitationStatus !== "pending") throw new AccessError("incident_state_invalid");
          sql = `SET invitation_status = 'revoked', participation_status = 'revoked',
                     token_hash = NULL, revoked_at = now(), reason = $2, updated_at = now()`;
          params.push(reason ?? null);
          break;
        case "approve_partner":
          if (row.participationStatus !== "pending_approval") {
            throw new AccessError("incident_state_invalid");
          }
          sql = `SET participation_status = 'active', approved_at = now(),
                     approved_by_user = $2, updated_at = now()`;
          params.push(ctx.userId);
          break;
        case "restrict_partner":
          if (!["active", "restricted"].includes(row.participationStatus)) {
            throw new AccessError("incident_state_invalid");
          }
          sql = `SET participation_status = 'restricted', restricted_at = now(),
                     reason = $2, updated_at = now()`;
          params.push(reason ?? null);
          break;
        case "revoke_partner":
          if (["revoked", "removed"].includes(row.participationStatus)) {
            throw new AccessError("incident_state_invalid");
          }
          sql = `SET participation_status = 'revoked', invitation_status =
                       CASE WHEN invitation_status = 'pending' THEN 'revoked' ELSE invitation_status END,
                     revoked_at = now(), token_hash = NULL, reason = $2, updated_at = now()`;
          params.push(reason ?? null);
          break;
        default:
          sql = `SET participation_status = 'removed', removed_at = now(),
                     revoked_at = coalesce(revoked_at, now()), token_hash = NULL,
                     reason = $2, updated_at = now()`;
          params.push(reason ?? null);
      }

      const updated = await q.query<ParticipantRow>(
        `UPDATE airs.incident_participants p ${sql} WHERE p.id = $1 RETURNING ${P}`,
        params,
      );
      const result = updated[0]!;
      await recordAudit(q, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: mapped.audit,
        resourceType: "incident_room",
        resourceId: incidentId,
        outcome: "allow",
        detail: {
          actor_org_id: ctx.orgId,
          target_org_id: row.partnerOrgId,
          participant_id: participantId,
          prior_state: row.participationStatus,
          new_state: result.participationStatus,
          reason: reason ?? null,
        },
        ipAddress: meta.ipAddress ?? null,
        correlationId: meta.correlationId ?? null,
      });
      return result;
    },
  );
}

// --- partner side ---------------------------------------------------------------

export interface PendingInvitationRow {
  participantId: string;
  incidentId: string;
  incidentName: string;
  incidentType: string;
  incidentStatus: string;
  ownerOrgId: string;
  ownerOrgName: string;
  accessLevel: AccessLevel;
  requiresApproval: boolean;
  invitedAt: string;
  invitationExpiresAt: string;
  expiresAt: string | null;
}

export async function listPendingInvitations(
  token: string | null,
  orgId: string | null,
  meta: RequestMeta,
): Promise<PendingInvitationRow[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "incident.read",
      action: "incident.list_invitations",
      resourceType: "incident_participant",
      audit: false,
      meta,
    },
    async (_ctx, q) =>
      q.query<PendingInvitationRow>(
        `SELECT participant_id AS "participantId", incident_id AS "incidentId",
                incident_name AS "incidentName", incident_type AS "incidentType",
                incident_status AS "incidentStatus", owner_org_id AS "ownerOrgId",
                owner_org_name AS "ownerOrgName", access_level AS "accessLevel",
                requires_approval AS "requiresApproval",
                to_json(invited_at)#>>'{}' AS "invitedAt",
                to_json(invitation_expires_at)#>>'{}' AS "invitationExpiresAt",
                to_json(expires_at)#>>'{}' AS "expiresAt"
           FROM airs.pending_incident_invitations()
          ORDER BY invited_at DESC`,
      ),
  );
}

type PartnerAction = "accept" | "decline" | "withdraw";

const PARTNER_AUDIT: Record<PartnerAction, string> = {
  accept: "incident.invitation_accepted",
  decline: "incident.invitation_declined",
  withdraw: "incident.participant_withdrew",
};

/**
 * Partner-side participation change. The acting organization may only touch a
 * row that names it as the partner; the assigned incident, access level and
 * expirations are never read from the request.
 */
export async function partnerParticipationAction(
  token: string | null,
  orgId: string | null,
  participantId: string,
  action: PartnerAction,
  meta: RequestMeta,
): Promise<{ participantId: string; participationStatus: string; incidentId: string }> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "incident.read",
      action: `incident.${action}`,
      resourceType: "incident_participant",
      resourceId: participantId,
      audit: false,
      meta,
    },
    async (ctx, q) => {
      uuidOrThrow(participantId, "participant id");
      const rows = await q.query<{
        id: string;
        incidentId: string;
        orgId: string;
        invitationStatus: string;
        participationStatus: string;
        requiresApproval: boolean;
        expired: boolean;
      }>(
        `SELECT p.id, p.incident_id AS "incidentId", p.org_id AS "orgId",
                p.invitation_status AS "invitationStatus",
                p.participation_status AS "participationStatus",
                p.requires_approval AS "requiresApproval",
                (p.invitation_expires_at <= now()) AS expired
           FROM airs.incident_participants p
          WHERE p.id = $1 AND p.partner_org_id = $2`,
        [participantId, ctx.orgId],
      );
      const row = rows[0];
      if (!row) throw new AccessError("forbidden");

      let sql: string;
      let newStatus: string;
      if (action === "accept") {
        if (row.invitationStatus !== "pending") throw new AccessError("participation_inactive");
        if (row.expired) throw new AccessError("participation_inactive");
        newStatus = row.requiresApproval ? "pending_approval" : "active";
        // token_hash is deliberately left untouched: the participation guard
        // forbids a partner organization from editing its own grant fields.
        // The token is already spent because invitation_status leaves 'pending'.
        sql = `SET invitation_status = 'accepted', participation_status = $3,
                   accepted_at = now(), accepted_by_user = $4,
                   approved_at = CASE WHEN $3 = 'active' THEN now() ELSE NULL END,
                   updated_at = now()`;
      } else if (action === "decline") {
        if (row.invitationStatus !== "pending") throw new AccessError("participation_inactive");
        newStatus = "declined";
        sql = `SET invitation_status = 'declined', participation_status = $3,
                   updated_at = now()`;
      } else {
        if (!["active", "restricted", "pending_approval"].includes(row.participationStatus)) {
          throw new AccessError("participation_inactive");
        }
        newStatus = "removed";
        sql = `SET participation_status = $3, removed_at = now(), updated_at = now()`;
      }

      const params: unknown[] = [participantId, ctx.orgId, newStatus];
      if (action === "accept") params.push(ctx.userId);
      const updated = await q.query<{ participationStatus: string }>(
        `UPDATE airs.incident_participants p ${sql}
          WHERE p.id = $1 AND p.partner_org_id = $2
        RETURNING p.participation_status AS "participationStatus"`,
        params,
      );
      if (!updated[0]) throw new AccessError("forbidden");
      await recordAudit(q, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: PARTNER_AUDIT[action],
        resourceType: "incident_room",
        resourceId: row.incidentId,
        outcome: "allow",
        detail: {
          actor_org_id: ctx.orgId,
          target_org_id: ctx.orgId,
          owner_org_id: row.orgId,
          participant_id: participantId,
          prior_state: row.participationStatus,
          new_state: updated[0].participationStatus,
        },
        ipAddress: meta.ipAddress ?? null,
        correlationId: meta.correlationId ?? null,
      });
      return {
        participantId,
        participationStatus: updated[0].participationStatus,
        incidentId: row.incidentId,
      };
    },
  );
}
