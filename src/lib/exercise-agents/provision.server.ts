import type { Client } from "pg";
import { createHmac } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";
import { getAuthAdapter } from "@/lib/auth/index.server";
import { createResource, listResources } from "@/lib/resources/resources.server";
import { listPersonnel, upsertPersonnel } from "@/lib/resources/personnel.server";
import { readFramework, writeFramework } from "@/lib/operations/framework.server";
import { sourceSchema } from "@/lib/operations/framework";
import { EXERCISE_AGENCIES } from "./model";
export const EXERCISE_PREFIX = "anconison-exercise";
export function agentCredential(seed: string, key: string, role: string) {
  if (seed.length < 32) throw Error("Exercise seed missing");
  return {
    email: `${EXERCISE_PREFIX}.${key}.${role}@example.invalid`,
    password: createHmac("sha256", seed).update(`${key}:${role}`).digest("base64url"),
  };
}
export async function provisionExercise(db: Client, seed: string, controllerEmail: string) {
  const human = (
    await db.query<{ id: string }>(
      "SELECT id FROM airs.accounts WHERE lower(email)=lower($1) AND status='active'",
      [controllerEmail],
    )
  ).rows[0];
  if (!human) throw Error("An existing active controller account is required");
  async function organization(key: string, name: string) {
    return (
      await db.query<{ id: string }>(
        `INSERT INTO airs.organizations(slug,name,agency_type) VALUES($1,$2,'other') ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [`${EXERCISE_PREFIX}-${key}`, name],
      )
    ).rows[0].id;
  }
  async function membership(
    orgId: string,
    accountId: string,
    email: string,
    name: string,
    role: string,
  ) {
    let user = (
      await db.query<{ id: string }>(
        "SELECT id FROM airs.users WHERE org_id=$1 AND account_id=$2",
        [orgId, accountId],
      )
    ).rows[0];
    if (!user)
      user = (
        await db.query<{ id: string }>(
          "INSERT INTO airs.users(org_id,account_id,email_address,display_name) VALUES($1,$2,$3,$4) RETURNING id",
          [orgId, accountId, email, name],
        )
      ).rows[0];
    await db.query(
      `INSERT INTO airs.memberships(org_id,account_id,user_id,role_key,status,activated_at) VALUES($1,$2,$3,$4,'active',now()) ON CONFLICT(org_id,account_id) DO NOTHING`,
      [orgId, accountId, user.id, role],
    );
    await db.query(
      "INSERT INTO airs.user_roles(org_id,user_id,role_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [orgId, user.id, role],
    );
  }
  async function agent(orgId: string, key: string, role: string) {
    const credential = agentCredential(seed, key, role);
    const account = (
      await db.query<{ id: string }>(
        `INSERT INTO airs.accounts(email,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(lower(email)) DO UPDATE SET password_hash=EXCLUDED.password_hash WHERE airs.accounts.external_subject IS NULL RETURNING id`,
        [credential.email, `EXERCISE ${key} ${role}`, await hashPassword(credential.password)],
      )
    ).rows[0];
    if (!account) throw Error("Exercise account conflicts with a managed human identity");
    await membership(orgId, account.id, credential.email, `EXERCISE ${key} agent`, role);
    const result = await getAuthAdapter().signIn(credential.email, credential.password, {
      userAgent: "Anconison exercise provisioner",
    });
    if (!result.ok || !result.token) throw Error("Exercise agent could not authenticate");
    return result.token;
  }
  const requesterOrgId = await organization("requester", "Requesting Agency — EXERCISE");
  await membership(
    requesterOrgId,
    human.id,
    controllerEmail,
    "Exercise incident commander",
    "incident_commander",
  );
  const requesterAdmin = await agent(requesterOrgId, "requester", "agency_admin");
  await writeFramework(requesterAdmin, {
    action: "profile",
    value: {
      formalName: "Requesting Agency — EXERCISE",
      entityType: "Exercise requesting agency",
      jurisdiction: "Isolated staging exercise",
      administrators: controllerEmail,
      operationalContact: controllerEmail,
      technicalContact: "AIRS staging exercise controller",
      emergencyContact: "Exercise only",
      identityProvider: "Staging managed identity",
      capabilities: ["Incident command", "Multi-agency aid requests"],
    },
  });
  for (const spec of EXERCISE_AGENCIES) {
    const orgId = await organization(spec.key, `${spec.name} — EXERCISE`);
    const token = await agent(orgId, spec.key, "agency_admin");
    const command = await agent(orgId, spec.key, "incident_commander");
    await writeFramework(token, {
      action: "profile",
      value: {
        formalName: `${spec.name} — EXERCISE`,
        entityType: spec.capability,
        jurisdiction: "Fictional staging exercise",
        administrators: `${spec.name} exercise administrator`,
        operationalContact: `${spec.name} automated responder`,
        technicalContact: "Anconison exercise controller",
        emergencyContact: "Exercise only — no live dispatch",
        identityProvider: "Isolated exercise agent identity",
        capabilities: [...spec.kinds, spec.capability],
      },
    });
    const fw = await readFramework(token);
    if (!fw.sources.length)
      await writeFramework(token, {
        action: "source",
        value: sourceSchema.parse({
          vendor: "Anconison exercise responder",
          systemType: spec.capability,
          controllingEntity: spec.name,
          method: "human_reporting",
          ingestionAuthorization: "authorized",
          dataClasses: ["resource_status"],
          limitations: "Fictional agency reports only; no real system connection or dispatch.",
        }),
      });
    const existing = await listResources(token, orgId);
    const people = await listPersonnel(token, orgId);
    for (let index = 1; index <= 2; index++) {
      const callsign = `EX-${spec.key.toUpperCase()}-${index}`;
      if (!existing.some((r) => r.callsign === callsign))
        await createResource(token, orgId, {
          category: spec.category,
          displayName: `EXERCISE ${spec.unit} ${index}`,
          callsign,
          description: `Fictional ${spec.name} resource. ${spec.capability}.`,
          readinessStatus: "available",
          sharingClassification: "participating_orgs",
        });
      if (!people.some((p) => p.callsign === callsign))
        await upsertPersonnel(token, orgId, {
          displayName: `EXERCISE ${spec.name} crew ${index}`,
          callsign,
          operationalRoles: ["other"],
          availabilityStatus: "available",
          qualificationSummary: `Fictional exercise crew for ${spec.capability}; not a real qualification.`,
        });
    }
    await getAuthAdapter().signOut(command, {});
    await getAuthAdapter().signOut(token, {});
  }
  await getAuthAdapter().signOut(requesterAdmin, {});
  return { requesterOrgId, respondingAgencies: EXERCISE_AGENCIES.length };
}
