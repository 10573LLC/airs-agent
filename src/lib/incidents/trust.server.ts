// Trusted-agency relationships. A relationship makes another organization
// ELIGIBLE to be invited to an incident room; it never grants incident access
// by itself. Only an `approved` relationship may be used for an invitation.
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";

import { TRUST_STATUSES, type TrustStatus } from "./lifecycle";
import { friendProfileSchema, type FriendProfile } from './friend-profile';
import { shapeAgencySystemProfile } from '@/lib/resources/agency-system-profile';

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
  relationshipLevel: 'associate' | 'friend';
  shareProfile: boolean;
  friendProfile: FriendProfile;
  profileValidUntil: string | null;
}

const SELECT = `
  t.id, t.org_id AS "orgId", t.partner_org_id AS "partnerOrgId",
  airs.related_org_name(t.partner_org_id) AS "partnerOrgName",
  t.status, t.note, t.relationship_level AS "relationshipLevel",
  t.share_profile AS "shareProfile", t.friend_profile AS "friendProfile",
  to_json(t.profile_valid_until)#>>'{}' AS "profileValidUntil",
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

export async function saveFriendProfile(token: string | null, orgId: string | null,
  input: {partnerOrgId:string; relationshipLevel:'associate'|'friend'; shareProfile:boolean; profile:FriendProfile; validUntil:string | null}, meta:RequestMeta) {
  const parsed=friendProfileSchema.safeParse(input.profile);
  if(!parsed.success || !['associate','friend'].includes(input.relationshipLevel)) throw new AccessError('invalid_input');
  const until=input.validUntil?Date.parse(input.validUntil):NaN;
  if(input.shareProfile && (input.relationshipLevel!=='friend' || !Number.isFinite(until) || until<=Date.now() || until>Date.now()+366*86400000)) throw new AccessError('invalid_input','Sharing needs a future review date within one year');
  return withAuthorized({token,orgId,permission:'org.manage',action:'trust.friend_profile.save',resourceType:'trusted_agency',resourceId:input.partnerOrgId,detail:{relationshipLevel:input.relationshipLevel,shareProfile:input.shareProfile},meta},async(ctx,q)=>{
    const rows=await q.query(`UPDATE airs.trusted_agencies SET relationship_level=$3, share_profile=$4,
      friend_profile=$5::jsonb, profile_confirmed_at=now(), profile_valid_until=$6, updated_at=now()
      WHERE org_id=$1 AND partner_org_id=$2 RETURNING id`,[ctx.orgId,input.partnerOrgId,input.relationshipLevel,input.shareProfile,JSON.stringify(parsed.data),Number.isFinite(until)?new Date(until).toISOString():null]);
    if(!rows[0]) throw new AccessError('invalid_input','Create the Associate relationship first');
    return {saved:true};
  });
}

export async function listFriendBriefings(token:string|null,orgId:string|null,meta:RequestMeta) {
  return withAuthorized({token,orgId,permission:'incident.view_participants',action:'trust.friend_briefings.read',resourceType:'trusted_agency',audit:false,meta},async(_ctx,q)=>{
    const rows=await q.query<{partnerOrgId:string;partnerOrgName:string;mutualFriend:boolean;profileState:string;profile:unknown;confirmedAt:string|null;validUntil:string|null;ecosystems:any[];components:any[]}>(`SELECT * FROM airs.friend_briefings()`);
    return rows.map(({ecosystems,components,profile,...r})=>({...r,profile:friendProfileSchema.parse(profile),systems:shapeAgencySystemProfile({ecosystems,components})}));
  });
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
                relationship_level = CASE WHEN EXCLUDED.status='approved' THEN airs.trusted_agencies.relationship_level ELSE 'associate' END,
                share_profile = CASE WHEN EXCLUDED.status='approved' THEN airs.trusted_agencies.share_profile ELSE false END,
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
): Promise<"trusted"> {
  const rows = await q.query<{ status: TrustStatus }>(
    `SELECT status FROM airs.trusted_agencies WHERE org_id = $1 AND partner_org_id = $2`,
    [orgId, partnerOrgId],
  );
  const status = rows[0]?.status ?? null;
  // Eligibility is APPROVED-only. There is no emergency bypass: an unapproved,
  // pending, restricted, suspended or revoked relationship denies.
  if (status !== "approved") throw new AccessError("partner_not_eligible");
  return "trusted";
}
