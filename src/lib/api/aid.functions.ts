import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
const scope = z.object({ incidentId: z.string().uuid() });
async function run<T>(callback: (token: string | null) => Promise<T>) {
  const { readSessionToken } = await import("./session-cookie.server");
  try {
    return { ok: true as const, data: await callback(readSessionToken()) };
  } catch (error) {
    const { isAccessError } = await import("@/lib/auth/errors");
    return { ok: false as const, code: isAccessError(error) ? error.code : "invalid_input" };
  }
}
export const readAgencyRequestsFn = createServerFn({ method: "GET" })
  .validator((d: { incidentId: string }) => scope.parse(d))
  .handler(async ({ data }) =>
    run(async (token) =>
      (await import("@/lib/incidents/request-responses.server")).readAgencyRequests(
        token,
        null,
        data.incidentId,
      ),
    ),
  );
export const sendAgencyAidRequestFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d)
  .handler(async ({ data }) =>
    run(async (token) => {
      const s = await import("@/lib/incidents/request-responses.server");
      return s.sendAgencyAidRequest(token, null, s.aidInput.parse(data));
    }),
  );
export const respondAgencyRequestFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d)
  .handler(async ({ data }) =>
    run(async (token) => {
      const s = await import("@/lib/incidents/request-responses.server");
      return s.respondToAgencyRequest(token, null, s.responseInput.parse(data));
    }),
  );
