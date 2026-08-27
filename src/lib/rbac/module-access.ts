import type { PermissionKey, RoleKey } from "./roles";

export type PrimaryModule =
  | "console"
  | "incidents"
  | "resources"
  | "map"
  | "awareness"
  | "simulation";

const SIMULATION_CONTROLLER_ROLES = new Set<RoleKey>([
  "platform_admin",
  "agency_admin",
  "airspace_supervisor",
  "dispatcher",
  "incident_commander",
]);

export function canRunSimulation(roleKey: RoleKey | null | undefined) {
  return roleKey ? SIMULATION_CONTROLLER_ROLES.has(roleKey) : false;
}

export function canAccessPrimaryModule(
  module: PrimaryModule,
  roleKey: RoleKey | null | undefined,
  permissions: readonly PermissionKey[] | readonly string[],
) {
  if (module === "console") return Boolean(roleKey);
  if (module === "simulation") return canRunSimulation(roleKey);
  if (roleKey === "platform_admin") return false;

  const set = new Set<string>(permissions);
  if (module === "incidents") return set.has("incident.read");
  if (module === "resources") return set.has("resource.read");
  if (module === "map") return set.has("map.read");
  if (module === "awareness") return set.has("observation.read");
  return false;
}

export function isAgencyOperationalRole(roleKey: RoleKey | null | undefined) {
  return Boolean(roleKey && roleKey !== "platform_admin");
}