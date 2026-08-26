// Regression coverage for the Incident Room resource commitment plan.
//
// These tests pin the two explicit operator choices:
//  - agency-only MUST force originating_org_only and MUST NOT plan a share
//  - partner sharing MUST keep the operator-selected classification/profile
//    and MUST plan the share to run only after assignment success
// and the default-deny collapse of any invalid partner selection.

import { describe, expect, it } from "vitest";

import {
  executeResourceCommitment,
  PARTNER_SHARING_CLASSIFICATIONS,
  isPartnerDisclosureProfile,
  isPartnerSharingClassification,
  planResourceCommitment,
} from "./assignment-sharing";
import { SHARING_CLASSIFICATIONS } from "./model";
import { PARTNER_DISCLOSURE_PROFILES } from "./disclosure";

describe("planResourceCommitment — agency-only choice", () => {
  it("always forces originating_org_only and never plans a share", () => {
    const plan = planResourceCommitment({
      choice: "agency_only",
      classification: "participating_orgs",
      disclosureProfile: "operational",
    });
    expect(plan.visibilityClassification).toBe("originating_org_only");
    expect(plan.disclosureProfile).toBeNull();
    expect(plan.share).toBeNull();
  });

  it("ignores every selected partner classification and profile", () => {
    for (const classification of PARTNER_SHARING_CLASSIFICATIONS) {
      for (const profile of PARTNER_DISCLOSURE_PROFILES) {
        const plan = planResourceCommitment({
          choice: "agency_only",
          classification,
          disclosureProfile: profile,
        });
        expect(plan.visibilityClassification).toBe("originating_org_only");
        expect(plan.share).toBeNull();
      }
    }
  });
});

describe("planResourceCommitment — partner sharing choice", () => {
  it("keeps the operator-selected classification and disclosure profile and requires a share after assignment", () => {
    for (const classification of PARTNER_SHARING_CLASSIFICATIONS) {
      for (const profile of PARTNER_DISCLOSURE_PROFILES) {
        const plan = planResourceCommitment({
          choice: "share_with_partners",
          classification,
          disclosureProfile: profile,
        });
        expect(plan.visibilityClassification).toBe(classification);
        expect(plan.disclosureProfile).toBe(profile);
        expect(plan.share).not.toBeNull();
        expect(plan.share?.classification).toBe(classification);
        expect(plan.share?.disclosureProfile).toBe(profile);
      }
    }
  });

  it("collapses an agency-only classification selected in partner mode to the agency-only plan (default deny)", () => {
    const plan = planResourceCommitment({
      choice: "share_with_partners",
      classification: "originating_org_only",
      disclosureProfile: "summary",
    });
    expect(plan.visibilityClassification).toBe("originating_org_only");
    expect(plan.disclosureProfile).toBeNull();
    expect(plan.share).toBeNull();
  });

  it("collapses unknown classifications or profiles to the agency-only plan", () => {
    const badClassification = planResourceCommitment({
      choice: "share_with_partners",
      classification: "everyone_everywhere",
      disclosureProfile: "summary",
    });
    expect(badClassification.share).toBeNull();
    expect(badClassification.visibilityClassification).toBe("originating_org_only");

    const badProfile = planResourceCommitment({
      choice: "share_with_partners",
      classification: "participating_orgs",
      disclosureProfile: "everything",
    });
    expect(badProfile.share).toBeNull();
    expect(badProfile.visibilityClassification).toBe("originating_org_only");

    const customProfile = planResourceCommitment({
      choice: "share_with_partners",
      classification: "participating_orgs",
      disclosureProfile: "custom",
    });
    expect(customProfile.share).toBeNull();
    expect(customProfile.visibilityClassification).toBe("originating_org_only");
  });
});

describe("partner classification vocabulary", () => {
  it("excludes originating_org_only and adds nothing beyond the existing classifications", () => {
    expect(PARTNER_SHARING_CLASSIFICATIONS).not.toContain("originating_org_only");
    for (const classification of PARTNER_SHARING_CLASSIFICATIONS) {
      expect(SHARING_CLASSIFICATIONS).toContain(classification);
    }
    expect(PARTNER_SHARING_CLASSIFICATIONS.length).toBe(SHARING_CLASSIFICATIONS.length - 1);
  });

  it("type guards reject non-vocabulary values", () => {
    expect(isPartnerSharingClassification("originating_org_only")).toBe(false);
    expect(isPartnerSharingClassification("participating_orgs")).toBe(true);
    expect(isPartnerSharingClassification(null)).toBe(false);
    expect(isPartnerDisclosureProfile("custom")).toBe(false);
    expect(isPartnerDisclosureProfile("summary")).toBe(true);
    expect(isPartnerDisclosureProfile(42)).toBe(false);
  });
});


describe("executeResourceCommitment", () => {
  it("never shares an agency-only assignment", async () => {
    const plan = planResourceCommitment({
      choice: "agency_only",
      classification: "participating_orgs",
      disclosureProfile: "summary",
    });
    let shareCalls = 0;
    const result = await executeResourceCommitment(
      plan,
      async () => ({ ok: true }),
      async () => {
        shareCalls += 1;
        return { ok: true };
      },
    );
    expect(shareCalls).toBe(0);
    expect(result.shared).toBe(false);
    expect(result.shareResult).toBeNull();
  });

  it("does not share after assignment failure", async () => {
    const plan = planResourceCommitment({
      choice: "share_with_partners",
      classification: "participating_orgs",
      disclosureProfile: "summary",
    });
    let shareCalls = 0;
    const result = await executeResourceCommitment(
      plan,
      async () => ({ ok: false, code: "assignment_denied" }),
      async () => {
        shareCalls += 1;
        return { ok: true };
      },
    );
    expect(shareCalls).toBe(0);
    expect(result.assigned.ok).toBe(false);
    expect(result.shared).toBe(false);
  });

  it("reports partner sharing success only when the share API succeeds", async () => {
    const plan = planResourceCommitment({
      choice: "share_with_partners",
      classification: "public_safety_only",
      disclosureProfile: "operational",
    });
    const result = await executeResourceCommitment(
      plan,
      async () => ({ ok: true }),
      async (share) => ({
        ok: share.classification === "public_safety_only" && share.disclosureProfile === "operational",
      }),
    );
    expect(result.assigned.ok).toBe(true);
    expect(result.shareResult?.ok).toBe(true);
    expect(result.shared).toBe(true);
  });

  it("preserves assignment success but reports sharing failure", async () => {
    const plan = planResourceCommitment({
      choice: "share_with_partners",
      classification: "participating_orgs",
      disclosureProfile: "summary",
    });
    const result = await executeResourceCommitment(
      plan,
      async () => ({ ok: true }),
      async () => ({ ok: false, code: "share_denied" }),
    );
    expect(result.assigned.ok).toBe(true);
    expect(result.shareResult?.code).toBe("share_denied");
    expect(result.shared).toBe(false);
  });
});
