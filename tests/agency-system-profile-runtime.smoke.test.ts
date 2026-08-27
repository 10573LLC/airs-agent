import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(APP_URL && ADMIN_URL);
if (APP_URL) process.env.DATABASE_URL = APP_URL;

const RUN = Math.random().toString(36).slice(2, 10);
const PASSWORD = "Airs-Smoke-Profile-2026!";
const meta = { ipAddress: "127.0.0.1", userAgent: "runtime-smoke", correlationId: `systems-${RUN}` };
let admin: Client;
let orgId = "";
let adminAccountId = "";
let viewerAccountId = "";
let adminToken = "";
let viewerToken = "";
let db: typeof import("@/lib/adapters/index.server");

async function seedMember(name: string, roleKey: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const email = `systems.${name}.${RUN}@example.test`;
  const acct = await admin.query<{ id: string }>(
    `INSERT INTO airs.accounts (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [email, `Systems ${name}`, await hashPassword(PASSWORD)],
  );
  const user = await admin.query<{ id: string }>(
    `INSERT INTO airs.users (org_id,email_address,display_name,account_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, email, `Systems ${name}`, acct.rows[0]!.id],
  );
  await admin.query(
    `INSERT INTO airs.memberships (org_id,account_id,user_id,role_key,status,activated_at) VALUES ($1,$2,$3,$4,'active',now())`,
    [orgId, acct.rows[0]!.id, user.rows[0]!.id, roleKey],
  );
  await admin.query(
    `INSERT INTO airs.user_roles (org_id,user_id,role_key) VALUES ($1,$2,$3)`,
    [orgId, user.rows[0]!.id, roleKey],
  );
  const auth = await import("@/lib/auth/index.server");
  const signed = await auth.getAuthAdapter().signIn(email, PASSWORD, meta);
  if (!signed.ok) throw new Error(`sign-in failed for ${name}`);
  return { accountId: acct.rows[0]!.id, token: signed.token };
}

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const org = await admin.query<{ id: string }>(
    `INSERT INTO airs.organizations (slug,name,agency_type) VALUES ($1,$2,'law_enforcement') RETURNING id`,
    [`systems-smoke-${RUN}`, `Systems Smoke ${RUN}`],
  );
  orgId = org.rows[0]!.id;
  ({ accountId: adminAccountId, token: adminToken } = await seedMember("admin", "agency_admin"));
  ({ accountId: viewerAccountId, token: viewerToken } = await seedMember("viewer", "visual_observer"));
  db = await import("@/lib/adapters/index.server");
}, 60_000);
afterAll(async () => {
  if (!enabled) return;
  await admin.query(`SET session_replication_role = replica`);
  try {
    await admin.query(`DELETE FROM airs.agency_system_components WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.agency_system_ecosystems WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.agency_system_profiles WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.audit_events WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.sessions WHERE account_id = ANY($1::uuid[])`, [[adminAccountId, viewerAccountId]]);
    await admin.query(`DELETE FROM airs.user_roles WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.memberships WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.users WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.accounts WHERE id = ANY($1::uuid[])`, [[adminAccountId, viewerAccountId]]);
    await admin.query(`DELETE FROM airs.organizations WHERE id=$1`, [orgId]);
  } finally {
    await admin.query(`SET session_replication_role = origin`);
  }
  await admin.end();
  await db.getDatabase().close();
});

describe.skipIf(!enabled)("agency systems runtime persistence", () => {
  it("saves, reads, preserves safe defaults, and denies non-admin writes", async () => {
    const profile = await import("@/lib/resources/agency-system-profile.server");
    const saved = await profile.saveAgencySystemProfile(adminToken, orgId, {
      ecosystems: [{ id: "axon", usageStatus: "in_use" }, { id: "skydio", usageStatus: "planned" }],
      components: [{ id: "axon_fusus_real_time_operations", usageStatus: "in_use" }, { id: "skydio_uas", usageStatus: "planned" }],
    }, meta);
    expect(saved.version).toBe(1);
    expect(saved.ecosystems.map((x) => x.ecosystemId)).toEqual(["axon", "skydio"]);
    const readBack = await profile.readAgencySystemProfile(adminToken, orgId, meta);
    expect(readBack.version).toBe(1);
    expect(readBack.components).toHaveLength(2);
    for (const component of readBack.components) {
      expect(component.integration.connection).toBe("available_not_connected");
      expect(component.integration.mode).toBe("manual_only");
      expect(component.integration.authorized).toBe(false);
      expect(component.integration.credentialed).toBe(false);
      expect(component.integration.dataAccessCapable).toBe(false);
    }

    const viewerRead = await profile.readAgencySystemProfile(viewerToken, orgId, meta);
    expect(viewerRead.components).toHaveLength(2);
    await expect(
      profile.saveAgencySystemProfile(viewerToken, orgId, { ecosystems: [], components: [] }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });

    const persisted = await admin.query<{ ecosystems: string; components: string }>(
      `SELECT
         (SELECT count(*)::text FROM airs.agency_system_ecosystems WHERE org_id=$1) ecosystems,
         (SELECT count(*)::text FROM airs.agency_system_components WHERE org_id=$1) components`,
      [orgId],
    );
    expect(persisted.rows[0]).toEqual({ ecosystems: "2", components: "2" });
  });
});
