import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(APP_URL && ADMIN_URL);
if (APP_URL) process.env.DATABASE_URL = APP_URL;

const RUN = Math.random().toString(36).slice(2, 10);
const PASSWORD = "Airs-Smoke-Profile-2026!";
const meta = {
  ipAddress: "127.0.0.1",
  userAgent: "runtime-smoke",
  correlationId: `systems-${RUN}`,
};
let admin: Client;
let orgId = "";
let adminAccountId = "";
let viewerAccountId = "";
let adminToken = "";
let viewerToken = "";
let db: typeof import("@/lib/adapters/index.server");

async function seedMember(name: string, roleKey: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const email = `framework.${name}.${RUN}@example.test`;
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
  await admin.query(`INSERT INTO airs.user_roles (org_id,user_id,role_key) VALUES ($1,$2,$3)`, [
    orgId,
    user.rows[0]!.id,
    roleKey,
  ]);
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
    [`framework-smoke-${RUN}`, `Framework Smoke ${RUN}`],
  );
  orgId = org.rows[0]!.id;
  ({ accountId: adminAccountId, token: adminToken } = await seedMember("admin", "agency_admin"));
  ({ accountId: viewerAccountId, token: viewerToken } = await seedMember(
    "viewer",
    "visual_observer",
  ));
  db = await import("@/lib/adapters/index.server");
}, 60_000);
afterAll(async () => {
  if (!enabled) return;
  await admin.query(`SET session_replication_role = replica`);
  try {
    for (const table of [
      "observation_correlations",
      "operational_observations",
      "supplemental_source_access",
      "incident_source_grants",
      "partner_envelopes",
      "source_systems",
      "entity_profiles",
      "incident_rooms",
    ])
      await admin.query("DELETE FROM airs." + table + " WHERE org_id=$1", [orgId]);
    await admin.query(`DELETE FROM airs.agency_system_components WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.agency_system_ecosystems WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.agency_system_profiles WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.audit_events WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.sessions WHERE account_id = ANY($1::uuid[])`, [
      [adminAccountId, viewerAccountId],
    ]);
    await admin.query(`DELETE FROM airs.user_roles WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.memberships WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.users WHERE org_id=$1`, [orgId]);
    await admin.query(`DELETE FROM airs.accounts WHERE id = ANY($1::uuid[])`, [
      [adminAccountId, viewerAccountId],
    ]);
    await admin.query(`DELETE FROM airs.organizations WHERE id=$1`, [orgId]);
  } finally {
    await admin.query(`SET session_replication_role = origin`);
  }
  await admin.end();
  await db.getDatabase().close();
});

