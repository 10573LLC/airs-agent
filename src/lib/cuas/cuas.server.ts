import { withAuthorized } from "@/lib/auth/authorize.server";
import type { RequestMeta } from "@/lib/auth/types";

import { assessCuasCapability, type CuasParticipationStatus } from "./capability";

export interface CuasAgencyProfile {
  participationStatus: CuasParticipationStatus;
  agencyApprovingOfficial: string;
  counselReviewer: string;
  policyAdoptedAt: string | null;
  annualAttestationAt: string | null;
  annualAttestationDueAt: string | null;
  federalPortalReference: string;
  mutualAidAuthorized: boolean;
  notes: string;
}

export interface CuasReadinessSummary {
  profile: CuasAgencyProfile;
  capability: ReturnType<typeof assessCuasCapability>;
  counts: {
    activeDetectionPersonnel: number;
    activeMitigationPersonnel: number;
    availableDetectionSystems: number;
    availableMitigationSystems: number;
    reportsDue: number;
    reportsOverdue: number;
    retentionRecordsDue: number;
  };
}

const EMPTY_PROFILE: CuasAgencyProfile = {
  participationStatus: "not_participating",
  agencyApprovingOfficial: "",
  counselReviewer: "",
  policyAdoptedAt: null,
  annualAttestationAt: null,
  annualAttestationDueAt: null,
  federalPortalReference: "",
  mutualAidAuthorized: false,
  notes: "",
};

