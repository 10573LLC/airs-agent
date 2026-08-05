import { createFileRoute } from "@tanstack/react-router";

/**
 * Protected maintenance endpoint: POST /api/maintenance/expire-incidents
 *
 * Optional. The command-line runner (`npm run maintenance:expire-incidents`)
 * is the primary, fully portable execution path; this endpoint exists for
 * hosted schedulers that can only make an HTTP call. It is disabled unless
 * `AIRS_MAINTENANCE_ENDPOINT_ENABLED=true`, and it authorizes on a dedicated
 * operator secret — never on a browser session, an organization role or an
 * incident role.
 *
 * Deliberately NOT under /api/public/: this path stays behind whatever gate
 * the deployment already has, and the secret check is applied on top.
 */
export const Route = createFileRoute("/api/maintenance/expire-incidents")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify({ status: "error", reason: "method_not_allowed" }), {
          status: 405,
          headers: { allow: "POST", "content-type": "application/json" },
        }),
      POST: async ({ request }) => {
        const { handleMaintenanceExpirationRequest } = await import(
          "@/lib/maintenance/endpoint.server"
        );
        return handleMaintenanceExpirationRequest(request);
      },
    },
  },
});
