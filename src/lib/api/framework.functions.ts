import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { FrameworkCommand } from "@/lib/operations/framework.server";

async function execute<T>(fn: (token: string | null) => Promise<T>) {
  const { readSessionToken } = await import("./session-cookie.server");
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true as const, data: await fn(readSessionToken() ?? null) };
  } catch (error) {
    return {
      ok: false as const,
      code: isAccessError(error)
        ? error.code
        : error instanceof z.ZodError
          ? "invalid_input"
          : "internal_error",
    };
  }
}
export const readFrameworkFn = createServerFn({ method: "GET" })
  .validator((input: { incidentId?: string }) =>
    z.object({ incidentId: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) =>
    execute(async (token) =>
      (await import("@/lib/operations/framework.server")).readFramework(token, data.incidentId),
    ),
  );
export const writeFrameworkFn = createServerFn({ method: "POST" })
  .validator((input: FrameworkCommand) => input)
  .handler(async ({ data }) =>
    execute(async (token) =>
      (await import("@/lib/operations/framework.server")).writeFramework(token, data),
    ),
  );
