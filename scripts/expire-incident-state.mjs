#!/usr/bin/env node
/**
 * AIRS Agent — incident expiration maintenance runner (primary portable path).
 *
 *   AIRS_MAINTENANCE_DATABASE_URL=postgres://airs_maintenance:...@host/airs \
 *     npm run maintenance:expire-incidents
 *
 * Plain Node plus the `pg` driver: no bundler, no framework, no hosting
 * provider, nothing Lovable-specific. Suitable for system cron, systemd
 * timers, Kubernetes CronJobs, GitHub Actions, AWS EventBridge targets or any
 * other external scheduler.
 *
 * Exit codes:  0 = swept, or skipped because another run holds the lock
 *              1 = failure (configuration, connection or database error)
 *
 * Logs are structured JSON and contain no credentials, tokens or incident
 * content — only timing and aggregate counts.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

const url = process.env.AIRS_MAINTENANCE_DATABASE_URL;
const executionId = randomUUID();
const startedAt = new Date();
const t0 = Date.now();

const log = (payload) => console.log(JSON.stringify({ executionId, ...payload }));

if (!url) {
  console.error(
    JSON.stringify({
      executionId,
      event: "maintenance.expiration_failed",
      errorClass: "configuration",
      message: "AIRS_MAINTENANCE_DATABASE_URL is not set",
    }),
  );
  process.exit(1);
}

log({ event: "maintenance.expiration_started", startedAt: startedAt.toISOString() });

const client = new pg.Client({ connectionString: url });
let connected = false;

try {
  await client.connect();
  connected = true;

  // Recorded outside the sweep transaction so it survives a rollback.
  await client.query(
    "SELECT airs.record_maintenance_event($1, 'maintenance.expiration_started', 'ok', $2, NULL)",
    [executionId, JSON.stringify({ source: "cli" })],
  );

  let rows;
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query("SELECT * FROM airs.run_incident_expiration($1)", [
      executionId,
    ]));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await client
      .query(
        "SELECT airs.record_maintenance_event($1, 'maintenance.expiration_failed', 'error', $2, NULL)",
        [executionId, JSON.stringify({ error_class: "database" })],
      )
      .catch(() => {});
    throw error;
  }

  const r = rows[0] ?? {};
  const completedAt = new Date();
  log({
    event: "maintenance.expiration_completed",
    outcome: r.skipped_locked ? "skipped" : "ok",
    reason: r.skipped_locked ? "another_run_in_progress" : undefined,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Date.now() - t0,
    counts: {
      expiredInvitations: Number(r.expired_invitations ?? 0),
      expiredParticipations: Number(r.expired_participations ?? 0),
      expiredRooms: Number(r.expired_rooms ?? 0),
      retentionMarkedRooms: Number(r.purged_rooms ?? 0),
    },
  });
  process.exitCode = 0;
} catch (error) {
  // Message only — never the connection string, never row content.
  const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
  console.error(
    JSON.stringify({
      executionId,
      event: "maintenance.expiration_failed",
      errorClass: connected ? "database" : "connection",
      durationMs: Date.now() - t0,
      message,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
