// Authentication + authorization integration tests.
//
// These exercise the REAL enforcement chain against a real PostgreSQL server:
// the adapter connects as the unprivileged `airs_app` role, so every assertion
// below is subject to FORCE ROW LEVEL SECURITY as well as the application-level
// checks in withAuthorized().
//
// Required environment:
//   TEST_DATABASE_URL        connection string for the airs_app role
//   TEST_ADMIN_DATABASE_URL  connection string used ONLY to create fixtures
//
// Without them the suite skips (unit suites still run), so a checkout with no
// database can still be verified.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(APP_URL && ADMIN_URL);

// The adapter reads DATABASE_URL at first use; point it at the app role.
if (APP_URL) process.env.DATABASE_URL = APP_URL;

const ORG_A = "11111111-1111-4111-8111-111111111111"; // Albany Police Department
const ORG_B = "22222222-2222-4222-8222-222222222222"; // Albany County
const RUN = Math.random().toString(36).slice(2, 10);
const meta = { ipAddress: "127.0.0.1", userAgent: "vitest", correlationId: `test-${RUN}` };

const email = (name: string) => `it.${name}.${RUN}@example.test`;
const PASSWORD = "Correct-Horse-Battery-Staple-9";

type Auth = typeof import("@/lib/auth/index.server");
type Invites = typeof import("@/lib/auth/invitations.server");
type Members = typeof import("@/lib/auth/memberships.server");
type Authorize = typeof import("@/lib/auth/authorize.server");

let auth: Auth;
let invites: Invites;
let members: Members;
let authorize: Authorize;
let db: typeof import("@/lib/adapters/index.server");
let admin: Client;

/** Creates an account + tenant user + membership directly, as the owner role. */
async function seedMember(
  name: string,
  orgId: string,
  roleKey: string,
  status: string,
  withPassword = true,
) {
  const { hashPassword } = await import("@/lib/auth/password");
  const hash = withPassword ? await hashPassword(PASSWORD) : null;
  const addr = email(name);
  const acct = await admin.query<{ id: string }>(
    `INSERT INTO airs.accounts (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [addr, `IT ${name}`, hash],
  );
  const accountId = acct.rows[0].id;
  const user = await admin.query<{ id: string }>(
    `INSERT INTO airs.users (org_id, email_address, display_name, account_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, addr, `IT ${name}`, accountId],
  );
  const userId = user.rows[0].id;
  await admin.query(
    `INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [orgId, accountId, userId, roleKey, status],
  );
  await admin.query(
    `INSERT INTO airs.user_roles (org_id, user_id, role_key) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [orgId, userId, roleKey],
  );
  return { accountId, userId, email: addr };
}