export async function readCuasReadiness(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<CuasReadinessSummary> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "cuas.readiness.read",
      resourceType: "cuas_readiness",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const profiles = await q.query<{
        participationStatus: CuasParticipationStatus;
        agencyApprovingOfficial: string;
        counselReviewer: string;
        policyAdoptedAt: string | null;
        annualAttestationAt: string | null;
        annualAttestationDueAt: string | null;
        federalPortalReference: string;
        mutualAidAuthorized: boolean;
        notes: string;
      }>(
        `SELECT participation_status AS "participationStatus",
                agency_approving_official AS "agencyApprovingOfficial",
                counsel_reviewer AS "counselReviewer",
                to_json(policy_adopted_at)#>>'{}' AS "policyAdoptedAt",
                to_json(annual_attestation_at)#>>'{}' AS "annualAttestationAt",
                to_json(annual_attestation_due_at)#>>'{}' AS "annualAttestationDueAt",
                federal_portal_reference AS "federalPortalReference",
                mutual_aid_authorized AS "mutualAidAuthorized",
                notes
           FROM airs.cuas_agency_profiles
          WHERE org_id = $1`,
        [ctx.orgId],
      );
      const profile = profiles[0] ?? EMPTY_PROFILE;

      const [personnel, equipment, reports, retention] = await Promise.all([
        q.query<{ tier: string; count: number }>(
          `SELECT certification_tier AS tier, count(*)::int AS count
             FROM airs.cuas_personnel_certifications
            WHERE org_id = $1 AND status = 'active'
            GROUP BY certification_tier`,
          [ctx.orgId],
        ),
        q.query<{ technologyCategory: string; count: number }>(
          `SELECT technology_category AS "technologyCategory", count(*)::int AS count
             FROM airs.cuas_equipment_authorizations
            WHERE org_id = $1
              AND operational_status = 'available'
              AND asl_status NOT IN ('not_listed','suspended')
              AND faa_spectrum_status NOT IN ('required_pending','expired')
            GROUP BY technology_category`,
          [ctx.orgId],
        ),
        q.query<{ status: string; count: number }>(
          `SELECT CASE
                    WHEN submitted_at IS NULL AND due_at < now() THEN 'overdue'
                    WHEN submitted_at IS NULL AND due_at IS NOT NULL THEN 'due'
                    ELSE 'other'
                  END AS status,
                  count(*)::int AS count
             FROM airs.cuas_compliance_reports
            WHERE org_id = $1
            GROUP BY 1`,
          [ctx.orgId],
        ),
        q.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM airs.cuas_intercepted_record_controls
            WHERE org_id = $1
              AND deleted_at IS NULL
              AND delete_by IS NOT NULL
              AND delete_by <= now() + interval '14 days'`,
          [ctx.orgId],
        ),
      ]);

      const byTier = Object.fromEntries(personnel.map((r) => [r.tier, Number(r.count)]));
      const byTech = Object.fromEntries(equipment.map((r) => [r.technologyCategory, Number(r.count)]));
      const activeMitigationPersonnel =
        (byTier.mitigation ?? 0) + (byTier.correctional_mitigation ?? 0);
      const activeDetectionPersonnel = (byTier.detection_warning ?? 0) + activeMitigationPersonnel;
      const availableMitigationSystems =
        (byTech.atl_2_rf_protocol_manipulation ?? 0) + (byTech.atl_3_rf_disruption ?? 0);
      const availableDetectionSystems = Object.entries(byTech)
        .filter(([key]) => key !== "atl_2_rf_protocol_manipulation" && key !== "atl_3_rf_disruption")
        .reduce((sum, [, value]) => sum + Number(value), 0);
      const reportsByStatus = Object.fromEntries(reports.map((r) => [r.status, Number(r.count)]));

      const capability = assessCuasCapability({
        participationStatus: profile.participationStatus,
        mutualAidAuthorized: profile.mutualAidAuthorized,
        activeDetectionPersonnel,
        activeMitigationPersonnel,
        availableDetectionSystems,
        availableMitigationSystems,
      });

      return {
        profile,
        capability,
        counts: {
          activeDetectionPersonnel,
          activeMitigationPersonnel,
          availableDetectionSystems,
          availableMitigationSystems,
          reportsDue: reportsByStatus.due ?? 0,
          reportsOverdue: reportsByStatus.overdue ?? 0,
          retentionRecordsDue: Number(retention[0]?.count ?? 0),
        },
      };
    },
  );
}

export async function saveCuasAgencyProfile(
  token: string | null | undefined,
  orgId: string | null,
  input: CuasAgencyProfile,
  meta?: RequestMeta,
): Promise<CuasAgencyProfile> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "org.manage",
      action: "cuas.agency_profile.saved",
      resourceType: "cuas_agency_profile",
      detail: { participationStatus: input.participationStatus, mutualAidAuthorized: input.mutualAidAuthorized },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<CuasAgencyProfile>(
        `INSERT INTO airs.cuas_agency_profiles (
           org_id, participation_status, agency_approving_official, counsel_reviewer,
           policy_adopted_at, annual_attestation_at, annual_attestation_due_at,
           federal_portal_reference, mutual_aid_authorized, notes, updated_by_account, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (org_id) DO UPDATE SET
           participation_status = EXCLUDED.participation_status,
           agency_approving_official = EXCLUDED.agency_approving_official,
           counsel_reviewer = EXCLUDED.counsel_reviewer,
           policy_adopted_at = EXCLUDED.policy_adopted_at,
           annual_attestation_at = EXCLUDED.annual_attestation_at,
           annual_attestation_due_at = EXCLUDED.annual_attestation_due_at,
           federal_portal_reference = EXCLUDED.federal_portal_reference,
           mutual_aid_authorized = EXCLUDED.mutual_aid_authorized,
           notes = EXCLUDED.notes,
           updated_by_account = EXCLUDED.updated_by_account,
           updated_at = now()
         RETURNING participation_status AS "participationStatus",
                   agency_approving_official AS "agencyApprovingOfficial",
                   counsel_reviewer AS "counselReviewer",
                   to_json(policy_adopted_at)#>>'{}' AS "policyAdoptedAt",
                   to_json(annual_attestation_at)#>>'{}' AS "annualAttestationAt",
                   to_json(annual_attestation_due_at)#>>'{}' AS "annualAttestationDueAt",
                   federal_portal_reference AS "federalPortalReference",
                   mutual_aid_authorized AS "mutualAidAuthorized",
                   notes`,
        [
          ctx.orgId,
          input.participationStatus,
          input.agencyApprovingOfficial,
          input.counselReviewer,
          input.policyAdoptedAt,
          input.annualAttestationAt,
          input.annualAttestationDueAt,
          input.federalPortalReference,
          input.mutualAidAuthorized,
          input.notes,
          ctx.accountId,
        ],
      );
      return rows[0] ?? input;
    },
  );
}
