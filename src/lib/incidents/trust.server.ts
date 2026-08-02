// Trusted-agency relationships. A relationship makes another organization
// ELIGIBLE to be invited to an incident room; it never grants incident access
// by itself. Only an `approved` relationship may be used for an invitation.
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";

import { TRUST_STATUSES, type TrustStatus } from "./lifecycle";

export interface TrustedAgencyRow {
  id: string;
  orgId: string;
  partnerOrgId: string;
  partnerOrgName: string | null;
  status: TrustStatus;
  note: string | null;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

const SELECT = `
  t.id, t.org_id AS "orgId", t.partner_org_id AS "partnerOrgId",
  airs.related_org_name(t.partner_org_id) AS "partnerOrgName",
  t.status, t.note,
  to_json(t.created_at)#>>'{}' AS "createdAt",
  to_json(t.approved_at)#>>'{}' AS "approvedAt",
  to_json(t.revoked_at)#>>'{}' AS "revokedAt"
`;

export async function listTrustedAgencies(
  token: string | null,
  orgId: string | null,
  meta: RequestMeta,
): Promise<TrustedAgencyRow[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "incident.view_participants",
      action: "trust.list",
      resourceType: "trusted_agency",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<TrustedAgencyRow>(
        `SELECT ${SELECT} FROM airs.trusted_agencies t
          WHERE t.org_id = $1 ORDER BY t.created_at DESC`,
        [ctx.orgId],
      ),
  );
}

/** Creates or re-states the caller organization's relationship to a partner. */
export async function setTrustedAgencyStatus(
  token: string | null,
  orgId: string | null,
  input: { partnerOrgId: string; status: string; note?: string | null },
  meta: RequestMeta,
): Promise<TrustedAgencyRow> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "org.manage",
      action: "trust.set_status",
      resourceType: "trusted_agency",
      resourceId: input.partnerOrgId,
      detail: { status: input.status },
      meta,
    },
    async (ctx, q) => {
      if (!(TRUST_STATUSES as readonly string[]).includes(input.status)) {
        throw new AccessError("invalid_input", "unknown trust status");
      }
      if (input.partnerOrgId === ctx.orgId) {
        throw new AccessError("invalid_input", "an organization cannot trust itself");
      }
      const rows = await q.query<TrustedAgencyRow>(
        `INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status, note, requested_by,
                                            approved_by, approved_at, revoked_at)
              VALUES ($1,$2,$3,$4,$5,
                      CASE WHEN $3 = 'approved' THEN $5 END,
                      CASE WHEN $3 = 'approved' THEN now() END,
                      CASE WHEN $3 = 'revoked' THEN now() END)
         ON CONFLICT (org_id, partner_org_id) DO UPDATE
            SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now(),
                approved_by = CASE WHEN EXCLUDED.status = 'approved' THEN $5
                                   ELSE airs.trusted_agencies.approved_by END,
                approved_at = CASE WHEN EXCLUDED.status = 'approved' THEN now()
                                   ELSE airs.trusted_agencies.approved_at END,
                revoked_at  = CASE WHEN EXCLUDED.status = 'revoked' THEN now() END
         RETURNING ${SELECT.replace(/t\./g, "airs.trusted_agencies.")}`,
        [ctx.orgId, input.partnerOrgId, input.status, input.note ?? null, ctx.userId],
      );
      return rows[0]!;
    },
  );
}

/** Throws unless an approved relationship makes the partner eligible. */
export async function assertInvitationEligibility(
  q: { query: <R>(sql: string, params?: unknown[]) => Promise<R[]> },
  orgId: string,
  partnerOrgId: string,
  allowEmergency: boolean,
): Promise<"trusted" | "emergency"> {
  const rows = await q.query<{ status: TrustStatus }>(
    `SELECT status FROM airs.trusted_agencies WHERE org_id = $1 AND partner_org_id = $2`,
    [orgId, partnerOrgId],
  );
  const status = rows[0]?.status ?? null;
  if (status === "approved") return "trusted";
  // Documented one-time path: an originating-organization administrator may
  // invite a non-trusted agency in an emergency. It is explicit, audited, and
  // never silent — the caller must set it and hold org.manage.
  if (allowEmergency && status !== "revoked" && status !== "suspended") return "emergency";
  throw new AccessError("partner_not_eligible");
}