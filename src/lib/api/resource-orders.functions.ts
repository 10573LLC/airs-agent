import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
async function run<T>(fn: (token: string | null) => Promise<T>) {
  const { readSessionToken } = await import("./session-cookie.server");
  try {
    return { ok: true as const, data: await fn(readSessionToken()) };
  } catch (error) {
    const { isAccessError } = await import("@/lib/auth/errors");
    return { ok: false as const, code: isAccessError(error) ? error.code : "invalid_input" };
  }
}
export const readResourceOrdersFn = createServerFn({ method: "GET" })
  .validator((d: { incidentId: string }) => z.object({ incidentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) =>
    run(async (token) =>
      (await import("@/lib/incidents/resource-orders.server")).readResourceOrders(
        token,
        null,
        data.incidentId,
      ),
    ),
  );
export const issueResourceOrderFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d)
  .handler(async ({ data }) =>
    run(async (token) => {
      const s = await import("@/lib/incidents/resource-orders.server");
      return s.issueResourceOrder(token, null, s.orderInput.parse(data));
    }),
  );
export const reportResourceOrderFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d)
  .handler(async ({ data }) =>
    run(async (token) => {
      const s = await import("@/lib/incidents/resource-orders.server");
      return s.reportResourceOrder(token, null, s.orderReportInput.parse(data));
    }),
  );
