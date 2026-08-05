/**
 * Authorization and rate limiting for the protected maintenance endpoint.
 *
 * Kept out of the route file so it can be exercised directly by tests. A
 * browser session is never sufficient here: the only accepted credential is
 * the operator-held `AIRS_MAINTENANCE_SECRET`, presented in the Authorization
 * header. It is never read from the query string, never echoed in a response,
 * and never written to a log or audit row.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import type { MaintenanceResponseBody } from "./types";

/** Minimum spacing between accepted invocations, per process. */
export const MIN_INVOCATION_INTERVAL_MS = Number(
  process.env["AIRS_MAINTENANCE_MIN_INTERVAL_MS"] ?? 30_000,
);

/** Shortest secret we will accept, to rule out a weak placeholder value. */
export const MIN_SECRET_LENGTH = 24;

let lastAcceptedAt = 0;

/** Test helper: clears the in-process invocation guard. */
export function resetInvocationGuard(): void {
  lastAcceptedAt = 0;
}

export function isEndpointEnabled(): boolean {
  return (process.env["AIRS_MAINTENANCE_ENDPOINT_ENABLED"] ?? "false").toLowerCase() === "true";
}

/** Constant-time comparison over equal-length digests. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const x = createHash("sha256").update(a, "utf8").digest();
  const y = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(x, y);
}

export interface AuthDecision {
  ok: boolean;
  status: number;
  body: MaintenanceResponseBody;
}

const deny = (status: number, reason: string): AuthDecision => ({
  ok: false,
  status,
  body: { status: "error", reason },
});

/**
 * Decides whether a request may trigger a sweep. Ordinary users — including an
 * Agency Administrator or an Incident Commander with a valid browser session —
 * fail here, because no session or app role is ever consulted.
 */
export function authorizeMaintenanceRequest(request: Request): AuthDecision {
  if (!isEndpointEnabled()) {
    return deny(404, "endpoint_disabled");
  }
  if (request.method !== "POST") {
    return deny(405, "method_not_allowed");
  }

  const url = new URL(request.url);
  if (url.searchParams.has("secret") || url.searchParams.has("token")) {
    // A secret in a URL leaks into proxy and browser history logs.
    return deny(400, "secret_must_not_be_in_query");
  }

  const expected = process.env["AIRS_MAINTENANCE_SECRET"];
  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    return deny(503, "maintenance_secret_not_configured");
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) {
    return deny(401, "missing_credential");
  }
  if (!timingSafeEqualString(presented, expected)) {
    return deny(401, "invalid_credential");
  }

  const now = Date.now();
  if (now - lastAcceptedAt < MIN_INVOCATION_INTERVAL_MS) {
    return deny(429, "rate_limited");
  }
  lastAcceptedAt = now;

  return { ok: true, status: 202, body: { status: "ok" } };
}

/** Full handler: authorize, then run the sweep. Returns a minimal body. */
export async function handleMaintenanceExpirationRequest(request: Request): Promise<Response> {
  const decision = authorizeMaintenanceRequest(request);
  if (!decision.ok) {
    return Response.json(decision.body, { status: decision.status });
  }

  const { runIncidentExpiration } = await import("./expiration.server");
  try {
    const result = await runIncidentExpiration();
    const body: MaintenanceResponseBody = {
      status: result.skippedLocked ? "skipped" : "ok",
      executionId: result.executionId,
      durationMs: result.durationMs,
      counts: {
        invitations: result.expiredInvitations,
        participations: result.expiredParticipations,
        rooms: result.expiredRooms,
        retention: result.purgedRooms,
      },
    };
    if (result.skippedLocked) body.reason = "another_run_in_progress";
    return Response.json(body, { status: 200 });
  } catch (error) {
    // Detail goes to the server log; the caller gets a classification only.
    console.error("maintenance expiration failed", error);
    return Response.json({ status: "error", reason: "run_failed" }, { status: 500 });
  }
}
