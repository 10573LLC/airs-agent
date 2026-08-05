/**
 * Time-based incident expiration runner.
 *
 * All expiration logic lives in the database routine `airs.expire_incident_state()`
 * (SECURITY DEFINER, only ever removes access, audits every change). This module
 * is a thin, portable invoker so the same behaviour is reachable from:
 *   - an operating-system scheduler (`npm run incidents:expire`)
 *   - a container/orchestrator sidecar
 *   - an authenticated HTTP endpoint for hosted schedulers
 *   - pg_cron inside the database itself
 *
 * Nothing here depends on a specific host or builder.
 */
import { getDatabase } from "@/lib/adapters/index.server";

/** Advisory lock key: keeps concurrent schedulers from racing the same sweep. */
export const EXPIRATION_LOCK_KEY = 8_421_701;

export interface ExpirationResult {
  ran: boolean;
  /** false when another runner already held the advisory lock. */
  skippedLocked: boolean;
  expiredInvitations: number;
  expiredParticipations: number;
  expiredRooms: number;
  purgedRooms: number;
  durationMs: number;
  ranAt: string;
}

interface SweepRow {
  expired_invitations: number | string;
  expired_participations: number | string;
  expired_rooms: number | string;
  purged_rooms: number | string;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

/**
 * Executes one expiration sweep. Safe to call repeatedly: the routine is
 * idempotent and guarded by a transaction-scoped advisory lock.
 */
export async function runIncidentExpirationSweep(): Promise<ExpirationResult> {
  const started = Date.now();
  const db = getDatabase();

  // No tenant GUCs: the sweep is cross-tenant by design and runs as the
  // definer, never as a signed-in user.
  return db.withContext({}, async (q) => {
    const [lock] = await q.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [EXPIRATION_LOCK_KEY],
    );
    if (!lock?.locked) {
      return {
        ran: false,
        skippedLocked: true,
        expiredInvitations: 0,
        expiredParticipations: 0,
        expiredRooms: 0,
        purgedRooms: 0,
        durationMs: Date.now() - started,
        ranAt: new Date().toISOString(),
      } satisfies ExpirationResult;
    }

    const rows = await q.query<SweepRow>("SELECT * FROM airs.expire_incident_state()");
    const r = rows[0];
    return {
      ran: true,
      skippedLocked: false,
      expiredInvitations: num(r?.expired_invitations),
      expiredParticipations: num(r?.expired_participations),
      expiredRooms: num(r?.expired_rooms),
      purgedRooms: num(r?.purged_rooms),
      durationMs: Date.now() - started,
      ranAt: new Date().toISOString(),
    } satisfies ExpirationResult;
  });
}

/** Constant-time comparison for the scheduler shared secret. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare a fixed-length digest-like window so length alone is not a signal.
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
