import { createFileRoute } from "@tanstack/react-router";

// Liveness/readiness probe. Reports whether the configured PostgreSQL adapter
// can be reached. No PII, no tenant data.
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.DATABASE_URL;
        if (!url) {
          return Response.json(
            { status: "degraded", database: "unconfigured" },
            { status: 503 },
          );
        }
        try {
          const { getDatabase } = await import("@/lib/adapters/index.server");
          const db = getDatabase();
          await db.withTenant(
            { orgId: "00000000-0000-4000-8000-000000000000", userId: "00000000-0000-4000-8000-000000000000" },
            (q) => q.query("SELECT 1"),
          );
          return Response.json({ status: "ok", database: "reachable" });
        } catch (error) {
          console.error("health check failed", error);
          return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
        }
      },
    },
  },
});