// Organization membership operations. Every function runs through
// withAuthorized(), so the caller's session, active organization, membership
// status and permission are validated server-side before any SQL executes,
// and every mutation lands in the audit log inside the same transaction.
import { getDatabase } from "@/lib/adapters/index.server";
import { ROLE_KEYS, type RoleKey } from "@/lib/rbac/roles";

import { withAuthorized, requireSession, resolveMembership } from "./authorize.server";
import { AccessError } from "./errors";
import type { RequestMeta } from "./types";

export interface MemberRow {
  membershipId: string;
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  roleKey: RoleKey;
  status: string;
  activatedAt: string | null;
}

function assertRole(roleKey: string): asserts roleKey is RoleKey {
  if (!(ROLE_KEYS as readonly string[]).includes(roleKey)) {
    throw new AccessError("invalid_input", "unknown role");
  }
}

export async function listMembers(token: string | null, orgId: string | null, meta: RequestMeta) {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action: "membership.list",
      resourceType: "membership",
      audit: false,
      meta,
    },
    async (_ctx, q) =>
      q.query<MemberRow>(
        `SELECT m.id AS "membershipId", m.user_id AS "userId", m.account_id AS "accountId",
                u.email_address AS email, u.display_name AS "displayName",
                m.role_key AS "roleKey", m.status, m.activated_at AS "activatedAt"
           FROM airs.memberships m
           JOIN airs.users u ON u.id = m.user_id
          WHERE m.org_id = airs.current_org_id()
          ORDER BY u.display_name`,
      ),
  );
}

export async function readOrganization(
  token: string | null,
  orgId: string | null,
  meta: RequestMeta,
) {
  return withAuthorized(
    {
      token,
      orgId,
      permission: null,
      action: "organization.read",
      resourceType: "organization",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{
        id: string;
        slug: string;
        name: string;
        agency_type: string;
      }>(`SELECT id, slug, name, agency_type FROM airs.organizations WHERE id = $1`, [ctx.orgId]);
      const org = rows[0];
      if (!org) throw new AccessError("tenant_mismatch");
      return {
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        agencyType: org.agency_type,
        roleKey: ctx.roleKey,
        permissions: [...ctx.permissions],
      };
    },
  );
}

/** Validates the requested organization against real memberships, then pins it to the session. */
export async function selectActiveOrganization(
  token: string | null,
  orgId: string,
  meta: RequestMeta,
) {
  const auth = await requireSession(token);
  const membership = resolveMembership(auth, orgId); // throws unless active member
  const db = getDatabase();
  await db.withContext({ "airs.account_id": auth.account.accountId }, (q) =>
    q.query(`UPDATE airs.sessions SET active_org_id = $2 WHERE id = $1`, [
      auth.session.sessionId,
      membership.orgId,
    ]),
  );
  await withAuthorized(
    {
      token,
      orgId: membership.orgId,
      permission: null,
      action: "organization.select",
      resourceType: "organization",
      resourceId: membership.orgId,
      meta,
    },
    async () => null,
  );
  return {
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgSlug: membership.orgSlug,
    roleKey: membership.roleKey,
  };
}

async function updateMembership(
  token: string | null,
  orgId: string | null,
  membershipId: string,
  action: string,
  sql: string,
  params: unknown[],
  detail: Record<string, unknown>,
  meta: RequestMeta,
) {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action,
      resourceType: "membership",
      resourceId: membershipId,
      detail,
      meta,
    },
    async (ctx, q) => {
      // The membership must belong to the validated active organization. RLS
      // already enforces this; the explicit predicate makes it auditable.
      const rows = await q.query<{ id: string }>(sql, [membershipId, ctx.orgId, ...params]);
      if (rows.length === 0) throw new AccessError("tenant_mismatch");
      return { membershipId: rows[0].id };
    },
  );
}

export async function changeMemberRole(
  token: string | null,
  orgId: string | null,
  membershipId: string,
  roleKey: string,
  meta: RequestMeta,
) {
  assertRole(roleKey);
  return updateMembership(
    token,
    orgId,
    membershipId,
    "membership.role_changed",
    `UPDATE airs.memberships SET role_key = $3, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status <> 'revoked' RETURNING id`,
    [roleKey],
    { role_key: roleKey },
    meta,
  );
}

export async function suspendMembership(
  token: string | null,
  orgId: string | null,
  membershipId: string,
  meta: RequestMeta,
) {
  return updateMembership(
    token,
    orgId,
    membershipId,
    "membership.suspended",
    `UPDATE airs.memberships SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'active' RETURNING id`,
    [],
    {},
    meta,
  );
}

export async function revokeMembership(
  token: string | null,
  orgId: string | null,
  membershipId: string,
  meta: RequestMeta,
) {
  return updateMembership(
    token,
    orgId,
    membershipId,
    "membership.revoked",
    `UPDATE airs.memberships SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status <> 'revoked' RETURNING id`,
    [],
    {},
    meta,
  );
}

export async function reinstateMembership(
  token: string | null,
  orgId: string | null,
  membershipId: string,
  meta: RequestMeta,
) {
  return updateMembership(
    token,
    orgId,
    membershipId,
    "membership.reinstated",
    `UPDATE airs.memberships SET status = 'active', suspended_at = NULL, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'suspended' RETURNING id`,
    [],
    {},
    meta,
  );
}

export async function listAuditEvents(
  token: string | null,
  orgId: string | null,
  limit: number,
  meta: RequestMeta,
) {
  const capped = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "audit.read",
      action: "audit.read",
      resourceType: "audit_event",
      audit: false,
      meta,
    },
    async (_ctx, q) =>
      q.query<{
        id: string;
        action: string;
        resourceType: string;
        outcome: string;
        occurredAt: string;
        actor: string | null;
        detail: Record<string, unknown>;
      }>(
        `SELECT a.id::text AS id, a.action, a.resource_type AS "resourceType", a.outcome,
                a.occurred_at AS "occurredAt", u.display_name AS actor, a.detail
           FROM airs.audit_events a
           LEFT JOIN airs.users u ON u.id = a.actor_user_id
          WHERE a.org_id = airs.current_org_id()
          ORDER BY a.occurred_at DESC
          LIMIT $1`,
        [capped],
      ),
  );
}