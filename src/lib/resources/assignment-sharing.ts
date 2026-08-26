// Resource commitment planning for Incident Rooms (AIRS ownership model).
//
// Pure helper: no I/O, no API calls. It converts an operator's explicit
// commitment choice into an execution plan the UI must follow:
//
//  1. "agency_only"        -> assignment carries visibilityClassification
//                             originating_org_only and NO share call may be
//                             made. The record stays inside the owning agency;
//                             the Readiness Board remains its master inventory.
//  2. "share_with_partners" -> assignment carries the operator-selected
//                             existing partner sharing classification and
//                             disclosure profile, and a share call is required
//                             AFTER the assignment succeeds (never before, and
//                             never on assignment failure).
//
// Default deny: an invalid or contradictory partner selection (for example an
// agency-only classification chosen in partner mode) collapses to the
// agency-only plan rather than widening disclosure. No new permission model is
// introduced here; authorization, RLS, disclosure and revocation all remain
// with the existing server-side services.

import { SHARING_CLASSIFICATIONS, type SharingClassification } from "./model";
import { PARTNER_DISCLOSURE_PROFILES, type DisclosureProfile } from "./disclosure";

/** The two explicit operator choices for committing a resource to a room. */
export type ResourceCommitmentChoice = "agency_only" | "share_with_partners";

/** Classifications that disclose a record beyond the originating agency. */
export type PartnerSharingClassification = Exclude<SharingClassification, "originating_org_only">;

/**
 * The classifications an operator may pick when sharing with partners.
 * `originating_org_only` is deliberately excluded: agency-only visibility is a
 * separate, explicit choice — not a sharing classification variant.
 */
export const PARTNER_SHARING_CLASSIFICATIONS: readonly PartnerSharingClassification[] =
  SHARING_CLASSIFICATIONS.filter(
    (c): c is PartnerSharingClassification => c !== "originating_org_only",
  );

export function isPartnerSharingClassification(
  value: unknown,
): value is PartnerSharingClassification {
  return (
    typeof value === "string" &&
    (PARTNER_SHARING_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

export function isPartnerDisclosureProfile(value: unknown): value is DisclosureProfile {
  return (
    typeof value === "string" && (PARTNER_DISCLOSURE_PROFILES as readonly string[]).includes(value)
  );
}

export interface ResourceCommitmentPlan {
  /** Visibility recorded on the assignment itself. */
  visibilityClassification: SharingClassification;
  /** Disclosure profile recorded on the assignment; null when agency-only. */
  disclosureProfile: DisclosureProfile | null;
  /**
   * Share instruction. `null` means the share API MUST NOT be called. When
   * present, the share MUST be executed only after the assignment succeeds.
   */
  share: {
    classification: PartnerSharingClassification;
    disclosureProfile: DisclosureProfile;
  } | null;
}

const AGENCY_ONLY_PLAN: ResourceCommitmentPlan = {
  visibilityClassification: "originating_org_only",
  disclosureProfile: null,
  share: null,
};

/**
 * Builds the execution plan for a resource commitment.
 *
 * Agency-only ignores any selected classification or profile and always yields
 * originating_org_only with no share. Partner sharing requires a valid partner
 * classification and disclosure profile; anything else collapses to the
 * agency-only plan (default deny — invalid input never widens disclosure).
 */
export function planResourceCommitment(input: {
  choice: ResourceCommitmentChoice;
  classification: string;
  disclosureProfile: string;
}): ResourceCommitmentPlan {
  if (input.choice !== "share_with_partners") {
    return { ...AGENCY_ONLY_PLAN };
  }
  if (
    !isPartnerSharingClassification(input.classification) ||
    !isPartnerDisclosureProfile(input.disclosureProfile)
  ) {
    return { ...AGENCY_ONLY_PLAN };
  }
  return {
    visibilityClassification: input.classification,
    disclosureProfile: input.disclosureProfile,
    share: {
      classification: input.classification,
      disclosureProfile: input.disclosureProfile,
    },
  };
}


export interface CommitmentApiResult {
  ok: boolean;
  code?: string;
}

export async function executeResourceCommitment<
  TAssigned extends CommitmentApiResult,
  TShared extends CommitmentApiResult,
>(
  plan: ResourceCommitmentPlan,
  assign: () => Promise<TAssigned>,
  share: (instruction: NonNullable<ResourceCommitmentPlan["share"]>) => Promise<TShared>,
) {
  const assigned = await assign();
  if (!assigned.ok || !plan.share) {
    return { assigned, shareResult: null as TShared | null, shared: false };
  }
  const shareResult = await share(plan.share);
  return { assigned, shareResult, shared: shareResult.ok };
}
