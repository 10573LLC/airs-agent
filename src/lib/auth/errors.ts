// Typed access failures. Every deny path in the server-side chain raises one
// of these; the transport layer maps `status` onto HTTP and `code` onto a UI
// state. No message ever contains credentials or tenant data.

export type AccessCode =
  | "unauthenticated"
  | "session_invalid"
  | "no_active_org"
  | "not_a_member"
  | "membership_invited"
  | "membership_suspended"
  | "membership_revoked"
  | "forbidden"
  | "tenant_mismatch"
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_revoked"
  | "invitation_used"
  | "invitation_wrong_recipient"
  | "incident_not_found"
  | "incident_state_invalid"
  | "incident_stale_version"
  | "partner_not_eligible"
  | "participation_inactive"
  | "invalid_input"
  // Stage 6 — resource registry and readiness
  | "resource_not_found"
  | "resource_retired"
  | "invalid_status_for_category"
  | "version_conflict"
  | "incident_closed"
  | "share_not_found"
  | "share_revoked"
  | "person_not_found"
  | "qualification_not_found"
  | "shift_conflict"
  | "assignment_not_found"
  | "assignment_terminated"
  | "ics_objective_not_found"
  | "ics_position_not_found"
  | "resource_request_not_found"
  | "authority_record_not_found"
  | "threat_hypothesis_not_found"
  // Stage 7 — common operating picture and operating areas
  | "invalid_geometry"
  | "invalid_altitude_block"
  | "invalid_time_window"
  | "map_feature_not_found"
  | "operating_area_not_found"
  | "operating_area_state_invalid"
  // Stage 8 — manual airspace observations and awareness layer
  | "observation_not_found"
  | "observation_state_invalid"
  | "observation_stale_version"
  | "observation_terminal"
  | "observation_relationship_invalid"
  | "observation_gap_not_found"
  | "observation_evidence_not_found"
  | "observation_share_not_found"
  | "observation_share_revoked";

const STATUS: Record<AccessCode, number> = {
  unauthenticated: 401,
  session_invalid: 401,
  no_active_org: 409,
  not_a_member: 403,
  membership_invited: 403,
  membership_suspended: 403,
  membership_revoked: 403,
  forbidden: 403,
  tenant_mismatch: 403,
  invitation_invalid: 400,
  invitation_expired: 400,
  invitation_revoked: 400,
  invitation_used: 400,
  invitation_wrong_recipient: 403,
  incident_not_found: 404,
  incident_state_invalid: 409,
  incident_stale_version: 409,
  partner_not_eligible: 403,
  participation_inactive: 403,
  invalid_input: 400,
  resource_not_found: 404,
  resource_retired: 409,
  invalid_status_for_category: 400,
  version_conflict: 409,
  incident_closed: 409,
  share_not_found: 404,
  share_revoked: 409,
  person_not_found: 404,
  qualification_not_found: 404,
  shift_conflict: 409,
  assignment_not_found: 404,
  assignment_terminated: 409,
  ics_objective_not_found: 404,
  ics_position_not_found: 404,
  resource_request_not_found: 404,
  authority_record_not_found: 404,
  threat_hypothesis_not_found: 404,
  invalid_geometry: 400,
  invalid_altitude_block: 400,
  invalid_time_window: 400,
  map_feature_not_found: 404,
  operating_area_not_found: 404,
  operating_area_state_invalid: 409,
  observation_not_found: 404,
  observation_state_invalid: 409,
  observation_stale_version: 409,
  observation_terminal: 409,
  observation_relationship_invalid: 400,
  observation_gap_not_found: 404,
  observation_evidence_not_found: 404,
  observation_share_not_found: 404,
  observation_share_revoked: 409,
};

export class AccessError extends Error {
  readonly code: AccessCode;
  readonly status: number;
  constructor(code: AccessCode, message?: string) {
    super(message ?? code);
    this.name = "AccessError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isAccessError(value: unknown): value is AccessError {
  return value instanceof AccessError;
}
