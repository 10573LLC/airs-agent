import { Client } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  sourceSchema,
  observationSchema,
  projectObservations,
  observationState,
} from "@/lib/operations/framework";

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_ADMIN_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const run = randomUUID();
const meta = {
  ipAddress: "127.0.0.1",
  userAgent: "framework-operational-exercise",
  correlationId: run,
};
const password = "Exercise-only-Framework-2026!";
const orgs: string[] = [],
  accounts: string[] = [];
const users: Record<string, { orgId: string; token: string }> = {};
let admin: Client;
async function member(name: string, orgId: string, role: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const email = `exercise.${name}.${run}@example.test`;
  const a = (
    await admin.query<{ id: string }>(
      "INSERT INTO airs.accounts(email,display_name,password_hash) VALUES($1,$2,$3) RETURNING id",
      [email, name, await hashPassword(password)],
    )
  ).rows[0].id;
  accounts.push(a);
  const u = (
    await admin.query<{ id: string }>(
      "INSERT INTO airs.users(org_id,email_address,display_name,account_id) VALUES($1,$2,$3,$4) RETURNING id",
      [orgId, email, name, a],
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO airs.memberships(org_id,account_id,user_id,role_key,status,activated_at) VALUES($1,$2,$3,$4,'active',now())",
    [orgId, a, u, role],
  );
  await admin.query("INSERT INTO airs.user_roles(org_id,user_id,role_key) VALUES($1,$2,$3)", [
    orgId,
    u,
    role,
  ]);
  const auth = await import("@/lib/auth/index.server");
  const login = await auth.getAuthAdapter().signIn(email, password, meta);
  if (!login.ok || !login.token) throw Error("Exercise login failed");
  users[name] = { orgId, token: login.token };
}
beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  await admin.connect();
  for (const name of ["command", "partner", "associate", "outsider", "viewer"]) {
    const id = (
      await admin.query<{ id: string }>(
        "INSERT INTO airs.organizations(slug,name,agency_type) VALUES($1,$2,'other') RETURNING id",
        [`exercise-${name}-${run}`, `EXERCISE ${name}`],
      )
    ).rows[0].id;
    orgs.push(id);
    await member(name, id, "agency_admin");
  }
  await member("commander", orgs[0], "incident_commander");
  await member("observer", orgs[2], "visual_observer");
}, 60000);
afterAll(async () => {
  if (!enabled) return;
  await admin.query("SET session_replication_role=replica");
  try {
    for (const table of [
      "observation_correlations",
      "operational_observations",
      "supplemental_source_access",
      "incident_source_grants",
      "partner_envelopes",
      "source_systems",
      "entity_profiles",
      "incident_participants",
      "incident_rooms",
      "trusted_agencies",
      "audit_events",
      "user_roles",
      "memberships",
      "users",
    ])
      await admin.query(`DELETE FROM airs.${table} WHERE org_id=ANY($1::uuid[])`, [orgs]);
    await admin.query("DELETE FROM airs.sessions WHERE account_id=ANY($1::uuid[])", [accounts]);
    await admin.query("DELETE FROM airs.accounts WHERE id=ANY($1::uuid[])", [accounts]);
    await admin.query("DELETE FROM airs.organizations WHERE id=ANY($1::uuid[])", [orgs]);
  } finally {
    await admin.query("SET session_replication_role=origin");
    await admin.end();
    await (await import("@/lib/adapters/index.server")).getDatabase().close();
  }
});

