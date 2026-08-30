import { ROLE_LABELS, ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "@/lib/rbac/roles";
import type { SimWalkthroughRole } from "./walkthrough";

export const AGENCY_PREVIEW_ROLES = [
  "agency_admin",
  "incident_commander",
  "dispatcher",
  "airspace_supervisor",
  "rpic",
  "visual_observer",
  "intel_analyst",
  "partner_agency_user",
] as const satisfies readonly RoleKey[];

export type AgencyPreviewRole = (typeof AGENCY_PREVIEW_ROLES)[number];

export const AGENCY_PREVIEW_ROLE_LABELS: Record<AgencyPreviewRole, string> = Object.fromEntries(
  AGENCY_PREVIEW_ROLES.map((role) => [role, ROLE_LABELS[role]]),
) as Record<AgencyPreviewRole, string>;

export function previewHasPermission(role: AgencyPreviewRole, permission: PermissionKey) {
  return ROLE_PERMISSIONS[role].includes(permission as never);
}
export function previewWalkthroughRole(role: AgencyPreviewRole): SimWalkthroughRole {
  if (role === "agency_admin") return "agency_admin";
  if (role === "incident_commander") return "incident_command";
  if (role === "dispatcher") return "dispatch_rtcc";
  return "airspace_operator";
}

export const PREVIEW_BOUNDARY =
  "Exercise agency session only — no live agency records, memberships, credentials, or authorization are created.";

export function previewRoleSummary(role: AgencyPreviewRole) {
  const permissions = ROLE_PERMISSIONS[role];
  return {
    role,
    label: ROLE_LABELS[role],
    canReadIncident: permissions.includes("incident.read"),
    canUpdateIncident: permissions.includes("incident.update"),
    canCreateObservation: permissions.includes("observation.create"),
    canReadResources: permissions.includes("resource.read"),
    canCreateResource: permissions.includes("resource.create"),
    canSetResourceStatus: permissions.includes("resource.set_status"),
    canAssignResource: permissions.includes("resource.assign_incident"),
    canReadMap: permissions.includes("map.read"),
    canReportPosition: permissions.includes("map.position.report"),
    canManageMapFeature: permissions.includes("map.feature.manage"),
    canViewParticipants: permissions.includes("incident.view_participants"),
  };
}
