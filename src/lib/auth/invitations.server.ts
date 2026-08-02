// Organization invitations. The invitation token is opaque and random; only
// its SHA-256 hash is stored, and the hash is the only way a non-member row
// becomes visible (RLS policy invitation_read on airs.invite_token_hash).
//
// Acceptance rules, all enforced server-side:
//   * the acceptor must already be authenticated;
//   * the organization and role come from the stored row, never the request;
//   * the invitation must be pending, unexpired and unused (single-use via a
//     conditional UPDATE ... WHERE status = 'pending');
//   * the acceptor's account e-mail must equal the invited e-mail.
import { getDatabase } from "@/lib/adapters/index.server";
import { recordAudit } from "@/lib/audit.server";
import { ROLE_KEYS, type RoleKey } from "@/lib/rbac/roles";

import { requireSession, withAuthorized } from "./authorize.server";
import { AccessError } from "./errors";
import { hashToken, randomToken } from "./tokens";
import type { RequestMeta } from "./types";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InvitationRow {
  id: string;
  email: string;
  roleKey: RoleKey;
  status: string;
  expiresAt: string;
  createdAt: string;
}

function assertRole(roleKey: string): asserts roleKey is RoleKey {
  if (!(ROLE_KEYS as readonly string[]).includes(roleKey)) {
    throw new AccessError("invalid_input", "unknown role");
  }
}

export async function listInvitations(
  token: string | null,
  orgId: string | null,
  meta: RequestMeta,
) {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action: "invitation.list",
      resourceType: "invitation",
      audit: false,
      meta,
    },
    async (_ctx, q) =>
      q.query<InvitationRow>(
        `SELECT id, email, role_key AS "roleKey", status,
                expires_at AS "expiresAt", created_at AS "createdAt"
           FROM airs.invitations
          WHERE org_id = airs.current_org_id()
          ORDER BY created_at DESC`,
      ),
  );
}

/**
 * Creates a pending invitation and returns the one-time token. The token is
 * returned to the inviting administrator for out-of-band delivery; it is never
 * stored in clear text and never written to the audit log.
 */
export async function createInvitation(
  token: string | null,
  orgId: string | null,
  input: { email: string; roleKey: string; ttlSeconds?: number },
  meta: RequestMeta,
) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new AccessError("invalid_input", "invalid e-mail address");
  assertRole(input.roleKey);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, 300), 60 * 60 * 24 * 30);

  const inviteToken = randomToken();
  const tokenHash = await hashToken(inviteToken);

  const result = await withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action: "invitation.created",
      resourceType: "invitation",
      detail: { email, role_key: input.roleKey },
      meta,
    },
    async (ctx, q) => {
      // Supersede any earlier pending invitation for the same address.
      await q.query(
        `UPDATE airs.invitations SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE org_id = $1 AND lower(email) = $2 AND status = 'pending'`,
        [ctx.orgId, email],
      );
      const rows = await q.query<{ id: string; expires_at: string }>(
        `INSERT INTO airs.invitations (org_id, email, role_key, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
         RETURNING id, expires_at`,
        [ctx.orgId, email, input.roleKey, tokenHash, ctx.userId, String(ttl)],
      );
      return { invitationId: rows[0].id, expiresAt: rows[0].expires_at };
    },
  );

  return { ...result, token: inviteToken, email, roleKey: input.roleKey as RoleKey };
}

