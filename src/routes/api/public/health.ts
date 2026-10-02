import { createFileRoute } from "@tanstack/react-router";

// Liveness/readiness probe. Reports whether the configured PostgreSQL adapter
// can be reached. No PII, no tenant data.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.DATABASE_URL;
        if (!url) {
          return Response.json({ status: "degraded", database: "unconfigured" }, { status: 503 });
        }
        try {
          const { checkReadiness } = await import("@/lib/readiness.server");
          await checkReadiness();
          return Response.json({ status: "ok", database: "reachable" });
        } catch {
          console.warn("Application readiness check failed");
          return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
        }
      },
    },
  },
});
