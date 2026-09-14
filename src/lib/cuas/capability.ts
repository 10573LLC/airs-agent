export type CuasParticipationStatus =
  | "not_participating"
  | "detection_warning"
  | "mitigation"
  | "correctional_mitigation"
  | "suspended";

export type CuasCapabilityState =
  | "dormant"
  | "no_local_capability"
  | "mutual_aid_only"
  | "detection_ready"
  | "mitigation_ready"
  | "temporarily_unavailable";

export interface CuasCapabilityInput {
  participationStatus: CuasParticipationStatus;
  mutualAidAuthorized: boolean;
  activeDetectionPersonnel: number;
  activeMitigationPersonnel: number;
  availableDetectionSystems: number;
  availableMitigationSystems: number;
}

export interface CuasCapabilityAssessment {
  state: CuasCapabilityState;
  locallyUsable: boolean;
  detectionUsable: boolean;
  mitigationUsable: boolean;
  mutualAidAvailable: boolean;
  reasons: string[];
}

/**
 * Pure, deterministic readiness assessment. This is capability logic only —
 * never a legal conclusion and never a substitute for agency command/counsel.
 *
 * Most important invariant: no C-UAS participation/capability must NEVER block
 * ordinary AIRS incident operations. In that case the domain is simply dormant.
 */
export function assessCuasCapability(input: CuasCapabilityInput): CuasCapabilityAssessment {
  if (input.participationStatus === "not_participating") {
    return {
      state: input.mutualAidAuthorized ? "mutual_aid_only" : "dormant",
      locallyUsable: false,
      detectionUsable: false,
      mitigationUsable: false,
      mutualAidAvailable: input.mutualAidAuthorized,
      reasons: input.mutualAidAuthorized
        ? ["Agency is not locally participating; C-UAS support may be requested through mutual aid."]
        : ["C-UAS is not enabled for this agency. Ordinary AIRS operations are unaffected."],
    };
  }

  if (input.participationStatus === "suspended") {
    return {
      state: input.mutualAidAuthorized ? "mutual_aid_only" : "temporarily_unavailable",
      locallyUsable: false,
      detectionUsable: false,
      mitigationUsable: false,
      mutualAidAvailable: input.mutualAidAuthorized,
      reasons: ["Local C-UAS participation is suspended."],
    };
  }

  const detectionUsable =
    input.activeDetectionPersonnel > 0 && input.availableDetectionSystems > 0;
  const mitigationTier =
    input.participationStatus === "mitigation" ||
    input.participationStatus === "correctional_mitigation";
  const mitigationUsable =
    mitigationTier && input.activeMitigationPersonnel > 0 && input.availableMitigationSystems > 0;

  if (mitigationUsable) {
    return {
      state: "mitigation_ready",
      locallyUsable: true,
      detectionUsable: detectionUsable || input.activeMitigationPersonnel > 0,
      mitigationUsable: true,
      mutualAidAvailable: input.mutualAidAuthorized,
      reasons: [],
    };
  }

  if (detectionUsable) {
    return {
      state: "detection_ready",
      locallyUsable: true,
      detectionUsable: true,
      mitigationUsable: false,
      mutualAidAvailable: input.mutualAidAuthorized,
      reasons: mitigationTier
        ? ["Mitigation tier exists, but no currently usable certified-operator/system combination is available."]
        : [],
    };
  }

  const hasSomeLocalPieces =
    input.activeDetectionPersonnel > 0 ||
    input.activeMitigationPersonnel > 0 ||
    input.availableDetectionSystems > 0 ||
    input.availableMitigationSystems > 0;

  if (input.mutualAidAuthorized) {
    return {
      state: "mutual_aid_only",
      locallyUsable: false,
      detectionUsable: false,
      mitigationUsable: false,
      mutualAidAvailable: true,
      reasons: hasSomeLocalPieces
        ? ["Local C-UAS capability is incomplete or unavailable for this operational period; mutual aid remains available."]
        : ["No local C-UAS capability is available; mutual aid remains available."],
    };
  }

  return {
    state: hasSomeLocalPieces ? "temporarily_unavailable" : "no_local_capability",
    locallyUsable: false,
    detectionUsable: false,
    mitigationUsable: false,
    mutualAidAvailable: false,
    reasons: hasSomeLocalPieces
      ? ["Agency has C-UAS personnel or equipment on record, but no complete currently usable capability."]
      : ["No local certified personnel/equipment combination is available."],
  };
}
