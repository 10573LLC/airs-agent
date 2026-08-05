/**
 * Portable incident expiration runner (server-only).
 *
 * Every state transition lives in the database: this module opens a connection
 * as the dedicated `airs_maintenance` role, records the start event, calls
 * `airs.run_incident_expiration()` in one transaction, and records a failure
 * event outside that transaction if the sweep raised.
 *
 * It depends on nothing but `pg` and an environment variable, so the same code
 * runs under systemd, a Kubernetes CronJob, a container sidecar or any host.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

import type { ExpirationRunResult, MaintenanceErrorClass } from "./types";

/** Transaction-scoped advisory lock shared by every invocation path. */
export const EXPIRATION_LOCK_KEY = 8_421_701;

export class MaintenanceError extends Error {
  constructor(
    message: string,
    readonly errorClass: MaintenanceErrorClass,
  ) {
    super(message);
    this.name = "MaintenanceError";
  }
}

/**
 * Maintenance uses its own connection string so scheduled work never borrows
 * the application pool, the application role, or a pooled session that might
 * still carry `airs.*` tenant GUCs.
 */
export function getMaintenanceDatabaseUrl(): string {
  const url = process.env["AIRS_MAINTENANCE_DATABASE_URL"];
  if (!url) {
    throw new MaintenanceError("AIRS_MAINTENANCE_DATABASE_URL is not set", "configuration");
  }
  return url;
}

const int = (v: unknown): number => Number(v ?? 0);

/**
 * Runs one expiration sweep. Safe to call repeatedly and safe to call
 * concurrently: a runner that loses the advisory lock returns
 * `skippedLocked: true` without touching any row.
 */
export async function runIncidentExpiration(): Promise<ExpirationRunResult> {
  const executionId = randomUUID();
  const client = new pg.Client({ connectionString: getMaintenanceDatabaseUrl() });

  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new MaintenanceError(shortMessage(error), "connection");
  }

  try {
    // Outside the sweep transaction so it survives a rollback.
    await client.query(
      "SELECT airs.record_maintenance_event($1, 'maintenance.expiration_started', 'ok', $2, NULL)",
      [executionId, JSON.stringify({ source: "runner" })],
    );

    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM airs.run_incident_expiration($1)", [
        executionId,
      ]);
      await client.query("COMMIT");

      const r = rows[0] ?? {};
      return {
        executionId,
        ran: r.ran === true,
        skippedLocked: r.skipped_locked === true,
        expiredInvitations: int(r.expired_invitations),
        expiredParticipations: int(r.expired_participations),
        expiredRooms: int(r.expired_rooms),
        purgedRooms: int(r.purged_rooms),
        startedAt: new Date(r.started_at ?? Date.now()).toISOString(),
        completedAt: new Date(r.completed_at ?? Date.now()).toISOString(),
        durationMs: int(r.duration_ms),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Record the failure with a classification only — never the raw message,
      // which could echo row content back into the audit trail.
      await client
        .query(
          "SELECT airs.record_maintenance_event($1, 'maintenance.expiration_failed', 'error', $2, NULL)",
          [executionId, JSON.stringify({ error_class: "database" })],
        )
        .catch(() => undefined);
      throw new MaintenanceError(shortMessage(error), "database");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Last successful / last failed run, for a System Auditor surface. */
export async function getMaintenanceStatus() {
  const client = new pg.Client({ connectionString: getMaintenanceDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT * FROM airs.maintenance_expiration_status()");
    return rows[0] ?? null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 200);
}