describe.skipIf(!enabled)("multi-entity operational acceptance exercise", () => {
  it("runs onboarding, automatic Partner and incident-only Associate sharing, human reporting, conflicts, revocation and closeout", async () => {
    const fw = await import("@/lib/operations/framework.server");
    const rooms = await import("@/lib/incidents/incidents.server");
    const participation = await import("@/lib/incidents/participation.server");
    const owner = users.command,
      commander = users.commander,
      partner = users.partner,
      associate = users.associate;
    const until = new Date(Date.now() + 3600000).toISOString();
    for (const u of [owner, partner, associate])
      await fw.writeFramework(u.token, {
        action: "profile",
        value: {
          formalName: `EXERCISE ${u.orgId}`,
          entityType: "public_safety",
          jurisdiction: "Exercise area",
          administrators: "Exercise admin",
          operationalContact: "Exercise operations",
          technicalContact: "Exercise technical",
          emergencyContact: "",
          identityProvider: "",
          capabilities: ["UAS", "dispatch"],
        },
      });
    const source = sourceSchema.parse({
      vendor: "Dedrone",
      systemType: "C-UAS",
      controllingEntity: "EXERCISE Partner",
      method: "authorized_web",
      ingestionAuthorization: "authorized",
      dataClasses: ["uas_track", "operator_location"],
    });
    await fw.writeFramework(partner.token, { action: "source", value: source });
    const partnerSource = (await fw.readFramework(partner.token)).sources[0].id;
    await fw.writeFramework(partner.token, {
      action: "envelope",
      value: {
        recipientOrgId: owner.orgId,
        sourceId: partnerSource,
        dataClasses: ["uas_track"],
        incidentTypes: ["planned_event"],
        activation: "automatic",
        expiresAt: until,
        revoked: false,
      },
    });
    let room = await rooms.createIncident(
      commander.token,
      owner.orgId,
      {
        name: "EXERCISE Altamont framework acceptance",
        incidentType: "planned_event",
        description: "Reported UAS and operator; victim location unknown",
        geographicDescription: "Synthetic test area",
        tempDataRetentionHours: 1,
      },
      meta,
    );
    for (const u of [partner, associate, users.viewer]) {
      const invite = await participation.invitePartner(
        commander.token,
        owner.orgId,
        room.id,
        {
          partnerOrgId: u.orgId,
          accessLevel: u === users.viewer ? "view_only" : "operational",
          requiresApproval: false,
          invitationExpiresAt: until,
          participationExpiresAt: until,
        },
        meta,
      );
      await participation.partnerParticipationAction(
        u.token,
        u.orgId,
        invite.participant.id,
        "accept",
        meta,
      );
    }
    room = await rooms.activateIncident(commander.token, owner.orgId, room.id, room.version, meta);
    const partnerState = await fw.readFramework(partner.token, room.id);
    expect(partnerState.grants).toHaveLength(1);
    expect(partnerState.grants[0].relationship).toBe("partner");
    expect((await fw.readFramework(owner.token, room.id)).sources).toHaveLength(0);
    await fw.writeFramework(associate.token, {
      action: "source",
      value: {
        ...source,
        vendor: "CAD",
        method: "structured_transport",
        dataClasses: ["unit_location"],
      },
    });
    const associateSource = (await fw.readFramework(associate.token)).sources[0].id;
    await fw.writeFramework(associate.token, {
      action: "grant",
      value: {
        incidentId: room.id,
        recipientOrgId: owner.orgId,
        sourceId: associateSource,
        relationship: "associate",
        dataClasses: ["unit_location"],
        expiresAt: until,
      },
    });
    const associateGrant = (await fw.readFramework(associate.token, room.id)).grants.find(
      (g) => g.sourceId === associateSource,
    )!;
    const report = observationSchema.parse({
      incidentId: room.id,
      sourceId: partnerSource,
      grantId: partnerState.grants[0].id,
      originatingEntity: "Forged origin",
      platform: "Forged vendor",
      sourceTimestamp: new Date().toISOString(),
      dataClass: "uas_track",
      entityType: "uas",
      label: "EXERCISE UAS",
      summary: "Aircraft reported",
      state: "known",
      verification: "reported",
      confidence: 0.7,
      geographicPrecision: "exact",
      latitude: 42.65,
      longitude: -73.75,
    });
    await expect(
      fw.writeFramework(users.outsider.token, { action: "report", value: report }),
    ).rejects.toMatchObject({ code: "incident_state_invalid" });
    await expect(
      fw.writeFramework(users.viewer.token, {
        action: "report",
        value: { ...report, sourceId: undefined, grantId: undefined },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await fw.writeFramework(partner.token, { action: "report", value: report });
    await expect(
      fw.writeFramework(partner.token, {
        action: "report",
        value: { ...report, dataClass: "operator_location" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await fw.writeFramework(associate.token, {
      action: "report",
      value: {
        ...report,
        sourceId: associateSource,
        grantId: associateGrant.id,
        dataClass: "unit_location",
        latitude: 42.66,
      },
    });
    await fw.writeFramework(associate.token, {
      action: "report",
      value: {
        ...report,
        sourceId: undefined,
        grantId: undefined,
        platform: "radio",
        originatingEntity: "EXERCISE no-account participant via liaison",
        dataClass: "person_report",
        entityType: "person",
        label: "Victim",
        summary: "Victim reported; location not provided",
        latitude: null,
        longitude: null,
        geographicPrecision: "unknown",
        verification: "unverified",
        state: "unknown",
      },
    });
    let cop = await fw.readFramework(owner.token, room.id);
    expect(cop.observations).toHaveLength(3);
    expect(cop.observations.find((o) => o.sourceId === partnerSource)?.platform).toBe("Dedrone");
    expect(
      projectObservations(cop.observations, Date.now()).some((o) =>
        o.gap?.includes("location not provided"),
      ),
    ).toBe(true);
    await expect(fw.readFramework(users.outsider.token, room.id)).rejects.toMatchObject({
      code: "incident_not_found",
    });
    const sourceIds = cop.observations.filter((o) => o.sourceId).map((o) => o.id);
    await fw.writeFramework(commander.token, {
      action: "correlate",
      value: {
        incidentId: room.id,
        observationIds: sourceIds,
        reason: "Exercise reports intentionally assigned to one synthetic aircraft",
      },
    });
    cop = await fw.readFramework(owner.token, room.id);
    expect(
      projectObservations(cop.observations, Date.now()).some((o) => o.state === "conflicting"),
    ).toBe(true);
    await admin.query(
      "UPDATE airs.operational_observations SET observation=jsonb_set(observation,'{sourceTimestamp}',to_jsonb((now()-interval '10 minutes')::text)) WHERE incident_id=$1 AND source_id=$2",
      [room.id, partnerSource],
    );
    expect(
      projectObservations((await fw.readFramework(owner.token, room.id)).observations, Date.now())
        .flatMap((g) => g.evidence)
        .some((o) => observationState(o, Date.now()) === "stale"),
    ).toBe(true);
    await fw.writeFramework(partner.token, {
      action: "supplemental",
      value: {
        incidentId: room.id,
        sourceId: partnerSource,
        recipientOrgId: owner.orgId,
        accessProfile: "Observation Only",
        expiresAt: until,
        provisioningStatus: "provisioned",
        revocationOwner: "EXERCISE source administrator",
      },
    });
    await fw.writeFramework(associate.token, {
      action: "revoke",
      value: { id: associateGrant.id, kind: "grant" },
    });
    expect(
      (await fw.readFramework(owner.token, room.id)).observations.some(
        (o) => o.sourceId === associateSource,
      ),
    ).toBe(false);
    // Participant locks serialize writes against lifecycle transitions without
    // granting participants permission to update the room itself.
    const lockClient = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await lockClient.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT set_config('airs.org_id',$1,true)", [partner.orgId]);
      expect(
        (await lockClient.query("SELECT * FROM airs.lock_framework_incident($1)", [room.id]))
          .rowCount,
      ).toBe(1);
      expect(
        (
          await lockClient.query(
            "UPDATE airs.incident_rooms SET description='unauthorized' WHERE id=$1 RETURNING id",
            [room.id],
          )
        ).rowCount,
      ).toBe(0);
      await admin.query("SET lock_timeout='100ms'");
      await expect(
        admin.query("UPDATE airs.incident_rooms SET description=description WHERE id=$1", [
          room.id,
        ]),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await lockClient.query("ROLLBACK");
      await lockClient.end();
      await admin.query("SET lock_timeout=0");
    }
    await rooms.closeIncident(
      commander.token,
      owner.orgId,
      room.id,
      { expectedVersion: room.version, reason: "Exercise completed" },
      meta,
    );
    expect((await fw.readFramework(owner.token, room.id)).observations).toEqual([]);
    const receipts = await admin.query(
      "SELECT revocation_status FROM airs.supplemental_source_access WHERE incident_id=$1",
      [room.id],
    );
    expect(receipts.rows[0].revocation_status).toBe("pending");
    await expect(
      fw.writeFramework(partner.token, { action: "report", value: report }),
    ).rejects.toMatchObject({ code: "incident_state_invalid" });
  }, 60000);
});
