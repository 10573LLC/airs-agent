import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduler entry point for the incident expiration sweep.
 *
 * Security posture:
 *  - POST only; a GET can be issued by a crawler or link preview.
 *  - Requires `Authorization: Bearer <INCIDENT_EXPIRY_TOKEN>` compared in
 *    constant time. Without the secret configured the endpoint is disabled
 *    (503) rather than open.
 *  - Returns aggregate counters only: no tenant identifiers, no PII.
 *  - The sweep itself can only remove access, and audits every change.
 */
export const Route = createFileRoute("/api/public/cron/expire-incidents")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.INCIDENT_EXPIRY_TOKEN;
        if (!secret || secret.length < 24) {
          return Response.json(
            { status: "disabled", reason: "scheduler_secret_not_configured" },
            { status: 503 },
          );
        }

        const { timingSafeEqualString, runIncidentExpirationSweep } = await import(
          "@/lib/incidents/expiration.server"
        );

        const header = request.headers.get("authorization") ?? "";
        const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!presented || !timingSafeEqualString(presented, secret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const result = await runIncidentExpirationSweep();
          return Response.json({ status: "ok", ...result });
        } catch (error) {
          console.error("incident expiration sweep failed", error);
          return Response.json({ status: "error" }, { status: 500 });
        }
      },
    },
  },
});
