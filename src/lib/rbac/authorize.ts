import { ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "./roles";

export interface Principal {
  userId: string;
  orgId: string;
  roles: RoleKey[];
}

export interface AccessRequest {
  /** Tenant that owns the resource being accessed. */
  resourceOrgId: string;
  permission: PermissionKey;
  /** True when the resource is shared with the principal's org via an active incident share. */
  sharedWithPrincipalOrg?: boolean;
}

export type Decision =
  | { allowed: true; reason: "role_permission" | "active_share" }
  | { allowed: false; reason: "no_principal" | "tenant_mismatch" | "missing_permission" };

/** Permissions a partner org may exercise on a shared incident. Everything else is denied. */
const SHARED_PERMISSIONS: readonly PermissionKey[] = [
  "incident.read",
  "incident.view_participants",
  "airspace.read",
];

export function permissionsForRoles(roles: readonly RoleKey[]): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return out;
}

/** Default deny: every path must explicitly return allowed:true. */
export function authorize(principal: Principal | null, request: AccessRequest): Decision {
  if (!principal || !principal.orgId || !principal.userId) {
    return { allowed: false, reason: "no_principal" };
  }

  const granted = permissionsForRoles(principal.roles);
  const sameTenant = principal.orgId === request.resourceOrgId;

  if (!sameTenant) {
    if (!request.sharedWithPrincipalOrg) return { allowed: false, reason: "tenant_mismatch" };
    if (!SHARED_PERMISSIONS.includes(request.permission)) {
      return { allowed: false, reason: "missing_permission" };
    }
    if (!granted.has(request.permission)) return { allowed: false, reason: "missing_permission" };
    return { allowed: true, reason: "active_share" };
  }

  if (!granted.has(request.permission)) return { allowed: false, reason: "missing_permission" };
  return { allowed: true, reason: "role_permission" };
}
