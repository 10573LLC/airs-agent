import { getDatabase } from "@/lib/adapters/index.server";
import { recordAudit } from "@/lib/audit.server";
import { createLocalAuthAdapter } from "./local-adapter.server";
import { AccessError } from "./errors";
import { oidcConfig } from "./oidc-config.server";
import { hashToken, randomToken } from "./tokens";
import type { AuthAdapter, RequestMeta } from "./types";
import type { verifyCognitoIdToken } from "./oidc.server";

export function createOidcAuthAdapter(): AuthAdapter {
  const { issuer } = oidcConfig();
  // Both drivers use the same opaque, revocable database sessions and RLS.
  const sessions = createLocalAuthAdapter();
  return {
    ...sessions,
    driver: "oidc",
    async resolve(token) {
      // Local-driver tokens have no dot. Switching to OIDC must not keep a
      // previously issued local session authenticated without Cognito.
      if (!token?.startsWith("oidc.")) return null;
      const resolved = await sessions.resolve(token);
      if (!resolved) return null;
      const bound = await getDatabase().withContext(
        { "airs.account_id": resolved.account.accountId },
        (q) =>
          q.query<{ external_issuer: string | null; external_subject: string | null }>(
            "SELECT external_issuer, external_subject FROM airs.accounts WHERE id = $1",
            [resolved.account.accountId],
          ),
      );
      return bound[0]?.external_issuer === issuer && bound[0]?.external_subject ? resolved : null;
    },
    async signIn() {
      return { ok: false, reason: "invalid_credentials" };
    },
    async startPasswordReset() {
      return null;
    },
    async completePasswordReset() {
      return false;
    },
    async upsertIdentity() {
      throw new AccessError("unauthenticated");
    },
  };
}

/** Called only after the server has verified Cognito's signed ID token. */
export async function createOidcSession(
  identity: Awaited<ReturnType<typeof verifyCognitoIdToken>>,
  meta: RequestMeta,
) {
  const db = getDatabase();
  const token = `oidc.${randomToken()}`;
  const tokenHash = await hashToken(token);
  if (new Date(identity.expiresAt).getTime() <= Date.now())
    throw new AccessError("unauthenticated");
  await db.withContext({ "airs.login_email": identity.email }, async (q) => {
    // Email is only the lookup key allowed by RLS. Never link an existing account
    // on email alone: require the original issuer AND immutable subject.
    await q.query(
      `INSERT INTO airs.accounts (email, display_name, external_issuer, external_subject)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [identity.email, identity.displayName, identity.issuer, identity.subject],
    );
    const rows = await q.query<{
      id: string;
      status: string;
      external_issuer: string | null;
      external_subject: string | null;
    }>(
      `SELECT id, status, external_issuer, external_subject FROM airs.accounts
        WHERE lower(email) = lower($1) FOR UPDATE`,
      [identity.email],
    );
    const account = rows[0];
    if (
      !account ||
      account.status !== "active" ||
      account.external_issuer !== identity.issuer ||
      account.external_subject !== identity.subject
    )
      throw new AccessError("unauthenticated");
    await q.query("SELECT set_config('airs.account_id', $1, true)", [account.id]);
    const active = await q.query<{ org_id: string; user_id: string }>(
      "SELECT org_id, user_id FROM airs.memberships WHERE account_id = $1 AND status = 'active'",
      [account.id],
    );
    await q.query(
      `INSERT INTO airs.sessions (account_id, token_hash, active_org_id, expires_at, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        account.id,
        tokenHash,
        active.length === 1 ? active[0].org_id : null,
        identity.expiresAt,
        meta.ipAddress ?? null,
        meta.userAgent ?? null,
      ],
    );
    await q.query(
      "UPDATE airs.accounts SET last_login_at = now(), updated_at = now() WHERE id = $1",
      [account.id],
    );
    for (const membership of active) {
      await recordAudit(q, {
        orgId: membership.org_id,
        actorUserId: membership.user_id,
        action: "auth.sign_in",
        resourceType: "session",
        outcome: "allow",
        detail: { driver: "oidc" },
        ipAddress: meta.ipAddress,
        correlationId: meta.correlationId,
      });
    }
  });
  return { token, expiresAt: identity.expiresAt };
}
