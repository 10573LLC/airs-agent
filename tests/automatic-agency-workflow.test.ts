import { Client } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";
import { getAuthAdapter } from "@/lib/auth/index.server";
import { provisionExercise, agentCredential } from "@/lib/exercise-agents/provision.server";
import { EXERCISE_AGENCIES, aidDecision } from "@/lib/exercise-agents/model";
import { runAgencyCycle } from "@/lib/exercise-agents/runner.server";
import { createIncident, activateIncident, beginClosure } from "@/lib/incidents/incidents.server";
import {
  readAgencyRequests,
  sendAgencyAidRequest,
  respondToAgencyRequest,
} from "@/lib/incidents/request-responses.server";
import { listIncidentAssignments } from "@/lib/resources/assignments.server";
import { readFramework } from "@/lib/operations/framework.server";
import { listResources } from "@/lib/resources/resources.server";

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_ADMIN_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const seed = "test-only-anconison-agents-" + randomUUID(),
  email = `controller-${randomUUID()}@example.invalid`,
  password = "Test-only-controller-2026!";
let db: Client, requesterOrgId: string, token: string;
const agents: Parameters<typeof runAgencyCycle>[0][] = [];
beforeAll(async () => {
  if (!enabled) return;
  db = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  await db.connect();
  await db.query(
    "INSERT INTO airs.accounts(email,display_name,password_hash) VALUES($1,'Test requester',$2)",
    [email, await hashPassword(password)],
  );
  ({ requesterOrgId } = await provisionExercise(db, seed, email));
  token = (await getAuthAdapter().signIn(email, password, {})).token!;
  for (const agency of EXERCISE_AGENCIES) {
    const login = async (role: string) => {
      const c = agentCredential(seed, agency.key, role);
      return (await getAuthAdapter().signIn(c.email, c.password, {})).token!;
    };
    const commandToken = await login("incident_commander"),
      adminToken = await login("agency_admin");
    const orgId = (await getAuthAdapter().resolve(commandToken))!.session.activeOrgId!;
    agents.push({ agency, orgId, requesterOrgId, adminToken, commandToken });
  }
}, 120000);
afterAll(async () => {
  if (db) await db.end();
});
describe("agency capability decisions", () => {
  it("honors capabilities and finite capacity", () => {
    expect(aidDecision(EXERCISE_AGENCIES[0], "medical", 1, 2).status).toBe("denied");
    expect(aidDecision(EXERCISE_AGENCIES[0], "law_enforcement", 4, 2)).toMatchObject({
      status: "partially_filled",
      count: 2,
    });
    expect(aidDecision(EXERCISE_AGENCIES[0], "other", 1, 0).status).toBe("denied");
  });
});
describe.skipIf(!enabled)("real automatic agency workflow", () => {
  it("persists intelligent assumptions, plots labeled simulated staging and publishes timed updates once",async()=>{
    let room=await createIncident(token,requesterOrgId,{name:"EXERCISE intelligent planning",incidentType:"training",description:"Fictional",geographicDescription:"Albany exercise",tempDataRetentionHours:1},{});
    room=await activateIncident(token,requesterOrgId,room.id,room.version,{});
    const agency=agents.find(a=>a.agency.key==='utilities')!;
    await sendAgencyAidRequest(token,requesterOrgId,{incidentId:room.id,batchId:randomUUID(),recipients:[agency.orgId],description:"Assess fictional outage",resourceKind:"other",quantity:1,priority:"high",stagingLocation:""});
    const plan={units:1,response:"Utility crew committed for a fictional assessment",assumptions:["Simulated Albany location"],unmetNeeds:["Command contact"],staging:{label:"Fictional staging",latitude:42.65,longitude:-73.75},updates:[{afterSeconds:15,message:"Simulated crew checks in; assessment still pending"}]};
    vi.stubEnv('EXERCISE_INTELLIGENCE','openai');vi.stubEnv('EXERCISE_OPENAI_API_KEY','test-only');
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(plan)}]}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    try {
      await runAgencyCycle(agency);
      let fw=await readFramework(token,room.id);
      expect(fw.observations.some(o=>o.dataClass==='exercise_plan')).toBe(true);
      expect(fw.observations.find(o=>o.latitude!==null)).toMatchObject({verification:'unverified',geographicPrecision:'approximate'});
      expect((await readAgencyRequests(token,requesterOrgId,room.id)).exerciseUpdates).toHaveLength(0);
      await db.query(`UPDATE airs.operational_observations SET observation=jsonb_set(observation,'{sourceTimestamp}',to_jsonb((now()-interval '30 seconds')::text)) WHERE incident_id=$1 AND observation->>'dataClass'='exercise_plan'`,[room.id]);
      await runAgencyCycle(agency);await runAgencyCycle(agency);
      expect((await readAgencyRequests(token,requesterOrgId,room.id)).exerciseUpdates).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await beginClosure(token,requesterOrgId,room.id,{reason:'Exercise completed',expectedVersion:room.version},{});
      await runAgencyCycle(agency);
      expect((await listResources(agency.adminToken,agency.orgId)).every(r=>r.readinessStatus==='available')).toBe(true);
    } finally {vi.unstubAllGlobals();vi.unstubAllEnvs();}
  },120000);
  it("routes to multiple agencies, accepts participation, assigns owned resources, reports back and enforces boundaries", async () => {
    let room = await createIncident(
      token,
      requesterOrgId,
      {
        name: "EXERCISE multi-agency workflow",
        incidentType: "training",
        description: "Fictional critical incident",
        geographicDescription: "Exercise staging point",
        tempDataRetentionHours: 1,
      },
      {},
    );
    room = await activateIncident(token, requesterOrgId, room.id, room.version, {});
    const fire = agents.find((a) => a.agency.key === "fire")!,
      ems = agents.find((a) => a.agency.key === "ems")!,
      police = agents[0];
    const input = {
      incidentId: room.id,
      batchId: randomUUID(),
      recipients: [fire.orgId, ems.orgId],
      description: "Provide agency-appropriate aid for the exercise",
      resourceKind: "other" as const,
      quantity: 1,
      priority: "high" as const,
      stagingLocation: "North staging",
    };
    const results = await sendAgencyAidRequest(token, requesterOrgId, input);
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).toBe(true);
    await sendAgencyAidRequest(token, requesterOrgId, input);
    expect((await readAgencyRequests(token, requesterOrgId, room.id)).requests).toHaveLength(2);
    for (const a of [fire, ems]) await runAgencyCycle(a);
    const board = await readAgencyRequests(token, requesterOrgId, room.id);
    expect(board.responses.filter((r) => r.status === "filled")).toHaveLength(2);
    expect(board.responses.filter((r) => r.status === "acknowledged")).toHaveLength(2);
    expect(new Set(board.responses.map((r) => r.orgId))).toEqual(new Set([fire.orgId, ems.orgId]));
    expect(
      (await listIncidentAssignments(token, requesterOrgId, room.id)).filter(
        (a) => a.assignmentType === "resource",
      ),
    ).toHaveLength(2);
    const fw = await readFramework(token, room.id);
    expect(fw.observations).toHaveLength(2);
    expect(fw.observations.every((o) => o.latitude === null && o.state === "unknown")).toBe(true);
    for (const a of [fire, ems]) await runAgencyCycle(a);
    expect((await readAgencyRequests(token, requesterOrgId, room.id)).responses).toHaveLength(4);
    await expect(
      respondToAgencyRequest(police.commandToken, police.orgId, {
        incidentId: room.id,
        requestId: board.requests[0].id,
        status: "filled",
        message: "Wrong entity",
      }),
    ).rejects.toThrow();
    await sendAgencyAidRequest(token, requesterOrgId, {
      ...input,
      batchId: randomUUID(),
      recipients: [fire.orgId],
      quantity: 5,
    });
    await runAgencyCycle(fire);
    const partial = await readAgencyRequests(token, requesterOrgId, room.id);
    expect(partial.responses.some((r) => r.status === "partially_filled")).toBe(true);
    await beginClosure(
      token,
      requesterOrgId,
      room.id,
      { reason: "Exercise complete", expectedVersion: room.version },
      {},
    );
    await expect(
      respondToAgencyRequest(fire.commandToken, fire.orgId, {
        incidentId: room.id,
        requestId: board.requests.find((r) => r.recipientOrgId === fire.orgId)!.id,
        status: "filled",
        message: "Too late",
      }),
    ).rejects.toThrow();
    await runAgencyCycle(fire);
    expect((await listResources(fire.adminToken,fire.orgId)).every(r=>r.readinessStatus==='available')).toBe(true);
  }, 120000);
});