/** Creates an account with no membership anywhere. */
async function seedAccount(name: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const addr = email(name);
  const acct = await admin.query<{ id: string }>(
    `INSERT INTO airs.accounts (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [addr, `IT ${name}`, await hashPassword(PASSWORD)],
  );
  return { accountId: acct.rows[0].id, email: addr };
}

let adminA: Awaited<ReturnType<typeof seedMember>>;
let observerA: Awaited<ReturnType<typeof seedMember>>;
let adminB: Awaited<ReturnType<typeof seedMember>>;
let suspendedA: Awaited<ReturnType<typeof seedMember>>;
let invitee: Awaited<ReturnType<typeof seedAccount>>;

let adminAToken = "";
let observerAToken = "";
let adminBToken = "";
let inviteeToken = "";

async function signIn(addr: string) {
  const result = await auth.getAuthAdapter().signIn(addr, PASSWORD, meta);
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return result.token;
}

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  auth = await import("@/lib/auth/index.server");
  invites = await import("@/lib/auth/invitations.server");
  members = await import("@/lib/auth/memberships.server");
  authorize = await import("@/lib/auth/authorize.server");
  db = await import("@/lib/adapters/index.server");

  adminA = await seedMember("admin-a", ORG_A, "agency_admin", "active");
  observerA = await seedMember("observer-a", ORG_A, "visual_observer", "active");
  adminB = await seedMember("admin-b", ORG_B, "agency_admin", "active");
  suspendedA = await seedMember("suspended-a", ORG_A, "dispatcher", "suspended");
  invitee = await seedAccount("invitee");

  adminAToken = await signIn(adminA.email);
  observerAToken = await signIn(observerA.email);
  adminBToken = await signIn(adminB.email);
  inviteeToken = await signIn(invitee.email);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  const like = `it.%.${RUN}@example.test`;
  // Deterministic fixture cleanup keyed by this run's identifier. Runs even
  // when a test above failed, so the database is left exactly as found.
  const { cleanupRunFixtures } = await import("./support/fixtures");
  await cleanupRunFixtures(admin, { emailLike: like });
  await admin.end();
  await db.getDatabase().close();
});

describe.skipIf(!enabled)("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });

  it("uses a distinct salt per hash", async () => {
    const { hashPassword } = await import("@/lib/auth/password");
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });
});

describe.skipIf(!enabled)("opaque tokens", () => {
  it("are unique and only ever stored as a hash", async () => {
    const { randomToken, hashToken } = await import("@/lib/auth/tokens");
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    const hash = await hashToken(a);
    expect(hash).not.toBe(a);
    expect(await hashToken(a)).toBe(hash);
  });

  it("never stores the session token in clear text", async () => {
    const rows = await admin.query(`SELECT count(*)::int AS n FROM airs.sessions WHERE token_hash = $1`, [
      adminAToken,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });
});

describe.skipIf(!enabled)("session lifecycle", () => {
  it("rejects an unknown password without revealing the account", async () => {
    const result = await auth.getAuthAdapter().signIn(adminA.email, "not-the-password", meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_credentials");
    const missing = await auth.getAuthAdapter().signIn(email("nobody"), PASSWORD, meta);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("invalid_credentials");
  });

  it("resolves a valid session and refuses garbage tokens", async () => {
    const ctx = await auth.getAuthAdapter().resolve(adminAToken);
    expect(ctx?.account.email).toBe(adminA.email);
    expect(ctx?.memberships.map((m) => m.orgId)).toEqual([ORG_A]);
    expect(await auth.getAuthAdapter().resolve("short")).toBeNull();
    expect(await auth.getAuthAdapter().resolve("x".repeat(64))).toBeNull();
    expect(await auth.getAuthAdapter().resolve(null)).toBeNull();
  });

  it("stops accepting a token after sign-out", async () => {
    const token = await signIn(adminA.email);
    expect(await auth.getAuthAdapter().resolve(token)).not.toBeNull();
    await auth.getAuthAdapter().signOut(token, meta);
    expect(await auth.getAuthAdapter().resolve(token)).toBeNull();
  });

  it("stops accepting an expired session", async () => {
    const token = await signIn(adminA.email);
    const { hashToken } = await import("@/lib/auth/tokens");
    await admin.query(`UPDATE airs.sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [
      await hashToken(token),
    ]);
    expect(await auth.getAuthAdapter().resolve(token)).toBeNull();
  });
});