export async function revokeInvitation(
  token: string | null,
  orgId: string | null,
  invitationId: string,
  meta: RequestMeta,
) {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action: "invitation.revoked",
      resourceType: "invitation",
      resourceId: invitationId,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.invitations SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id`,
        [invitationId, ctx.orgId],
      );
      if (rows.length === 0) throw new AccessError("tenant_mismatch");
      return { invitationId: rows[0].id };
    },
  );
}

/** Rotates the token of a pending invitation (resend). The old token stops working. */
export async function regenerateInvitation(
  token: string | null,
  orgId: string | null,
  invitationId: string,
  meta: RequestMeta,
) {
  const inviteToken = randomToken();
  const tokenHash = await hashToken(inviteToken);
  const result = await withAuthorized(
    {
      token,
      orgId,
      permission: "user.manage",
      action: "invitation.regenerated",
      resourceType: "invitation",
      resourceId: invitationId,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string; email: string; expires_at: string }>(
        `UPDATE airs.invitations
            SET token_hash = $3,
                expires_at = now() + ($4 || ' seconds')::interval,
                updated_at = now()
          WHERE id = $1 AND org_id = $2 AND status = 'pending'
          RETURNING id, email, expires_at`,
        [invitationId, ctx.orgId, tokenHash, String(DEFAULT_TTL_SECONDS)],
      );
      if (rows.length === 0) throw new AccessError("tenant_mismatch");
      return { invitationId: rows[0].id, email: rows[0].email, expiresAt: rows[0].expires_at };
    },
  );
  return { ...result, token: inviteToken };
}

/** Read-only preview of an invitation, for the acceptance page. */
export async function previewInvitation(inviteToken: string) {
  const tokenHash = await hashToken(inviteToken);
  const db = getDatabase();
  const rows = await db.withContext({ "airs.invite_token_hash": tokenHash }, (q) =>
    q.query<{
      email: string;
      role_key: RoleKey;
      status: string;
      expires_at: string;
      org_name: string;
    }>(
      `SELECT i.email, i.role_key, i.status, i.expires_at, o.name AS org_name
         FROM airs.invitations i
         JOIN airs.organizations o ON o.id = i.org_id
        WHERE i.token_hash = $1`,
      [tokenHash],
    ),
  );
  const row = rows[0];
  if (!row) throw new AccessError("invitation_invalid");
  return {
    email: row.email,
    roleKey: row.role_key,
    status: row.status,
    expiresAt: row.expires_at,
    orgName: row.org_name,
  };
}

/**
 * Accepts an invitation for the authenticated caller. Organization and role
 * are taken from the stored row only — the request cannot influence either.
 */
export async function acceptInvitation(
  sessionToken: string | null,
  inviteToken: string,
  meta: RequestMeta,
) {
  const auth = await requireSession(sessionToken);
  if (!inviteToken || inviteToken.length < 16) throw new AccessError("invitation_invalid");
  const tokenHash = await hashToken(inviteToken);
  const db = getDatabase();

  return db.withContext(
    { "airs.invite_token_hash": tokenHash, "airs.account_id": auth.account.accountId },
    async (q) => {
      const rows = await q.query<{
        id: string;
        org_id: string;
        email: string;
        role_key: RoleKey;
        status: string;
        expired: boolean;
      }>(
        `SELECT id, org_id, email, role_key, status, (expires_at <= now()) AS expired
           FROM airs.invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      const invite = rows[0];
      if (!invite) throw new AccessError("invitation_invalid");
      if (invite.status === "accepted") throw new AccessError("invitation_used");
      if (invite.status === "revoked") throw new AccessError("invitation_revoked");
      if (invite.status !== "pending" || invite.expired) {
        throw new AccessError("invitation_expired");
      }
      if (invite.email.toLowerCase() !== auth.account.email.toLowerCase()) {
        throw new AccessError("invitation_wrong_recipient");
      }

      // Tenant context for the writes below; SET LOCAL keeps it transaction scoped.
      await q.query("SELECT set_config('airs.org_id', $1, true)", [invite.org_id]);

      // Single-use: only the transaction that flips 'pending' proceeds.
      const claimed = await q.query<{ id: string }>(
        `UPDATE airs.invitations
            SET status = 'accepted', accepted_at = now(),
                accepted_account_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [invite.id, auth.account.accountId],
      );
      if (claimed.length === 0) throw new AccessError("invitation_used");

      const userRows = await q.query<{ id: string }>(
        `INSERT INTO airs.users (org_id, email_address, display_name, account_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, email_address)
           DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = now()
         RETURNING id`,
        [invite.org_id, invite.email, auth.account.displayName, auth.account.accountId],
      );
      const userId = userRows[0].id;
      await q.query("SELECT set_config('airs.user_id', $1, true)", [userId]);

      const membershipRows = await q.query<{ id: string }>(
        `INSERT INTO airs.memberships
           (org_id, account_id, user_id, role_key, status, activated_at)
         VALUES ($1,$2,$3,$4,'active', now())
         ON CONFLICT (org_id, account_id) DO UPDATE
           SET status = 'active', role_key = EXCLUDED.role_key,
               activated_at = now(), revoked_at = NULL, suspended_at = NULL,
               updated_at = now()
         RETURNING id`,
        [invite.org_id, auth.account.accountId, userId, invite.role_key],
      );

      await q.query(
        `INSERT INTO airs.user_roles (org_id, user_id, role_key)
         VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id, role_key) DO NOTHING`,
        [invite.org_id, userId, invite.role_key],
      );

      await recordAudit(q, {
        orgId: invite.org_id,
        actorUserId: userId,
        action: "invitation.accepted",
        resourceType: "invitation",
        resourceId: invite.id,
        outcome: "allow",
        detail: { role_key: invite.role_key },
        ipAddress: meta.ipAddress ?? null,
        correlationId: meta.correlationId ?? null,
      });

      return {
        orgId: invite.org_id,
        roleKey: invite.role_key,
        membershipId: membershipRows[0].id,
      };
    },
  );
}