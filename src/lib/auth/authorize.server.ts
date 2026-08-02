// Server-side authorization chain. This is the single enforcement point for
// every protected operation:
//
//   session token -> account -> requested organization -> active membership
//   -> assigned role -> required permission -> pooling-safe tenant GUCs
//   -> unprivileged airs_app connection under FORCE ROW LEVEL SECURITY
//   -> audit event
//
// Nothing here trusts a browser-supplied organization ID: a requested org is
// only accepted after an active membership for the resolved account is found.
import { getDatabase } from "@/lib/adapters/index.server";
import type { QueryRunner } from "@/lib/adapters/types";
import { recordAudit } from "@/lib/audit.server";
import { authorize, permissionsForRoles } from "@/lib/rbac/authorize";
import type { PermissionKey, RoleKey } from "@/lib/rbac/roles";

import { AccessError } from "./errors";
import { getAuthAdapter } from "./index.server";
import type { AuthenticatedContext, MembershipView, RequestMeta } from "./types";

export interface AuthorizedContext {
  accountId: string;
  email: string;
  displayName: string;
  sessionId: string;
  /** Tenant-scoped user record id (airs.users.id) for the active organization. */
  userId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  roleKey: RoleKey;
  permissions: Set<PermissionKey>;
  memberships: MembershipView[];
  meta: RequestMeta;
}

export interface AuthorizeOptions {
  token: string | null | undefined;
  /** Permission the endpoint requires. `null` = authenticated + active member only. */
  permission: PermissionKey | null;
  /** Organization the caller claims to be acting in. UNTRUSTED — validated here. */
  orgId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
  /** Set false for high-volume reads that should not be audited. Default true. */
  audit?: boolean;
  meta?: RequestMeta;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolves the session only. Used by endpoints that must work before an org is chosen. */
export async function requireSession(
  token: string | null | undefined,
): Promise<AuthenticatedContext> {
  const ctx = await getAuthAdapter().resolve(token);
  if (!ctx) throw new AccessError("unauthenticated");
  return ctx;
}

/** Maps a membership status onto the deny code the UI renders. */
function denyCodeForStatus(status: MembershipView["status"]) {
  switch (status) {
    case "invited":
      return "membership_invited" as const;
    case "suspended":
      return "membership_suspended" as const;
    default:
      return "membership_revoked" as const;
  }
}

/**
 * Resolves + validates the active organization membership for a session.
 * Throws AccessError on every failure path; never returns a partial result.
 */
export function resolveMembership(
  ctx: AuthenticatedContext,
  requestedOrgId?: string | null,
): MembershipView {
  const orgId = requestedOrgId ?? ctx.session.activeOrgId;
  if (!orgId) throw new AccessError("no_active_org");
  if (!UUID.test(orgId)) throw new AccessError("invalid_input");
  const membership = ctx.memberships.find((m) => m.orgId === orgId);
  if (!membership) throw new AccessError("not_a_member");
  if (membership.status !== "active") throw new AccessError(denyCodeForStatus(membership.status));
  return membership;
}

/** Writes a deny audit event when the tenant and actor are already known. */
async function auditDeny(
  membership: MembershipView,
  opts: AuthorizeOptions,
  reason: string,
): Promise<void> {
  const db = getDatabase();
  await db
    .withContext(
      { "airs.org_id": membership.orgId, "airs.user_id": membership.userId },
      (q: QueryRunner) =>
        recordAudit(q, {
          orgId: membership.orgId,
          actorUserId: membership.userId,
          action: opts.action,
          resourceType: opts.resourceType,
          resourceId: opts.resourceId ?? null,
          outcome: "deny",
          detail: { ...(opts.detail ?? {}), reason },
          ipAddress: opts.meta?.ipAddress ?? null,
          correlationId: opts.meta?.correlationId ?? null,
        }),
    )
    .catch(() => {
      /* an audit failure must never convert a deny into an allow */
    });
}

/**
 * Runs `fn` only if the full chain succeeds. The callback receives a query
 * runner bound to a transaction whose airs.* GUCs were applied with SET LOCAL,
 * so the tenant context cannot survive into the next borrower of the pooled
 * connection.
 */
export async function withAuthorized<T>(
  opts: AuthorizeOptions,
  fn: (ctx: AuthorizedContext, q: QueryRunner) => Promise<T>,
): Promise<T> {
  const auth = await requireSession(opts.token);
  const membership = resolveMembership(auth, opts.orgId);

  const decision = authorize(
    { userId: membership.userId, orgId: membership.orgId, roles: [membership.roleKey] },
    { resourceOrgId: membership.orgId, permission: opts.permission ?? "incident.read" },
  );
  if (opts.permission !== null && !decision.allowed) {
    await auditDeny(membership, opts, decision.reason);
    throw new AccessError("forbidden");
  }

  const context: AuthorizedContext = {
    accountId: auth.account.accountId,
    email: auth.account.email,
    displayName: auth.account.displayName,
    sessionId: auth.session.sessionId,
    userId: membership.userId,
    orgId: membership.orgId,
    orgSlug: membership.orgSlug,
    orgName: membership.orgName,
    roleKey: membership.roleKey,
    permissions: permissionsForRoles([membership.roleKey]),
    memberships: auth.memberships,
    meta: opts.meta ?? {},
  };

  const db = getDatabase();
  try {
    return await db.withContext(
      {
        "airs.org_id": membership.orgId,
        "airs.user_id": membership.userId,
        "airs.account_id": auth.account.accountId,
      },
      async (q) => {
        const result = await fn(context, q);
        if (opts.audit !== false) {
          await recordAudit(q, {
            orgId: membership.orgId,
            actorUserId: membership.userId,
            action: opts.action,
            resourceType: opts.resourceType,
            resourceId: opts.resourceId ?? null,
            outcome: "allow",
            detail: opts.detail ?? {},
            ipAddress: opts.meta?.ipAddress ?? null,
            correlationId: opts.meta?.correlationId ?? null,
          });
        }
        return result;
      },
    );
  } catch (error) {
    if (error instanceof AccessError) {
      await auditDeny(membership, opts, error.code);
    }
    throw error;
  }
}

/**
 * Defence in depth for resource IDs supplied by the browser: even though RLS
 * already hides other tenants' rows, an explicit comparison turns a silent
 * empty result into an auditable tenant_mismatch denial.
 */
export function assertSameOrg(ctx: AuthorizedContext, resourceOrgId: string | null | undefined) {
  if (!resourceOrgId || resourceOrgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
}