// Portable RBAC model. Mirrors db/migrations/0002_roles_seed.sql.
// Pure TypeScript: no platform SDKs, usable by any backend runtime.

export const ROLE_KEYS = [
  "agency_admin",
  "airspace_supervisor",
  "rpic",
  "visual_observer",
  "dispatcher",
  "incident_commander",
  "intel_analyst",
  "partner_agency_user",
  "system_auditor",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSION_KEYS = [
  "org.manage",
  "user.manage",
  "incident.create",
  "incident.read",
  "incident.update",
  "incident.close",
  "incident.share",
  "incident.revoke_share",
  "airspace.read",
  "airspace.propose",
  "airspace.approve",
  "aircraft.manage",
  "audit.read",
  "retention.manage",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  agency_admin: "Agency Administrator",
  airspace_supervisor: "Airspace Supervisor",
  rpic: "Remote Pilot in Command",
  visual_observer: "Visual Observer",
  dispatcher: "Dispatcher / RTCC Operator",
  incident_commander: "Incident Commander",
  intel_analyst: "Intelligence Analyst",
  partner_agency_user: "Partner-Agency User",
  system_auditor: "System Auditor",
};

export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  agency_admin: [
    "org.manage",
    "user.manage",
    "incident.read",
    "airspace.read",
    "aircraft.manage",
    "retention.manage",
    "audit.read",
  ],
  airspace_supervisor: [
    "incident.read",
    "airspace.read",
    "airspace.approve",
    "airspace.propose",
    "aircraft.manage",
  ],
  rpic: ["incident.read", "airspace.read", "airspace.propose"],
  visual_observer: ["incident.read", "airspace.read"],
  dispatcher: ["incident.create", "incident.read", "incident.update", "airspace.read"],
  incident_commander: [
    "incident.create",
    "incident.read",
    "incident.update",
    "incident.close",
    "incident.share",
    "incident.revoke_share",
    "airspace.read",
    "airspace.approve",
  ],
  intel_analyst: ["incident.read", "airspace.read"],
  partner_agency_user: ["incident.read", "airspace.read"],
  system_auditor: ["audit.read"],
};