describe.skipIf(!enabled)("authorization deny paths", () => {
  it("denies an unauthenticated caller", async () => {
    await expect(members.listMembers(null, ORG_A, meta)).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
  });

  it("denies a permission the role does not hold", async () => {
    await expect(members.listMembers(observerAToken, ORG_A, meta)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("denies a client-supplied organization the caller does not belong to", async () => {
    await expect(members.listMembers(adminAToken, ORG_B, meta)).rejects.toMatchObject({
      code: "not_a_member",
      status: 403,
    });
    await expect(members.selectActiveOrganization(adminAToken, ORG_B, meta)).rejects.toMatchObject({
      code: "not_a_member",
    });
  });

  it("denies a suspended membership", async () => {
    const token = await signIn(suspendedA.email);
    await expect(members.listMembers(token, ORG_A, meta)).rejects.toMatchObject({
      code: "membership_suspended",
      status: 403,
    });
  });

  it("rejects a malformed organization id before touching the database", async () => {
    await expect(members.listMembers(adminAToken, "not-a-uuid", meta)).rejects.toMatchObject({
      code: "invalid_input",
      status: 400,
    });
  });
});

describe.skipIf(!enabled)("tenant isolation through the enforced chain", () => {
  it("returns only the caller's organization members", async () => {
    const rowsA = await members.listMembers(adminAToken, ORG_A, meta);
    const rowsB = await members.listMembers(adminBToken, ORG_B, meta);
    const emailsA = rowsA.map((r) => r.email);
    const emailsB = rowsB.map((r) => r.email);
    expect(emailsA).toContain(adminA.email);
    expect(emailsA).not.toContain(adminB.email);
    expect(emailsB).toContain(adminB.email);
    expect(emailsB).not.toContain(adminA.email);
  });

  it("returns only the caller's organization audit history", async () => {
    const eventsA = await members.listAuditEvents(adminAToken, ORG_A, meta);
    expect(eventsA.length).toBeGreaterThan(0);
    const orgs = new Set(
      (
        await admin.query<{ org_id: string }>(
          `SELECT DISTINCT org_id FROM airs.audit_events WHERE id = ANY($1::bigint[])`,
          [eventsA.map((e) => String(e.id))],
        )
      ).rows.map((r) => r.org_id),
    );
    expect([...orgs]).toEqual([ORG_A]);
  });

  it("leaves no tenant context on a pooled connection between operations", async () => {
    const database = db.getDatabase();
    await database.withContext({ "airs.org_id": ORG_A }, async (q) => {
      const [row] = await q.query<{ org: string | null }>(
        `SELECT airs.current_org_id()::text AS org`,
      );
      expect(row.org).toBe(ORG_A);
    });
    await database.withContext({}, async (q) => {
      const [row] = await q.query<{ org: string | null }>(
        `SELECT airs.current_org_id()::text AS org`,
      );
      expect(row.org).toBeNull();
    });
  });

  it("refuses to set a GUC outside the airs namespace", async () => {
    await expect(
      db.getDatabase().withContext({ "role": "postgres" }, async () => null),
    ).rejects.toBeTruthy();
  });
});

describe.skipIf(!enabled)("invitation lifecycle", () => {
  it("issues, previews, accepts and refuses to replay an invitation", async () => {
    const created = await invites.createInvitation(
      adminAToken,
      ORG_A,
      { email: invitee.email, roleKey: "dispatcher" },
      meta,
    );
    expect(created.token).toBeTruthy();

    // The clear-text token is never persisted, and never appears in the audit log.
    const stored = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM airs.invitations WHERE token_hash = $1`,
      [created.token],
    );
    expect(stored.rows[0].n).toBe(0);
    const leaked = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM airs.audit_events WHERE detail::text LIKE $1`,
      [`%${created.token}%`],
    );
    expect(leaked.rows[0].n).toBe(0);

    // An anonymous caller cannot preview it.
    await expect(invites.previewInvitation(null, created.token)).rejects.toMatchObject({
      code: "unauthenticated",
    });

    // A signed-in non-recipient learns nothing beyond a masked address.
    const wrong = await invites.previewInvitation(adminAToken, created.token);
    expect(wrong.recipientMatches).toBe(false);
    expect(wrong.maskedEmail).not.toBe(invitee.email);
    expect(wrong.orgName).toBeTruthy();

    const preview = await invites.previewInvitation(inviteeToken, created.token);
    expect(preview.recipientMatches).toBe(true);
    expect(preview.roleKey).toBe("dispatcher");

    // Only the invited recipient may accept.
    await expect(invites.acceptInvitation(adminBToken, created.token, meta)).rejects.toMatchObject({
      code: "invitation_wrong_recipient",
    });

    const accepted = await invites.acceptInvitation(inviteeToken, created.token, meta);
    expect(accepted.orgId).toBe(ORG_A);
    expect(accepted.roleKey).toBe("dispatcher");

    // Role and organization came from the stored row, not the request.
    const membership = await admin.query<{ role_key: string; status: string; org_id: string }>(
      `SELECT role_key, status, org_id FROM airs.memberships WHERE account_id = $1`,
      [invitee.accountId],
    );
    expect(membership.rows[0]).toMatchObject({
      role_key: "dispatcher",
      status: "active",
      org_id: ORG_A,
    });

    // Single use.
    await expect(invites.acceptInvitation(inviteeToken, created.token, meta)).rejects.toMatchObject({
      code: "invitation_used",
    });
  }, 30_000);

  it("refuses an expired invitation", async () => {
    const created = await invites.createInvitation(
      adminAToken,
      ORG_A,
      { email: email("expired"), roleKey: "visual_observer" },
      meta,
    );
    await admin.query(`UPDATE airs.invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      created.invitationId,
    ]);
    await expect(invites.previewInvitation(inviteeToken, created.token)).rejects.toMatchObject({
      code: "invitation_expired",
    });
  });

  it("refuses a revoked invitation and an unknown token", async () => {
    const created = await invites.createInvitation(
      adminAToken,
      ORG_A,
      { email: email("revoked"), roleKey: "visual_observer" },
      meta,
    );
    await invites.revokeInvitation(adminAToken, ORG_A, created.invitationId, meta);
    await expect(invites.previewInvitation(inviteeToken, created.token)).rejects.toMatchObject({
      code: "invitation_revoked",
    });
    const { randomToken } = await import("@/lib/auth/tokens");
    await expect(invites.previewInvitation(inviteeToken, randomToken())).rejects.toMatchObject({
      code: "invitation_invalid",
    });
  });

  it("invalidates the previous token when an invitation is resent", async () => {
    const created = await invites.createInvitation(
      adminAToken,
      ORG_A,
      { email: email("resend"), roleKey: "visual_observer" },
      meta,
    );
    const rotated = await invites.regenerateInvitation(
      adminAToken,
      ORG_A,
      created.invitationId,
      meta,
    );
    expect(rotated.token).not.toBe(created.token);
    await expect(invites.previewInvitation(inviteeToken, created.token)).rejects.toMatchObject({
      code: "invitation_invalid",
    });
  });

  it("denies invitation management to a role without user.manage", async () => {
    await expect(
      invites.createInvitation(observerAToken, ORG_A, { email: email("x"), roleKey: "rpic" }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe.skipIf(!enabled)("audit evidence", () => {
  it("records allow and deny outcomes without secrets", async () => {
    await members.listAuditEvents(adminAToken, ORG_A, meta).catch(() => null);
    await members.listMembers(observerAToken, ORG_A, meta).catch(() => null);

    const rows = await admin.query<{ action: string; outcome: string; detail: unknown }>(
      `SELECT action, outcome, detail FROM airs.audit_events
        WHERE detail->>'correlation_id' = $1 ORDER BY occurred_at`,
      [meta.correlationId],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain("invitation.created");
    expect(actions).toContain("invitation.accepted");
    expect(rows.rows.some((r) => r.outcome === "deny")).toBe(true);
    for (const row of rows.rows) {
      expect(JSON.stringify(row.detail)).not.toMatch(/password|token_hash|secret/i);
    }
  });

  it("keeps the audit log append-only for the application role", async () => {
    const result = await db
      .getDatabase()
      .withContext({ "airs.org_id": ORG_A }, (q) =>
        q.query(`UPDATE airs.audit_events SET outcome = 'deny' WHERE org_id = $1 RETURNING id`, [
          ORG_A,
        ]),
      );
    expect(result).toHaveLength(0);
  });

  it("audits a permission denial with the acting user", async () => {
    await authorize
      .withAuthorized(
        {
          token: observerAToken,
          orgId: ORG_A,
          permission: "user.manage",
          action: "test.denied_action",
          resourceType: "test",
          meta,
        },
        async () => null,
      )
      .catch(() => null);
    const rows = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM airs.audit_events
        WHERE action = 'test.denied_action' AND outcome = 'deny'
          AND org_id = $1 AND actor_user_id = $2`,
      [ORG_A, observerA.userId],
    );
    expect(rows.rows[0].n).toBeGreaterThan(0);
  });
});
