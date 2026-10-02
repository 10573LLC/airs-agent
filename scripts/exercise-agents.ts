import { Client } from "pg";
import { EXERCISE_AGENCIES } from "../src/lib/exercise-agents/model";
import {
  agentCredential,
  provisionExercise,
  EXERCISE_PREFIX,
} from "../src/lib/exercise-agents/provision.server";
import { runAgencyCycle } from "../src/lib/exercise-agents/runner.server";
import { getAuthAdapter } from "../src/lib/auth/index.server";
import { getDatabase } from "../src/lib/adapters/index.server";
import { readFramework } from "../src/lib/operations/framework.server";

// A separate process: web authentication remains OIDC-only. No HTTP listener.
const url = new URL(process.env.DATABASE_URL ?? "");
if (
  !/^airs-agent-staging-db\.[a-z0-9]+\.us-east-2\.rds\.amazonaws\.com$/.test(url.hostname) ||
  url.username !== "airs_app" ||
  process.env.AUTH_DRIVER !== "local"
)
  throw Error("Refusing non-staging exercise target");
const seed = process.env.EXERCISE_SEED ?? "";
if (seed.length < 32) throw Error("Missing exercise secret");
if (process.argv.includes("--provision")) {
  const adminUrl = new URL(url);
  adminUrl.username = "postgres";
  adminUrl.password = process.env.ADMIN_DB_PASSWORD ?? "";
  if (!adminUrl.password) throw Error("Missing provisioning credential");
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    console.log(JSON.stringify(await provisionExercise(admin, seed, "admin@airsagent.com")));
  } finally {
    await admin.end();
    await getDatabase().close();
  }
} else {
  // One runner at a time, including overlap during ECS deployments.
  const lock = new Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  const locked = (await lock.query("SELECT pg_try_advisory_lock(731026,22) AS locked")).rows[0]
    .locked;
  if (!locked) {
    await lock.end();
    process.exit(0);
  }
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  let agents: {
    agency: (typeof EXERCISE_AGENCIES)[number];
    orgId: string;
    requesterOrgId: string;
    adminToken: string;
    commandToken: string;
  }[] = [];
  let loginAt = 0;
  try {
    do {
      if (Date.now() - loginAt > 30 * 60000) {
        for (const agent of agents) {
          await getAuthAdapter().signOut(agent.adminToken, {});
          await getAuthAdapter().signOut(agent.commandToken, {});
        }
        agents = [];
        for (const agency of EXERCISE_AGENCIES) {
          const login = async (role: string) => {
            const c = agentCredential(seed, agency.key, role);
            const result = await getAuthAdapter().signIn(c.email, c.password, {
              userAgent: `Anconison exercise agent/${agency.key}`,
            });
            if (!result.token) throw Error("Agent login failed");
            return result.token;
          };
          const adminToken = await login("agency_admin"),
            commandToken = await login("incident_commander");
          const identity = await getAuthAdapter().resolve(commandToken);
          const membership = identity?.memberships.find(
            (m) => m.orgSlug === `${EXERCISE_PREFIX}-${agency.key}` && m.status === "active",
          );
          const requester = (await readFramework(adminToken)).directory.find(
            (e) => e.name === "Requesting Agency — EXERCISE",
          );
          if (!membership || !requester) throw Error("Exercise organization mismatch");
          agents.push({
            agency,
            orgId: membership.orgId,
            requesterOrgId: requester.id,
            adminToken,
            commandToken,
          });
        }
        loginAt = Date.now();
        console.log("Anconison responders ready: 12 agency identities; isolated staging only");
      }
      for (const agent of agents) {
        try {
          await runAgencyCycle(agent);
        } catch (error) {
          console.error(
            `Exercise agency ${agent.agency.key}: ${(error as { code?: string }).code ?? "cycle_failed"}`,
          );
        }
      }
      if (process.argv.includes("--once")) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } while (!stopping);
  } finally {
    for (const agent of agents) {
      await getAuthAdapter().signOut(agent.adminToken, {});
      await getAuthAdapter().signOut(agent.commandToken, {});
    }
    await lock.end();
    await getDatabase().close();
  }
}