describe.skipIf(!enabled)("locked framework runtime", () => {
  it("persists adaptive onboarding, enforces source grants, correlates evidence, and closes visibility", async () => {
    const service = await import("@/lib/operations/framework.server");
    const model = await import("@/lib/operations/framework");
    const initial = await service.readFramework(adminToken);
    expect(initial.sources).toEqual([]);
    expect(initial.observations).toEqual([]);
    await service.writeFramework(adminToken, {
      action: "profile",
      value: {
        formalName: "Framework entity",
        entityType: "public_safety",
        jurisdiction: "Test region",
        administrators: "Administrator",
        operationalContact: "Operations",
        technicalContact: "Technical",
        emergencyContact: "",
        identityProvider: "",
        capabilities: ["UAS"],
      },
    });
    const input = model.sourceSchema.parse({
      vendor: "Dedrone",
      systemType: "C-UAS",
      controllingEntity: "Framework entity",
      method: "authorized_web",
      ingestionAuthorization: "authorized",
      dataClasses: ["uas_track"],
      answers: { "Product and deployment period": "Event only" },
    });
    await service.writeFramework(adminToken, { action: "source", value: input });
    await expect(
      service.writeFramework(viewerToken, { action: "source", value: input }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const configured = await service.readFramework(adminToken);
    expect(configured.profile?.capabilities).toEqual(["UAS"]);
    expect(configured.sources[0].answers["Product and deployment period"]).toBe("Event only");
    const sourceId = configured.sources[0].id;
    const room = await admin.query<{ id: string }>(
      "INSERT INTO airs.incident_rooms(org_id,name,incident_type,status) VALUES($1,'Runtime framework','planned_event','active') RETURNING id",
      [orgId],
    );
    const incidentId = room.rows[0].id,
      expiresAt = new Date(Date.now() + 3600000).toISOString();
    await service.writeFramework(adminToken, {
      action: "grant",
      value: {
        incidentId,
        sourceId,
        recipientOrgId: orgId,
        relationship: "originating_entity",
        dataClasses: ["uas_track"],
        expiresAt,
      },
    });
    const granted = await service.readFramework(adminToken, incidentId);
    expect(granted.grants).toHaveLength(1);
    const report = model.observationSchema.parse({
      incidentId,
      sourceId,
      grantId: granted.grants[0].id,
      originatingEntity: "Framework entity",
      platform: "Dedrone",
      sourceTimestamp: new Date().toISOString(),
      dataClass: "uas_track",
      entityType: "uas",
      label: "Aircraft",
      summary: "Reported UAS track",
      state: "unverified",
      verification: "reported",
      confidence: null,
      geographicPrecision: "exact",
      latitude: 42.65,
      longitude: -73.75,
    });
    await service.writeFramework(adminToken, { action: "report", value: report });
    await service.writeFramework(adminToken, {
      action: "report",
      value: { ...report, label: "Second report" },
    });
    const observed = await service.readFramework(adminToken, incidentId);
    expect(observed.observations).toHaveLength(2);
    await service.writeFramework(adminToken, {
      action: "correlate",
      value: {
        incidentId,
        observationIds: observed.observations.map((o) => o.id),
        reason: "Same source aircraft identifier confirmed by reporting entity",
      },
    });
    const correlated = await service.readFramework(adminToken, incidentId);
    expect(correlated.observations).toHaveLength(2);
    expect(new Set(correlated.observations.map((o) => o.operationalEntityId)).size).toBe(1);
    await expect(
      service.writeFramework(viewerToken, {
        action: "report",
        value: { ...report, verification: "confirmed" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.writeFramework(adminToken, {
        action: "report",
        value: { ...report, dataClass: "camera_video" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.writeFramework(adminToken, {
      action: "readiness",
      value: { id: sourceId, health: "verified", receipt: "Test connection receipt" },
    });
    await service.writeFramework(adminToken, {
      action: "source",
      value: { ...input, id: sourceId, ingestionAuthorization: "denied" },
    });
    expect((await service.readFramework(adminToken, incidentId)).observations).toEqual([]);
    await expect(
      service.writeFramework(adminToken, { action: "report", value: report }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.writeFramework(adminToken, {
      action: "source",
      value: { ...input, id: sourceId, ingestionAuthorization: "authorized" },
    });
    const renewed = await service.readFramework(adminToken, incidentId);
    expect(renewed.sources[0].health).toBe("identified");
    expect(renewed.observations).toEqual([]);
    expect(renewed.grants[0].revokedAt).not.toBeNull();
    await service.writeFramework(adminToken, {
      action: "supplemental",
      value: {
        incidentId,
        sourceId,
        recipientOrgId: orgId,
        accessProfile: "Observation Only",
        expiresAt,
        provisioningStatus: "provisioned",
        revocationOwner: "Source entity",
      },
    });
    await admin.query("UPDATE airs.incident_rooms SET status='closed' WHERE id=$1", [incidentId]);
    const closed = await service.readFramework(adminToken, incidentId);
    expect(closed.observations).toEqual([]);
    expect(closed.grants[0].revokedAt).not.toBeNull();
    expect(closed.supplemental[0].revocationStatus).toBe("pending");
    await service.writeFramework(adminToken, {
      action: "revocation_receipt",
      value: {
        id: closed.supplemental[0].id,
        confirmed: true,
        receipt: "Provider confirmation recorded for test account",
      },
    });
    expect(
      (await service.readFramework(adminToken, incidentId)).supplemental[0].revocationStatus,
    ).toBe("confirmed");
  });
});
