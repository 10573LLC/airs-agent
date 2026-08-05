#!/usr/bin/env node
/**
 * Portable incident expiration runner.
 *
 * Standalone Node script — no bundler, no framework, no hosting provider.
 * Runs the same `airs.expire_incident_state()` routine the HTTP endpoint uses.
 *
 *   DATABASE_URL=postgres://... node scripts/expire-incidents.mjs
 *
 * Intended for cron, systemd timers, Kubernetes CronJobs or a container
 * sidecar. Exits 0 on success (including a lock-skip), 1 on failure, so a
 * scheduler can alert on it.
 */
import pg from "pg";

const LOCK_KEY = 8421701;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.PGSSLMODE === "disable" ? false : undefined,
});

const started = Date.now();
try {
  await client.connect();
  await client.query("BEGIN");
  const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [LOCK_KEY]);
  if (!lock.rows[0]?.locked) {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ status: "skipped", reason: "another sweep holds the lock" }));
    process.exit(0);
  }
  const { rows } = await client.query("SELECT * FROM airs.expire_incident_state()");
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      status: "ok",
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...rows[0],
    }),
  );
  process.exit(0);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* connection already unusable */
  }
  console.error("expiration sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
