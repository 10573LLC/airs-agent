import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOidcSession, createOidcAuthAdapter } from "@/lib/auth/oidc-adapter.server";
import { getAuthAdapter, resetAuthAdapter } from "@/lib/auth/index.server";
import { hashToken, randomToken } from "@/lib/auth/tokens";
import { acceptInvitation } from "@/lib/auth/invitations.server";
import { activateInvitation } from "@/lib/auth/activation.server";

const enabled = !!(process.env.TEST_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL);
const run = randomToken(8);
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
const identity = (name: string) => ({
  issuer,
  subject: `${run}-${name}`,
  email: `${run}-${name}@example.test`,
  displayName: name,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
const orgId = "11111111-1111-4111-8111-111111111111";
let admin: Client;

describe.skipIf(!enabled)("OIDC sessions under forced RLS", () => {
  beforeAll(async () => {
    vi.stubEnv("AUTH_DRIVER", "oidc");
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.stubEnv("OIDC_DOMAIN", "https://test.auth.us-east-1.amazoncognito.com");
    vi.stubEnv("AIRS_PUBLIC_BASE_URL", "https://app.example.test");
    vi.stubEnv("OIDC_CLIENT_ID", "test-client");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
    vi.stubEnv("SESSION_SECRET", "test-only-cookie-key-32-characters-long");
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
    resetAuthAdapter();
    admin = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.query("DELETE FROM airs.invitations WHERE email LIKE $1", [`${run}-%`]);
    await admin.query(
      "DELETE FROM airs.audit_events WHERE actor_user_id IN (SELECT id FROM airs.users WHERE email_address LIKE $1)",
      [`${run}-%`],
    );
    await admin.query("DELETE FROM airs.users WHERE email_address LIKE $1", [`${run}-%`]);
    await admin.query("DELETE FROM airs.accounts WHERE email LIKE $1", [`${run}-%`]);
    await admin.end();
    vi.unstubAllEnvs();
    resetAuthAdapter();
  });
  it("uses the unprivileged runtime role", async () => {
    const { getDatabase } = await import("@/lib/adapters/index.server");
    const rows = await getDatabase().withContext({}, (q) =>
      q.query<{ current_user: string }>("SELECT current_user"),
    );
    expect(rows[0].current_user).toBe("airs_app");
  });
  it("passes readiness with the migrated schema and rejects incomplete OIDC configuration", async () => {
    const { checkReadiness } = await import("@/lib/readiness.server");
    vi.stubEnv("AUTH_DRIVER", "local");
    await expect(checkReadiness()).resolves.toBeUndefined();
    vi.stubEnv("AUTH_DRIVER", "oidc");
    vi.stubEnv("OIDC_ISSUER", "");
    await expect(checkReadiness()).rejects.toThrow();
    vi.stubEnv("OIDC_ISSUER", issuer);
  });
  it("creates a revocable opaque session without granting agency access", async () => {
    const who = identity("new");
    const session = await createOidcSession(who, {});
    const resolved = await getAuthAdapter().resolve(session.token);
    expect(resolved?.account.email).toBe(who.email);
    expect(resolved?.memberships).toEqual([]);
    expect(resolved?.session.activeOrgId).toBeNull();
    const row = (
      await admin.query("SELECT token_hash FROM airs.sessions WHERE account_id = $1", [
        resolved!.account.accountId,
      ])
    ).rows[0];
    expect(row.token_hash).toBe(await hashToken(session.token));
    expect(row.token_hash).not.toBe(session.token);
    await getAuthAdapter().signOut(session.token, {});
    expect(await getAuthAdapter().resolve(session.token)).toBeNull();
  });
  it("never links an existing local account by matching email", async () => {
    const who = identity("local");
    await admin.query("INSERT INTO airs.accounts (email, display_name) VALUES ($1,$2)", [
      who.email,
      who.displayName,
    ]);
    await expect(createOidcSession(who, {})).rejects.toThrow();
    const rows = await admin.query("SELECT external_subject FROM airs.accounts WHERE email = $1", [
      who.email,
    ]);
    expect(rows.rows[0].external_subject).toBeNull();
  });
  it("rejects existing local sessions after switching drivers", async () => {
    const who = identity("old-session");
    const accounts = await admin.query(
      "INSERT INTO airs.accounts (email, display_name) VALUES ($1,$2) RETURNING id",
      [who.email, who.displayName],
    );
    const token = randomToken();
    await admin.query(
      "INSERT INTO airs.sessions (account_id, token_hash, expires_at) VALUES ($1,$2,now() + interval '1 hour')",
      [accounts.rows[0].id, await hashToken(token)],
    );
    const { createLocalAuthAdapter } = await import("@/lib/auth/local-adapter.server");
    expect(await createLocalAuthAdapter().resolve(token)).not.toBeNull();
    expect(await getAuthAdapter().resolve(token)).toBeNull();
  });
  it("rejects a changed subject or issuer, disabled account and expired identity", async () => {
    const who = identity("binding");
    await createOidcSession(who, {});
    await expect(createOidcSession({ ...who, subject: "another" }, {})).rejects.toThrow();
    await expect(createOidcSession({ ...who, issuer: `${issuer}other` }, {})).rejects.toThrow();
    await expect(
      createOidcSession({ ...who, expiresAt: new Date(0).toISOString() }, {}),
    ).rejects.toThrow();
    await admin.query("UPDATE airs.accounts SET status = 'disabled' WHERE email = $1", [who.email]);
    await expect(createOidcSession(who, {})).rejects.toThrow();
  });
  it("disables every local credential entry point", async () => {
    const auth = createOidcAuthAdapter();
    expect((await auth.signIn("person@example.test", "password", {})).ok).toBe(false);
    expect(await auth.startPasswordReset("person@example.test")).toBeNull();
    expect(await auth.completePasswordReset("token", "password")).toBe(false);
    await expect(
      auth.upsertIdentity({ email: "person@example.test", displayName: "Person" }),
    ).rejects.toThrow();
    await expect(
      activateInvitation("token", { displayName: "Person", password: "long-enough-password" }, {}),
    ).rejects.toThrow();
  });
  it("requires a matching single-use invitation before granting its stored role", async () => {
    const who = identity("invited");
    const session = await createOidcSession(who, {});
    const other = await createOidcSession(identity("wrong-recipient"), {});
    const invite = randomToken();
    await admin.query(
      `INSERT INTO airs.invitations (org_id, email, role_key, token_hash, expires_at)
      VALUES ($1,$2,'agency_admin',$3,now() + interval '1 hour')`,
      [orgId, who.email, await hashToken(invite)],
    );
    await expect(acceptInvitation(other.token, invite, {})).rejects.toThrow();
    const accepted = await acceptInvitation(session.token, invite, {});
    expect(accepted.orgId).toBe(orgId);
    expect(accepted.roleKey).toBe("agency_admin");
    await expect(acceptInvitation(session.token, invite, {})).rejects.toThrow();
    const auth = await getAuthAdapter().resolve(session.token);
    expect(auth!.memberships).toHaveLength(1);
    expect(auth!.memberships[0].roleKey).toBe("agency_admin");
    // A subsequent sign-in selects the sole active agency and records an audit.
    const next = await createOidcSession(who, {});
    expect((await getAuthAdapter().resolve(next.token))!.session.activeOrgId).toBe(orgId);
  });
});
