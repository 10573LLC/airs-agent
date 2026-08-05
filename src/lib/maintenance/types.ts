/**
 * Shared shapes for the incident expiration maintenance plane (Stage 5B).
 * Client-safe: types only, no runtime imports.
 */

/** One completed (or lock-skipped) expiration run. */
export interface ExpirationRunResult {
  executionId: string;
  ran: boolean;
  /** true when another runner already held the advisory lock. */
  skippedLocked: boolean;
  expiredInvitations: number;
  expiredParticipations: number;
  expiredRooms: number;
  purgedRooms: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** Minimal response body returned by the protected maintenance endpoint. */
export interface MaintenanceResponseBody {
  status: "ok" | "skipped" | "error";
  executionId?: string;
  durationMs?: number;
  counts?: {
    invitations: number;
    participations: number;
    rooms: number;
    retention: number;
  };
  reason?: string;
}

/** Error classes recorded in maintenance audit metadata (never raw messages). */
export type MaintenanceErrorClass =
  | "configuration"
  | "connection"
  | "authorization"
  | "database"
  | "unknown";
