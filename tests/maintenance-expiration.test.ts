// Incident expiration maintenance tests (Stage 5B).
//
// Two layers:
//   1. Endpoint authorization — pure, always runs. Proves that neither an
//      anonymous caller nor a signed-in application user can trigger a sweep;
//      the operator secret is the only accepted credential.
//   2. Runner behaviour against a real PostgreSQL server — idempotence and
//      concurrency. Requires TEST_MAINTENANCE_DATABASE_URL (the
//      airs_maintenance role) and TEST_ADMIN_DATABASE_URL for fixtures;
//      without them this half skips so a checkout with no database still runs.
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SECRET = "b7f1c0e3a95d4c2f8e6a1b3d5f70921c";
const OTHER = "b7f1c0e3a95d4c2f8e6a1b3d5f70921d"; // same length, one char apart

const post = (headers: Record<string, string> = {}, url = "https://x/api/maintenance/expire-incidents") =>
  new Request(url, { method: "POST", headers });

type Endpoint = typeof import("@/lib/maintenance/endpoint.server");
let endpoint: Endpoint;

beforeAll(async () => {
  endpoint = await import("@/lib/maintenance/endpoint.server");
});

describe("maintenance endpoint authorization", () => {
  beforeEach(() => {
    process.env.AIRS_MAINTENANCE_ENDPOINT_ENABLED = "true";
    process.env.AIRS_MAINTENANCE_SECRET = SECRET;
    endpoint.resetInvocationGuard();
  });
  afterEach(() => {
    delete process.env.AIRS_MAINTENANCE_ENDPOINT_ENABLED;
    delete process.env.AIRS_MAINTENANCE_SECRET;
  });

  it("is absent unless explicitly enabled", () => {
    process.env.AIRS_MAINTENANCE_ENDPOINT_ENABLED = "false";
    const d = endpoint.authorizeMaintenanceRequest(post({ authorization: `Bearer ${SECRET}` }));
    expect(d.ok).toBe(false);
    expect(d.status).toBe(404);
  });

  it("rejects an anonymous request", () => {
    const d = endpoint.authorizeMaintenanceRequest(post());
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
    expect(d.body.reason).toBe("missing_credential");
  });

  it("rejects a browser session cookie — no app role is ever sufficient", () => {
    const d = endpoint.authorizeMaintenanceRequest(
      post({ cookie: "airs_session=whatever; role=agency_administrator" }),
    );
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("rejects an incorrect secret of identical length", () => {
    const d = endpoint.authorizeMaintenanceRequest(post({ authorization: `Bearer ${OTHER}` }));
    expect(d.ok).toBe(false);
    expect(d.body.reason).toBe("invalid_credential");
  });

  it("rejects a secret passed in the query string", () => {
    const d = endpoint.authorizeMaintenanceRequest(
      post({ authorization: `Bearer ${SECRET}` }, `https://x/api/maintenance/expire-incidents?secret=${SECRET}`),
    );
    expect(d.ok).toBe(false);
    expect(d.status).toBe(400);
  });

  it("refuses to run when no secret is configured", () => {
    delete process.env.AIRS_MAINTENANCE_SECRET;
    const d = endpoint.authorizeMaintenanceRequest(post({ authorization: "Bearer x" }));
    expect(d.status).toBe(503);
  });

  it("refuses a too-short secret rather than accepting a weak one", () => {
    process.env.AIRS_MAINTENANCE_SECRET = "short";
    const d = endpoint.authorizeMaintenanceRequest(post({ authorization: "Bearer short" }));
    expect(d.status).toBe(503);
  });

  it("rejects non-POST methods", async () => {
    const res = endpoint.authorizeMaintenanceRequest(
      new Request("https://x/api/maintenance/expire-incidents", {
        method: "GET",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(405);
  });

  it("accepts the correct secret, then rate-limits an immediate repeat", () => {
    const first = endpoint.authorizeMaintenanceRequest(post({ authorization: `Bearer ${SECRET}` }));
    expect(first.ok).toBe(true);
    const second = endpoint.authorizeMaintenanceRequest(post({ authorization: `Bearer ${SECRET}` }));
    expect(second.ok).toBe(false);
    expect(second.status).toBe(429);
  });

  it("never echoes the secret in a response body", () => {
    const d = endpoint.authorizeMaintenanceRequest(post({ authorization: `Bearer ${OTHER}` }));
    expect(JSON.stringify(d.body)).not.toContain(OTHER);
    expect(JSON.stringify(d.body)).not.toContain(SECRET);
  });
});

const MAINT_URL = process.env.TEST_MAINTENANCE_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const live = Boolean(MAINT_URL && ADMIN_URL);

describe.runIf(live)("maintenance runner against PostgreSQL", () => {
  const ORG_A = "11111111-1111-4111-8111-111111111111";
  const RUN = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  let roomId: string;

  beforeAll(async () => {
    process.env.AIRS_MAINTENANCE_DATABASE_URL = MAINT_URL;
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const { rows } = await admin.query(
      `INSERT INTO airs.incident_rooms (org_id, name, incident_type, status, scheduled_expires_at)
       VALUES ($1, $2, 'critical_incident', 'active', now() - interval '1 hour') RETURNING id`,
      [ORG_A, `maint test ${RUN}`],
    );
    roomId = rows[0].id;
  });

  afterAll(async () => {
    if (roomId) await admin.query("DELETE FROM airs.incident_rooms WHERE id = $1", [roomId]);
    await admin.query("DELETE FROM airs.audit_events WHERE resource_id::text = $1", [roomId]);
    await admin.end();
  });

  it("closes the elapsed room and records a maintenance event", async () => {
    const { runIncidentExpiration } = await import("@/lib/maintenance/expiration.server");
    const result = await runIncidentExpiration();
    expect(result.ran).toBe(true);
    expect(result.skippedLocked).toBe(false);
    expect(result.expiredRooms).toBeGreaterThanOrEqual(1);

    const room = await admin.query("SELECT status FROM airs.incident_rooms WHERE id = $1", [roomId]);
    expect(room.rows[0].status).toBe("closed");

    const ev = await admin.query(
      `SELECT action, outcome FROM airs.maintenance_events
        WHERE execution_id = $1 ORDER BY id`,
      [result.executionId],
    );
    expect(ev.rows.map((r) => r.action)).toContain("maintenance.expiration_started");
    expect(ev.rows.map((r) => r.action)).toContain("maintenance.expiration_completed");
    expect(ev.rows.at(-1)?.outcome).toBe("ok");
  });

  it("is idempotent: an immediate second run changes nothing", async () => {
    const { runIncidentExpiration } = await import("@/lib/maintenance/expiration.server");
    const result = await runIncidentExpiration();
    expect(
      result.expiredInvitations +
        result.expiredParticipations +
        result.expiredRooms +
        result.purgedRooms,
    ).toBe(0);
  });

  it("skips cleanly when another runner already holds the lock", async () => {
    const holder = new Client({ connectionString: MAINT_URL });
    const second = new Client({ connectionString: MAINT_URL });
    await holder.connect();
    await second.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM airs.run_incident_expiration(gen_random_uuid())");

      const { rows } = await second.query(
        "SELECT * FROM airs.run_incident_expiration(gen_random_uuid())",
      );
      expect(rows[0].skipped_locked).toBe(true);
      expect(rows[0].ran).toBe(false);
      expect(Number(rows[0].expired_rooms)).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await second.end();
    }
  });

  it("fails closed with a clear error when no maintenance connection is configured", async () => {
    const { runIncidentExpiration, MaintenanceError } = await import(
      "@/lib/maintenance/expiration.server"
    );
    const saved = process.env.AIRS_MAINTENANCE_DATABASE_URL;
    delete process.env.AIRS_MAINTENANCE_DATABASE_URL;
    try {
      await expect(runIncidentExpiration()).rejects.toBeInstanceOf(MaintenanceError);
    } finally {
      process.env.AIRS_MAINTENANCE_DATABASE_URL = saved;
    }
  });
});
