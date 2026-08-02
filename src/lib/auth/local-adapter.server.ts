// Self-hosted authentication driver. Credentials live in airs.accounts in the
// project's own PostgreSQL database and are reached through the unprivileged
// airs_app role under forced RLS, exactly like every other table.
//
// Replacing it: implement AuthAdapter with an OIDC driver (verify the ID token,
// then call `upsertIdentity` with issuer + subject) and register it in
// src/lib/auth/index.server.ts. No application code changes.
import { getDatabase } from "@/lib/adapters/index.server";
import { recordAudit } from "@/lib/audit.server";
import { hashPassword, verifyPassword } from "./password";
import { hashToken, randomToken } from "./tokens";
import type {
  AccountIdentity,
  AuthAdapter,
  AuthenticatedContext,
  MembershipView,
  RequestMeta,
  SignInResult,
} from "./types";

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 8);
const RESET_TTL_SECONDS = 60 * 30;

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  mfa_enrolled: boolean;
}

async function loadMemberships(accountId: string): Promise<MembershipView[]> {
  const db = getDatabase();
  return db.withContext({ "airs.account_id": accountId }, async (q) => {
    const rows = await q.query<{
      id: string;
      org_id: string;
      name: string;
      slug: string;
      user_id: string;
      role_key: string;
      status: string;
    }>(
      `SELECT m.id, m.org_id, o.name, o.slug, m.user_id, m.role_key, m.status
         FROM airs.memberships m
         JOIN airs.organizations o ON o.id = m.org_id
        WHERE m.account_id = $1
        ORDER BY o.name`,
      [accountId],
    );
    return rows.map((r) => ({
      membershipId: r.id,
      orgId: r.org_id,
      orgName: r.name,
      orgSlug: r.slug,
      userId: r.user_id,
      roleKey: r.role_key as MembershipView["roleKey"],
      status: r.status as MembershipView["status"],
    }));
  });
}

/** Writes an identity-plane audit event into every org the account belongs to. */
async function auditIdentityEvent(
  accountId: string,
  action: string,
  outcome: "allow" | "deny" | "error",
  meta: RequestMeta,
  detail: Record<string, unknown> = {},
) {
  const db = getDatabase();
  const memberships = await loadMemberships(accountId);
  if (memberships.length === 0) return;
  await db.withContext({ "airs.account_id": accountId }, async (q) => {
    for (const m of memberships) {
      await recordAudit(q, {
        orgId: m.orgId,
        actorUserId: m.userId,
        action,
        resourceType: "session",
        outcome,
        detail,
        ipAddress: meta.ipAddress ?? null,
        correlationId: meta.correlationId ?? null,
      });
    }
  });
}

