// Pure, portable incident-room lifecycle model. No I/O, no platform SDKs — the
// same rules are used by the server services, by the tests and (read-only) by
// the interface to decide which controls to render. The server is always the
// enforcement point; the UI merely mirrors this table.

import type { PermissionKey } from "@/lib/rbac/roles";

export const INCIDENT_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "closing",
  "closed",
  "archived",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_TYPES = [
  "routine_dfr",
  "planned_event",
  "missing_person",
  "search_and_rescue",
  "fire",
  "critical_incident",
  "tactical_operation",
  "disaster",
  "infrastructure_incident",
  "unauthorized_uas_investigation",
  "counter_uas_coordination",
  "training",
  "mutual_aid",
  "other",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  routine_dfr: "Routine DFR",
  planned_event: "Planned event",
  missing_person: "Missing person",
  search_and_rescue: "Search and rescue",
  fire: "Fire",
  critical_incident: "Critical incident",
  tactical_operation: "Tactical operation",
  disaster: "Disaster",
  infrastructure_incident: "Infrastructure incident",
  unauthorized_uas_investigation: "Unauthorized UAS investigation",
  counter_uas_coordination: "Counter-UAS coordination",
  training: "Training",
  mutual_aid: "Mutual aid",
  other: "Other",
};

export const CLASSIFICATIONS = ["public", "restricted", "sensitive"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const SHARE_RULES = ["no_sharing", "view_only", "operational"] as const;
export type ShareRule = (typeof SHARE_RULES)[number];

/** The only transitions the server will ever perform. Everything else denies. */
export const ALLOWED_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  draft: ["scheduled", "active", "closed"],
  scheduled: ["active", "closed"],
  active: ["paused", "closing", "closed"],
  paused: ["active", "closing", "closed"],
  closing: ["closed"],
  closed: ["archived"],
  archived: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses in which owner metadata edits are still accepted. */
export const EDITABLE_STATUSES: readonly IncidentStatus[] = [
  "draft",
  "scheduled",
  "active",
  "paused",
];

export const TERMINAL_STATUSES: readonly IncidentStatus[] = ["closed", "archived"];

// --- incident-level access ---------------------------------------------------

export const ACCESS_LEVELS = ["view_only", "operational", "incident_command"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  view_only: "View only",
  operational: "Operational participant",
  incident_command: "Incident command",
};

/**
 * Relationship of the acting organization to the room. `origin_admin` is not an
 * access level a partner can hold — it is what the originating organization is.
 */
export type IncidentRelationship = "origin_admin" | AccessLevel;

/** Every distinct lifecycle action, each separately authorized server-side. */
export const INCIDENT_ACTIONS = [
  "read",
  "view_participants",
  "update",
  "schedule",
  "activate",
  "pause",
  "resume",
  "begin_closure",
  "close",
  "archive",
  "invite_partner",
  "approve_partner",
  "restrict_partner",
  "revoke_partner",
  "remove_partner",
  "withdraw",
  "read_audit",
] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

/** Organization-level permission each action additionally requires. */
export const ACTION_PERMISSION: Record<IncidentAction, PermissionKey> = {
  read: "incident.read",
  view_participants: "incident.view_participants",
  update: "incident.update",
  schedule: "incident.update",
  activate: "incident.activate",
  pause: "incident.pause",
  resume: "incident.resume",
  begin_closure: "incident.close",
  close: "incident.close",
  archive: "incident.archive",
  invite_partner: "incident.invite_partner",
  approve_partner: "incident.approve_partner",
  restrict_partner: "incident.restrict_partner",
  revoke_partner: "incident.revoke_share",
  remove_partner: "incident.remove_partner",
  withdraw: "incident.read",
  read_audit: "incident.read",
};

/**
 * Incident-level matrix. Membership role permissions are checked SEPARATELY:
 * an action is permitted only when BOTH this matrix and the organization
 * permission allow it. Default deny — anything absent is denied.
 */
const RELATIONSHIP_ACTIONS: Record<IncidentRelationship, readonly IncidentAction[]> = {
  origin_admin: [...INCIDENT_ACTIONS],
  // Incident command: lifecycle actions the originating org explicitly granted.
  incident_command: [
    "read",
    "view_participants",
    "pause",
    "resume",
    "begin_closure",
    "withdraw",
    "read_audit",
  ],
  operational: ["read", "view_participants", "withdraw"],
  view_only: ["read", "view_participants"],
};

export function incidentLevelAllows(
  relationship: IncidentRelationship,
  action: IncidentAction,
): boolean {
  return (RELATIONSHIP_ACTIONS[relationship] ?? []).includes(action);
}

/** Actions a partner organization may never perform, regardless of level. */
export const OWNER_ONLY_ACTIONS: readonly IncidentAction[] = [
  "update",
  "schedule",
  "activate",
  "close",
  "archive",
  "invite_partner",
  "approve_partner",
  "restrict_partner",
  "revoke_partner",
  "remove_partner",
];

// --- participation model -----------------------------------------------------

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
  "expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const PARTICIPATION_STATUSES = [
  "invited",
  "pending_approval",
  "active",
  "restricted",
  "suspended",
  "revoked",
  "expired",
  "removed",
  "declined",
] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];

/** Participation states that convey any access at all. */
export const LIVE_PARTICIPATION: readonly ParticipationStatus[] = ["active", "restricted"];

export const TRUST_STATUSES = [
  "pending",
  "approved",
  "restricted",
  "suspended",
  "revoked",
] as const;
export type TrustStatus = (typeof TRUST_STATUSES)[number];

/** Only an approved relationship makes an organization eligible for invitation. */
export function trustAllowsInvitation(status: TrustStatus | null | undefined): boolean {
  return status === "approved";
}