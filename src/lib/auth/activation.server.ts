// Invitation-driven account activation.
//
// The existing acceptance path (invitations.server.ts) requires an account that
// already exists. A first-time recipient — including the very first platform
// administrator — has no account yet, so this module closes that gap WITHOUT
// weakening anything:
//
//   * the invitation token is the only thing that makes the invitation row
//     visible (RLS policy invitation_read on airs.invite_token_hash);
//   * validity (pending / unexpired / unused / not revoked) is checked here and
//     AGAIN inside acceptInvitation(), which is the single-use claim;
//   * the account e-mail is taken from the stored invitation, never from the
//     request, so an activation cannot bind a different address;
//   * the organization and role also come from the stored row;
//   * the credential is hashed with the standard PBKDF2 helper, and the caller
//     must then hold a normal authenticated session like every other user;
//   * if an account for the invited address already exists, activation refuses
//     and the recipient is sent through normal sign-in + acceptance, so no
//     duplicate account can ever be created and no existing account can be
//     taken over with a link.
import { getDatabase } from "@/lib/adapters/index.server";
import { getAuthAdapter } from "@/lib/auth/index.server";
import { authDriver } from "./oidc-config.server";
import type { RoleKey } from "@/lib/rbac/roles";

import { AccessError } from "./errors";
import { acceptInvitation, maskEmail } from "./invitations.server";
import { hashToken } from "./tokens";
import type { RequestMeta } from "./types";

interface InviteRow {
  org_id: string;
  email: string;
  role_key: RoleKey;
  status: string;
  expires_at: string;
  expired: boolean;
  org_name: string;
}

async function loadInvitation(inviteToken: string): Promise<InviteRow> {
  if (!inviteToken || inviteToken.length < 16) throw new AccessError("invitation_invalid");
  const tokenHash = await hashToken(inviteToken);
  const db = getDatabase();
  const row = await db.withContext({ "airs.invite_token_hash": tokenHash }, async (q) => {
    const found = await q.query<Omit<InviteRow, "org_name">>(
      `SELECT org_id, email, role_key, status,
              to_json(expires_at)#>>'{}' AS expires_at,
              (expires_at <= now()) AS expired
         FROM airs.invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    const invite = found[0];
    if (!invite) return null;
    await q.query("SELECT set_config('airs.org_id', $1, true)", [invite.org_id]);
    const org = await q.query<{ name: string }>(
      `SELECT name FROM airs.organizations WHERE id = $1`,
      [invite.org_id],
    );
    return { ...invite, org_name: org[0]?.name ?? "" };
  });
  if (!row) throw new AccessError("invitation_invalid");
  if (row.status === "accepted") throw new AccessError("invitation_used");
  if (row.status === "revoked") throw new AccessError("invitation_revoked");
  if (row.status !== "pending" || row.expired) throw new AccessError("invitation_expired");
  return row;
}

export interface ActivationPreview {
  orgName: string;
  roleKey: RoleKey;
  expiresAt: string;
  /** Masked so a leaked link cannot be used to harvest the address. */
  maskedEmail: string;
  /** True when an account already exists: the recipient must sign in instead. */
  accountExists: boolean;
  managedLogin: boolean;
}

export async function previewActivation(inviteToken: string): Promise<ActivationPreview> {
  const invite = await loadInvitation(inviteToken);
  const exists = await accountExists(invite.email);
  return {
    orgName: invite.org_name,
    roleKey: invite.role_key,
    expiresAt: invite.expires_at,
    maskedEmail: maskEmail(invite.email),
    accountExists: exists,
    managedLogin: authDriver() === "oidc",
  };
}

async function accountExists(email: string): Promise<boolean> {
  const db = getDatabase();
  const rows = await db.withContext({ "airs.login_email": email }, (q) =>
    q.query<{ id: string }>(`SELECT id FROM airs.accounts WHERE lower(email) = lower($1)`, [email]),
  );
  return rows.length > 0;
}

export interface ActivationResult {
  token: string;
  expiresAt: string;
  orgId: string;
  roleKey: RoleKey;
}

/**
 * Creates the account for an invited address, signs it in, and claims the
 * invitation in the same request. Returns the session token so the transport
 * layer can set the normal httpOnly session cookie.
 */
export async function activateInvitation(
  inviteToken: string,
  input: { displayName: string; password: string },
  meta: RequestMeta,
): Promise<ActivationResult> {
  if (authDriver() === "oidc") throw new AccessError("unauthenticated", "Use managed sign-in");
  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 120) {
    throw new AccessError("invalid_input", "display name must be 2-120 characters");
  }
  if (input.password.length < 12 || input.password.length > 512) {
    throw new AccessError("invalid_input", "password must be at least 12 characters");
  }

  const invite = await loadInvitation(inviteToken);
  if (await accountExists(invite.email)) {
    // Never overwrite an existing credential from a link.
    throw new AccessError("invitation_wrong_recipient", "account already exists; sign in instead");
  }

  const auth = getAuthAdapter();
  await auth.upsertIdentity({
    email: invite.email,
    displayName,
    password: input.password,
  });

  const signedIn = await auth.signIn(invite.email, input.password, meta);
  if (!signedIn.ok || !signedIn.token || !signedIn.expiresAt) {
    throw new AccessError("unauthenticated");
  }

  // Single-use claim, membership creation, role assignment and the
  // invitation.accepted audit event all happen here, inside one transaction.
  const accepted = await acceptInvitation(signedIn.token, inviteToken, meta);

  return {
    token: signedIn.token,
    expiresAt: signedIn.expiresAt,
    orgId: accepted.orgId,
    roleKey: accepted.roleKey,
  };
}