export function createLocalAuthAdapter(): AuthAdapter {
  const db = getDatabase();

  async function findAccountByEmail(email: string): Promise<AccountRow | null> {
    return db.withContext({ "airs.login_email": email }, async (q) => {
      const rows = await q.query<AccountRow>(
        `SELECT id, email, display_name, password_hash, status, mfa_enrolled
           FROM airs.accounts WHERE lower(email) = lower($1)`,
        [email],
      );
      return rows[0] ?? null;
    });
  }

  return {
    driver: "local",

    async signIn(email, password, meta) {
      const account = await findAccountByEmail(email);
      if (!account) return { ok: false, reason: "invalid_credentials" };

      const valid = await verifyPassword(password, account.password_hash);
      if (!valid) {
        await db.withContext({ "airs.login_email": email }, (q) =>
          q.query(
            `UPDATE airs.accounts SET failed_login_count = failed_login_count + 1, updated_at = now()
              WHERE id = $1`,
            [account.id],
          ),
        );
        await auditIdentityEvent(account.id, "auth.sign_in_failed", "deny", meta, {
          reason: "invalid_credentials",
        });
        return { ok: false, reason: "invalid_credentials" };
      }
      if (account.status !== "active") {
        await auditIdentityEvent(account.id, "auth.sign_in_failed", "deny", meta, {
          reason: "account_disabled",
        });
        return { ok: false, reason: "account_disabled" };
      }

      const memberships = await loadMemberships(account.id);
      const active = memberships.filter((m) => m.status === "active");
      const defaultOrg = active.length === 1 ? active[0].orgId : null;

      const token = randomToken();
      const tokenHash = await hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

      await db.withContext({ "airs.account_id": account.id }, async (q) => {
        await q.query(
          `INSERT INTO airs.sessions (account_id, token_hash, active_org_id, expires_at, ip_address, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            account.id,
            tokenHash,
            defaultOrg,
            expiresAt,
            meta.ipAddress ?? null,
            meta.userAgent ?? null,
          ],
        );
        await q.query(
          `UPDATE airs.accounts SET last_login_at = now(), failed_login_count = 0, updated_at = now()
            WHERE id = $1`,
          [account.id],
        );
      });

      await auditIdentityEvent(account.id, "auth.sign_in", "allow", meta, {
        driver: "local",
        organizations: active.length,
      });
      return { ok: true, token, expiresAt };
    },

    async signOut(token, meta) {
      const tokenHash = await hashToken(token);
      const rows = await db.withContext({ "airs.session_token_hash": tokenHash }, (q) =>
        q.query<{ account_id: string }>(
          `SELECT account_id FROM airs.sessions WHERE token_hash = $1`,
          [tokenHash],
        ),
      );
      const accountId = rows[0]?.account_id;
      if (!accountId) return;
      await db.withContext({ "airs.account_id": accountId }, (q) =>
        q.query(`UPDATE airs.sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]),
      );
      await auditIdentityEvent(accountId, "auth.sign_out", "allow", meta);
    },

    async resolve(token): Promise<AuthenticatedContext | null> {
      if (!token || typeof token !== "string" || token.length < 16) return null;
      const tokenHash = await hashToken(token);
      const sessionRows = await db.withContext({ "airs.session_token_hash": tokenHash }, (q) =>
        q.query<{
          id: string;
          account_id: string;
          active_org_id: string | null;
          expires_at: string;
          revoked_at: string | null;
        }>(
          `SELECT id, account_id, active_org_id, expires_at::text AS expires_at, revoked_at::text AS revoked_at
             FROM airs.sessions WHERE token_hash = $1`,
          [tokenHash],
        ),
      );
      const session = sessionRows[0];
      if (!session) return null;
      if (session.revoked_at) return null;
      if (new Date(session.expires_at).getTime() <= Date.now()) return null;

      const accountRows = await db.withContext({ "airs.account_id": session.account_id }, (q) =>
        q.query<AccountRow>(
          `SELECT id, email, display_name, password_hash, status, mfa_enrolled
             FROM airs.accounts WHERE id = $1`,
          [session.account_id],
        ),
      );
      const account = accountRows[0];
      if (!account || account.status !== "active") return null;

      await db.withContext({ "airs.account_id": account.id }, (q) =>
        q.query(`UPDATE airs.sessions SET last_seen_at = now() WHERE id = $1`, [session.id]),
      );

      return {
        session: {
          sessionId: session.id,
          accountId: account.id,
          activeOrgId: session.active_org_id,
          expiresAt: session.expires_at,
        },
        account: {
          accountId: account.id,
          email: account.email,
          displayName: account.display_name,
          mfaEnrolled: account.mfa_enrolled,
        },
        memberships: await loadMemberships(account.id),
      };
    },

    async revokeAllSessions(accountId, meta) {
      const rows = await db.withContext({ "airs.account_id": accountId }, (q) =>
        q.query<{ id: string }>(
          `UPDATE airs.sessions SET revoked_at = now()
            WHERE account_id = $1 AND revoked_at IS NULL RETURNING id`,
          [accountId],
        ),
      );
      if (rows.length) await auditIdentityEvent(accountId, "auth.session_revoked", "allow", meta);
      return rows.length;
    },

    async listSessions(accountId, currentToken) {
      const currentHash = currentToken ? await hashToken(currentToken) : null;
      const rows = await db.withContext({ "airs.account_id": accountId }, (q) =>
        q.query<{
          id: string;
          token_hash: string;
          issued_at: string;
          last_seen_at: string;
          expires_at: string;
          revoked_at: string | null;
          ip_address: string | null;
          user_agent: string | null;
        }>(
          `SELECT id, token_hash, issued_at::text AS issued_at, last_seen_at::text AS last_seen_at,
                  expires_at::text AS expires_at, revoked_at::text AS revoked_at,
                  host(ip_address) AS ip_address, user_agent
             FROM airs.sessions WHERE account_id = $1 ORDER BY issued_at DESC`,
          [accountId],
        ),
      );
      return rows.map((r) => ({
        sessionId: r.id,
        issuedAt: r.issued_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        current: currentHash !== null && r.token_hash === currentHash,
        ipAddress: r.ip_address,
        userAgent: r.user_agent,
      }));
    },

    async revokeSession(accountId, sessionId, meta) {
      const rows = await db.withContext({ "airs.account_id": accountId }, (q) =>
        q.query<{ id: string }>(
          `UPDATE airs.sessions SET revoked_at = now()
            WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING id`,
          [sessionId, accountId],
        ),
      );
      if (rows.length) await auditIdentityEvent(accountId, "auth.session_revoked", "allow", meta);
      return rows.length > 0;
    },

    async startPasswordReset(email) {
      const account = await findAccountByEmail(email);
      if (!account) return null; // never reveals whether the address exists
      const token = randomToken();
      const tokenHash = await hashToken(token);
      await db.withContext({ "airs.login_email": email }, (q) =>
        q.query(
          `UPDATE airs.accounts
              SET password_reset_token_hash = $2,
                  password_reset_expires_at = now() + ($3 || ' seconds')::interval,
                  updated_at = now()
            WHERE id = $1`,
          [account.id, tokenHash, String(RESET_TTL_SECONDS)],
        ),
      );
      return token;
    },

    async completePasswordReset(token, newPassword) {
      const tokenHash = await hashToken(token);
      // The reset token alone identifies the account (see the
      // account_reset_read RLS policy), so no e-mail enumeration is possible.
      const hash = await hashPassword(newPassword);
      return applyPasswordReset(tokenHash, hash);
    },

    async upsertIdentity({ email, displayName, password, externalIssuer, externalSubject }) {
      const existing = await findAccountByEmail(email);
      if (existing) {
        return {
          accountId: existing.id,
          email: existing.email,
          displayName: existing.display_name,
          mfaEnrolled: existing.mfa_enrolled,
        } satisfies AccountIdentity;
      }
      const passwordHash = password ? await hashPassword(password) : null;
      const rows = await db.withContext({ "airs.login_email": email }, (q) =>
        q.query<{ id: string; email: string; display_name: string; mfa_enrolled: boolean }>(
          `INSERT INTO airs.accounts (email, display_name, password_hash, external_issuer, external_subject)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, email, display_name, mfa_enrolled`,
          [email, displayName, passwordHash, externalIssuer ?? null, externalSubject ?? null],
        ),
      );
      const row = rows[0];
      return {
        accountId: row.id,
        email: row.email,
        displayName: row.display_name,
        mfaEnrolled: row.mfa_enrolled,
      };
    },
  };
}

/**
 * Consumes a password-reset token. The account row is located by the stored
 * token hash; the row's own e-mail is then supplied as the login context so the
 * update satisfies the accounts RLS policy.
 */
async function applyPasswordReset(tokenHash: string, passwordHash: string): Promise<boolean> {
  const db = getDatabase();
  return db.withContext({ "airs.password_reset_hash": tokenHash }, async (q) => {
    const rows = await q.query<{ id: string; email: string }>(
      `SELECT id, email FROM airs.accounts
        WHERE password_reset_token_hash = $1 AND password_reset_expires_at > now()`,
      [tokenHash],
    );
    const account = rows[0];
    if (!account) return false;
    await q.query("SELECT set_config('airs.login_email', $1, true)", [account.email]);
    await q.query(
      `UPDATE airs.accounts
          SET password_hash = $2, password_reset_token_hash = NULL,
              password_reset_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      [account.id, passwordHash],
    );
    // Recovery invalidates every existing session immediately.
    await q.query("SELECT set_config('airs.account_id', $1, true)", [account.id]);
    await q.query(
      `UPDATE airs.sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`,
      [account.id],
    );
    return true;
  });
}