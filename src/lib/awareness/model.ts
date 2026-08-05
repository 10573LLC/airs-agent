// Portable Awareness domain model (Stage 8).
//
// Mirrors db/migrations/0010_awareness_observations.sql exactly; the parity
// suite in tests/awareness.test.ts fails the build if the two ever drift.
//
// An observation is INFORMATION, not a determination. Three independent scales
// are recorded and NEVER combined into a score, verdict or recommendation:
//   * source reliability      — how dependable the SOURCE has proven to be
//   * information credibility — how plausible THIS reported information is
//   * analyst confidence      — how sure the REVIEWER is of their assessment
// The interface always shows them separately, and the server never derives one
// from another.
//
// Pure TypeScript: no I/O, no SQL, no map SDK, no platform service.

import type { Geometry, PrecisionPolicy } from "@/lib/map/model";
import type { DisclosureProfile } from "@/lib/resources/disclosure";

// --- what was observed --------------------------------------------------------

export const OBSERVATION_TYPES = [
  "unidentified_aircraft",
  "authorized_public_safety_aircraft",
  "suspected_unauthorized_uas",
  "manned_aircraft_activity",
  "remote_id_observation_manual",
  "airspace_conflict",
  "flight_safety_hazard",
  "ground_hazard_air_ops",
  "communications_issue",
  "navigation_positioning_issue",
  "dock_launch_site_issue",
  "sensor_detection_issue",
  "critical_asset_concern",
  "temporary_operating_condition",
  "public_report",
  "partner_agency_report",
  "other_observation",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const OBSERVATION_TYPE_LABELS: Record<ObservationType, string> = {
  unidentified_aircraft: "Unidentified aircraft",
  authorized_public_safety_aircraft: "Authorized public-safety aircraft",
  suspected_unauthorized_uas: "Suspected unauthorized UAS",
  manned_aircraft_activity: "Crewed-aircraft activity",
  remote_id_observation_manual: "Remote ID observation (manually entered)",
  airspace_conflict: "Airspace conflict",
  flight_safety_hazard: "Flight-safety hazard",
  ground_hazard_air_ops: "Ground hazard affecting air operations",
  communications_issue: "Communications issue",
  navigation_positioning_issue: "Navigation or positioning issue",
  dock_launch_site_issue: "Dock or launch-site issue",
  sensor_detection_issue: "Sensor or detection issue",
  critical_asset_concern: "Critical-asset concern",
  temporary_operating_condition: "Temporary operating condition",
  public_report: "Public report",
  partner_agency_report: "Partner-agency report",
  other_observation: "Other observation",
};

// --- where the report came from ----------------------------------------------

export const OBSERVATION_SOURCES = [
  "direct_reporting_user",
  "direct_other_agency_member",
  "public_report",
  "partner_agency_report",
  "dispatch_communications_report",
  "manual_sensor_reading",
  "human_reviewed_media",
  "document_written_report",
  "other_source",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const OBSERVATION_SOURCE_LABELS: Record<ObservationSource, string> = {
  direct_reporting_user: "Direct — reporting user",
  direct_other_agency_member: "Direct — other agency member",
  public_report: "Public report",
  partner_agency_report: "Partner-agency report",
  dispatch_communications_report: "Dispatch or communications report",
  manual_sensor_reading: "Manually entered sensor reading",
  human_reviewed_media: "Human-reviewed media",
  document_written_report: "Document or written report",
  other_source: "Other source",
};

/**
 * Sources whose restricted detail plane (reporter identity, contact, source
 * notes) must be treated as protected even inside the originating agency's
 * printable views.
 */
export const PROTECTED_SOURCE_TYPES: readonly ObservationSource[] = [
  "public_report",
  "human_reviewed_media",
  "document_written_report",
];

// --- the three independent scales --------------------------------------------

export const SOURCE_RELIABILITY = [
  "unknown",
  "unreliable",
  "questionable",
  "usually_reliable",
  "reliable",
  "highly_reliable",
] as const;
export type SourceReliability = (typeof SOURCE_RELIABILITY)[number];

export const SOURCE_RELIABILITY_LABELS: Record<SourceReliability, string> = {
  unknown: "Reliability not assessed",
  unreliable: "Unreliable source",
  questionable: "Questionable source",
  usually_reliable: "Usually reliable source",
  reliable: "Reliable source",
  highly_reliable: "Highly reliable source",
};

export const INFORMATION_CREDIBILITY = [
  "unknown",
  "improbable",
  "doubtful",
  "possibly_true",
  "probably_true",
  "confirmed",
] as const;
export type InformationCredibility = (typeof INFORMATION_CREDIBILITY)[number];

export const INFORMATION_CREDIBILITY_LABELS: Record<InformationCredibility, string> = {
  unknown: "Credibility not assessed",
  improbable: "Improbable information",
  doubtful: "Doubtful information",
  possibly_true: "Possibly true information",
  probably_true: "Probably true information",
  confirmed: "Confirmed by another source",
};

export const CONFIDENCE_LEVELS = ["unknown", "low", "moderate", "high", "very_high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  unknown: "Confidence not stated",
  low: "Low analyst confidence",
  moderate: "Moderate analyst confidence",
  high: "High analyst confidence",
  very_high: "Very high analyst confidence",
};

// --- review lifecycle ---------------------------------------------------------

export const VERIFICATION_STATUSES = [
  "unreviewed",
  "under_review",
  "corroborated",
  "confirmed",
  "disputed",
  "unable_to_verify",
  "rejected",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  unreviewed: "Unreviewed",
  under_review: "Under review",
  corroborated: "Corroborated by another observation",
  confirmed: "Confirmed by an authorized reviewer",
  disputed: "Disputed",
  unable_to_verify: "Unable to verify",
  rejected: "Rejected",
};

/** Statuses that require the `observation.verify` permission. */
export const VERIFY_STATUSES: readonly VerificationStatus[] = ["corroborated", "confirmed"];
/** Statuses that require the `observation.reject` permission. */
export const REJECT_STATUSES: readonly VerificationStatus[] = [
  "disputed",
  "unable_to_verify",
  "rejected",
];
/** Statuses reachable with `observation.review` alone. */
export const REVIEW_STATUSES: readonly VerificationStatus[] = ["under_review"];

/**
 * Permitted verification transitions. Default deny: a pair absent from this
 * table is refused before any database write is attempted.
 */
export const VERIFICATION_TRANSITIONS: Record<VerificationStatus, readonly VerificationStatus[]> = {
  unreviewed: [
    "under_review",
    "corroborated",
    "confirmed",
    "disputed",
    "unable_to_verify",
    "rejected",
  ],
  under_review: ["corroborated", "confirmed", "disputed", "unable_to_verify", "rejected"],
  corroborated: ["confirmed", "disputed", "unable_to_verify", "under_review"],
  confirmed: ["disputed", "under_review"],
  disputed: ["under_review", "corroborated", "confirmed", "unable_to_verify", "rejected"],
  unable_to_verify: ["under_review", "corroborated", "confirmed", "disputed"],
  rejected: ["under_review"],
};

export function canTransitionVerification(
  from: VerificationStatus,
  to: VerificationStatus,
): boolean {
  return (VERIFICATION_TRANSITIONS[from] ?? []).includes(to);
}

/** The permission a target verification status demands. */
export function permissionForVerification(
  to: VerificationStatus,
): "observation.review" | "observation.verify" | "observation.reject" {
  if (VERIFY_STATUSES.includes(to)) return "observation.verify";
  if (REJECT_STATUSES.includes(to)) return "observation.reject";
  return "observation.review";
}

export const LIFECYCLE_STATUSES = [
  "open",
  "monitoring",
  "action_required",
  "resolved",
  "closed",
  "cancelled",
  "expired",
] as const;
export type ObservationLifecycle = (typeof LIFECYCLE_STATUSES)[number];

export const LIFECYCLE_LABELS: Record<ObservationLifecycle, string> = {
  open: "Open",
  monitoring: "Monitoring",
  action_required: "Action required",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const TERMINAL_LIFECYCLE: readonly ObservationLifecycle[] = [
  "closed",
  "cancelled",
  "expired",
];

export const URGENCY_LEVELS = ["routine", "elevated", "priority", "immediate"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  routine: "Routine",
  elevated: "Elevated",
  priority: "Priority",
  immediate: "Immediate",
};

export const TIME_PRECISIONS = ["exact", "estimated", "unknown"] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

export const TIME_PRECISION_LABELS: Record<TimePrecision, string> = {
  exact: "Exact observed time",
  estimated: "Estimated observed time",
  unknown: "Observed time unknown",
};

// --- location -----------------------------------------------------------------

export const OBSERVATION_LOCATION_KINDS = [
  "map_feature",
  "operating_area",
  "resource_location",
  "manual_point",
  "manual_shape",
  "none",
] as const;
export type ObservationLocationKind = (typeof OBSERVATION_LOCATION_KINDS)[number];

export const OBSERVATION_LOCATION_LABELS: Record<ObservationLocationKind, string> = {
  map_feature: "Existing map feature",
  operating_area: "Existing operating area",
  resource_location: "Reported resource location",
  manual_point: "Manually entered point",
  manual_shape: "Manually entered shape",
  none: "No location recorded",
};

// --- freshness ----------------------------------------------------------------

export const OBSERVATION_FRESHNESS = [
  "current",
  "recent",
  "aging",
  "stale",
  "expired",
  "unknown",
] as const;
export type ObservationFreshness = (typeof OBSERVATION_FRESHNESS)[number];

export const OBSERVATION_FRESHNESS_LABELS: Record<ObservationFreshness, string> = {
  current: "Current",
  recent: "Recent",
  aging: "Aging",
  stale: "Stale",
  expired: "Expired",
  unknown: "Observed time unknown",
};

/**
 * Mirrors airs.observation_freshness_thresholds. Freshness is derived from the
 * SERVER clock and the observation type — never from lifecycle status and never
 * from a value supplied by a client.
 */
export const FRESHNESS_THRESHOLDS: Record<
  string,
  { currentMinutes: number; recentMinutes: number; agingMinutes: number }
> = {
  default: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  unidentified_aircraft: { currentMinutes: 5, recentMinutes: 15, agingMinutes: 60 },
  suspected_unauthorized_uas: { currentMinutes: 5, recentMinutes: 15, agingMinutes: 60 },
  airspace_conflict: { currentMinutes: 5, recentMinutes: 15, agingMinutes: 60 },
  manned_aircraft_activity: { currentMinutes: 5, recentMinutes: 20, agingMinutes: 90 },
  remote_id_observation_manual: { currentMinutes: 5, recentMinutes: 15, agingMinutes: 60 },
  flight_safety_hazard: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  ground_hazard_air_ops: { currentMinutes: 30, recentMinutes: 120, agingMinutes: 480 },
  communications_issue: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  navigation_positioning_issue: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  dock_launch_site_issue: { currentMinutes: 30, recentMinutes: 120, agingMinutes: 480 },
  sensor_detection_issue: { currentMinutes: 30, recentMinutes: 120, agingMinutes: 480 },
  critical_asset_concern: { currentMinutes: 60, recentMinutes: 240, agingMinutes: 1440 },
  temporary_operating_condition: { currentMinutes: 60, recentMinutes: 240, agingMinutes: 1440 },
  public_report: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  partner_agency_report: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
  authorized_public_safety_aircraft: { currentMinutes: 5, recentMinutes: 20, agingMinutes: 90 },
  other_observation: { currentMinutes: 15, recentMinutes: 60, agingMinutes: 240 },
};

export function observationFreshness(
  type: ObservationType | string,
  observedAt: string | null | undefined,
  visibleUntil: string | null | undefined,
  now: number = Date.now(),
): ObservationFreshness {
  if (visibleUntil) {
    const until = Date.parse(visibleUntil);
    if (!Number.isNaN(until) && until <= now) return "expired";
  }
  if (!observedAt) return "unknown";
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return "unknown";
  const t = FRESHNESS_THRESHOLDS[type] ?? FRESHNESS_THRESHOLDS["default"]!;
  const minutes = (now - observed) / 60000;
  if (minutes < t.currentMinutes) return "current";
  if (minutes < t.recentMinutes) return "recent";
  if (minutes < t.agingMinutes) return "aging";
  return "stale";
}

// --- relationships, gaps, evidence -------------------------------------------

export const RELATIONSHIP_TYPES = [
  "supports",
  "corroborates",
  "contradicts",
  "possible_duplicate",
  "updates",
  "supersedes",
  "related_to",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  supports: "Supports",
  corroborates: "Corroborates",
  contradicts: "Contradicts",
  possible_duplicate: "Possible duplicate of",
  updates: "Updates",
  supersedes: "Supersedes",
  related_to: "Related to",
};

/**
 * Relationships that count towards corroboration. Corroboration is DISPLAYED
 * as evidence for a reviewer; it never changes a verification status on its
 * own and no automated conclusion is derived from it.
 */
export const CORROBORATING_RELATIONSHIPS: readonly RelationshipType[] = [
  "supports",
  "corroborates",
];
export const CONFLICTING_RELATIONSHIPS: readonly RelationshipType[] = ["contradicts"];

export const GAP_TYPES = [
  "identity_unknown",
  "location_uncertain",
  "time_uncertain",
  "authorization_unknown",
  "aircraft_type_unknown",
  "operator_unknown",
  "intent_unknown",
  "additional_witness_needed",
  "additional_imagery_needed",
  "sensor_confirmation_needed",
  "partner_confirmation_needed",
  "policy_legal_review_needed",
  "other_gap",
] as const;
export type GapType = (typeof GAP_TYPES)[number];

export const GAP_LABELS: Record<GapType, string> = {
  identity_unknown: "Identity unknown",
  location_uncertain: "Location uncertain",
  time_uncertain: "Time uncertain",
  authorization_unknown: "Authorization unknown",
  aircraft_type_unknown: "Aircraft type unknown",
  operator_unknown: "Operator unknown",
  intent_unknown: "Intent unknown",
  additional_witness_needed: "Additional witness needed",
  additional_imagery_needed: "Additional imagery needed",
  sensor_confirmation_needed: "Sensor confirmation needed",
  partner_confirmation_needed: "Partner confirmation needed",
  policy_legal_review_needed: "Policy or legal review needed",
  other_gap: "Other information gap",
};

export const GAP_STATUSES = ["open", "resolved", "cancelled"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const EVIDENCE_TYPES = [
  "photograph",
  "video",
  "screenshot",
  "document",
  "audio",
  "dispatch_record",
  "sensor_export",
  "external_case_number",
  "other_evidence",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_LABELS: Record<EvidenceType, string> = {
  photograph: "Photograph",
  video: "Video",
  screenshot: "Screenshot",
  document: "Document",
  audio: "Audio",
  dispatch_record: "Dispatch record",
  sensor_export: "Sensor export",
  external_case_number: "External case number",
  other_evidence: "Other evidence",
};

export const ANNOTATION_TYPES = [
  "review_note",
  "correction",
  "clarification",
  "reviewer_assessment",
  "status_rationale",
] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

export const ANNOTATION_LABELS: Record<AnnotationType, string> = {
  review_note: "Review note",
  correction: "Correction",
  clarification: "Clarification",
  reviewer_assessment: "Reviewer assessment",
  status_rationale: "Status rationale",
};

export const OBSERVATION_CLASSIFICATIONS = [
  "participating_orgs",
  "public_safety_only",
  "law_enforcement_sensitive",
  "aviation_personnel_only",
  "incident_command_only",
  "originating_org_only",
  "named_recipients",
] as const;
export type ObservationClassification = (typeof OBSERVATION_CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<ObservationClassification, string> = {
  participating_orgs: "Participating organizations",
  public_safety_only: "Public safety only",
  law_enforcement_sensitive: "Law-enforcement sensitive",
  aviation_personnel_only: "Aviation personnel only",
  incident_command_only: "Incident command only",
  originating_org_only: "Originating organization only",
  named_recipients: "Named recipients only",
};

/**
 * Restricted source fields. These are stripped from every partner payload by
 * construction in the service layer — no profile, custom field list, query
 * parameter or header can request them.
 */
export const RESTRICTED_SOURCE_FIELDS = [
  "sourceDetail",
  "reporterIdentity",
  "reporterContact",
  "internalNotes",
  "internalCaseNumber",
] as const;

/** Owner bookkeeping that is meaningless — and revealing — outside the owner. */
export const OWNER_ONLY_FIELDS = [
  "classification",
  "declaredPrecision",
  "disclosureProfile",
  "visibleFrom",
  "visibleUntil",
] as const;

// --- shared view types --------------------------------------------------------

export interface ObservationEnvelope {
  precision: PrecisionPolicy;
  /** Absent entirely when no geography may be released. Never null-islanded. */
  geometry?: Geometry;
}

export interface ObservationSummary extends ObservationEnvelope {
  id: string;
  orgId: string;
  ownerOrgName: string;
  relationship: "owner" | "partner";
  incidentId: string | null;
  observationType: ObservationType;
  title: string;
  description: string;
  observedObject: string;
  observedBehavior: string;
  observedCount: number | null;
  observedAltitudeFt: number | null;
  observedAt: string | null;
  observedTimePrecision: TimePrecision;
  reportedAt: string;
  locationKind: ObservationLocationKind;
  sourceType: ObservationSource;
  sourceReliability: SourceReliability;
  informationCredibility: InformationCredibility;
  confidenceLevel: ConfidenceLevel;
  verificationStatus: VerificationStatus;
  urgency: UrgencyLevel;
  lifecycleStatus: ObservationLifecycle;
  freshness: ObservationFreshness;
  disclosureProfile?: DisclosureProfile;
  classification?: ObservationClassification;
  declaredPrecision?: PrecisionPolicy;
  visibleFrom?: string;
  visibleUntil?: string | null;
  /** Restricted plane. Present only for the originating organization. */
  sourceDetail?: string;
  reporterIdentity?: string;
  reporterContact?: string;
  internalNotes?: string;
  internalCaseNumber?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
