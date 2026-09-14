import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const orgIdField = uuid.nullish();
const nullableIso = z.string().min(4).max(64).nullable();

async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("C-UAS operation failed", error);
    return { ok: false, code: "internal_error" };
  }
}

async function serverCtx() {
  const [{ readSessionToken }, { getRequestHeader, getRequestIP }] = await Promise.all([
    import("./session-cookie.server"),
    import("@tanstack/react-start/server"),
  ]);
  return {
    token: readSessionToken(),
    meta: {
      ipAddress: getRequestIP({ xForwardedFor: true }) ?? null,
      userAgent: getRequestHeader("user-agent") ?? null,
    },
  };
}

const service = () => import("@/lib/cuas/cuas.server");

export const readCuasReadinessFn = createServerFn({ method: "GET" })
  .validator((d: { orgId?: string | null }) => z.object({ orgId: orgIdField }).parse(d ?? {}))
  .handler(async ({ data }) =>
    guard(async () => {
      const { readCuasReadiness } = await service();
      const { token, meta } = await serverCtx();
      return readCuasReadiness(token, data.orgId ?? null, meta);
    }),
  );

const profileSchema = z.object({
  orgId: orgIdField,
  participationStatus: z.enum([
    "not_participating",
    "detection_warning",
    "mitigation",
    "correctional_mitigation",
    "suspended",
  ]),
  agencyApprovingOfficial: z.string().max(240),
  counselReviewer: z.string().max(240),
  policyAdoptedAt: nullableIso,
  annualAttestationAt: nullableIso,
  annualAttestationDueAt: nullableIso,
  federalPortalReference: z.string().max(500),
  mutualAidAuthorized: z.boolean(),
  notes: z.string().max(4000),
});

export const saveCuasAgencyProfileFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => profileSchema.parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { saveCuasAgencyProfile } = await service();
      const { token, meta } = await serverCtx();
      return saveCuasAgencyProfile(
        token,
        data.orgId ?? null,
        {
          participationStatus: data.participationStatus,
          agencyApprovingOfficial: data.agencyApprovingOfficial,
          counselReviewer: data.counselReviewer,
          policyAdoptedAt: data.policyAdoptedAt,
          annualAttestationAt: data.annualAttestationAt,
          annualAttestationDueAt: data.annualAttestationDueAt,
          federalPortalReference: data.federalPortalReference,
          mutualAidAuthorized: data.mutualAidAuthorized,
          notes: data.notes,
        },
        meta,
      );
    }),
  );
