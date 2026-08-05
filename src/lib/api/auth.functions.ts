// Protected transport layer. Every function below resolves the session cookie
// server-side and delegates to the authorization chain in
// src/lib/auth/authorize.server.ts. Nothing is protected by the UI alone.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

const uuid = z.string().uuid();
const emailSchema = z.string().email().max(320);
const roleSchema = z.string().min(2).max(64);

/** Runs a server-side operation and converts AccessError into a typed result. */
async function guard<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  const { isAccessError } = await import("@/lib/auth/errors");
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (isAccessError(error)) return { ok: false, code: error.code };
    console.error("server operation failed", error);
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

// --- authentication ---------------------------------------------------------

export const signIn = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string; password: string }) =>
    z.object({ email: emailSchema, password: z.string().min(1).max(512) }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const [{ getAuthAdapter }, { writeSessionCookie }, { AccessError }] = await Promise.all([
        import("@/lib/auth/index.server"),
        import("./session-cookie.server"),
        import("@/lib/auth/errors"),
      ]);
      const { meta } = await serverCtx();
      const result = await getAuthAdapter().signIn(data.email, data.password, meta);
      if (!result.ok || !result.token || !result.expiresAt) {
        throw new AccessError("unauthenticated", result.reason ?? "invalid_credentials");
      }
      writeSessionCookie(result.token, result.expiresAt);
      return { expiresAt: result.expiresAt };
    }),
  );

export const signOut = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const [{ getAuthAdapter }, { clearSessionCookie }] = await Promise.all([
      import("@/lib/auth/index.server"),
      import("./session-cookie.server"),
    ]);
    const { token, meta } = await serverCtx();
    if (token) await getAuthAdapter().signOut(token, meta);
    clearSessionCookie();
    return { signedOut: true };
  }),
);

/** Current authenticated user + every membership. Requires no active organization. */
export const getMe = createServerFn({ method: "GET" }).handler(async () =>
  guard(async () => {
    const { requireSession } = await import("@/lib/auth/authorize.server");
    const { token } = await serverCtx();
    const auth = await requireSession(token);
    return {
      account: auth.account,
      activeOrgId: auth.session.activeOrgId,
      sessionExpiresAt: auth.session.expiresAt,
      memberships: auth.memberships,
    };
  }),
);

export const selectOrganization = createServerFn({ method: "POST" })
  .inputValidator((d: { orgId: string }) => z.object({ orgId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const { selectActiveOrganization } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return selectActiveOrganization(token, data.orgId, meta);
    }),
  );

export const getOrganization = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) =>
    z.object({ orgId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { readOrganization } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return readOrganization(token, data.orgId ?? null, meta);
    }),
  );

// --- membership administration ----------------------------------------------

export const listOrganizationMembers = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) =>
    z.object({ orgId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listMembers } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return listMembers(token, data.orgId ?? null, meta);
    }),
  );

export const changeMemberRoleFn = createServerFn({ method: "POST" })
  .inputValidator((d: { membershipId: string; roleKey: string; orgId?: string | null }) =>
    z.object({ membershipId: uuid, roleKey: roleSchema, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { changeMemberRole } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return changeMemberRole(token, data.orgId ?? null, data.membershipId, data.roleKey, meta);
    }),
  );

export const suspendMembershipFn = createServerFn({ method: "POST" })
  .inputValidator((d: { membershipId: string; orgId?: string | null }) =>
    z.object({ membershipId: uuid, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { suspendMembership } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return suspendMembership(token, data.orgId ?? null, data.membershipId, meta);
    }),
  );

export const revokeMembershipFn = createServerFn({ method: "POST" })
  .inputValidator((d: { membershipId: string; orgId?: string | null }) =>
    z.object({ membershipId: uuid, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { revokeMembership } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return revokeMembership(token, data.orgId ?? null, data.membershipId, meta);
    }),
  );

export const reinstateMembershipFn = createServerFn({ method: "POST" })
  .inputValidator((d: { membershipId: string; orgId?: string | null }) =>
    z.object({ membershipId: uuid, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { reinstateMembership } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return reinstateMembership(token, data.orgId ?? null, data.membershipId, meta);
    }),
  );

// --- invitations -------------------------------------------------------------

export const listInvitationsFn = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null }) =>
    z.object({ orgId: uuid.nullish() }).parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listInvitations } = await import("@/lib/auth/invitations.server");
      const { token, meta } = await serverCtx();
      return listInvitations(token, data.orgId ?? null, meta);
    }),
  );

export const inviteMember = createServerFn({ method: "POST" })
  .inputValidator((d: { email: string; roleKey: string; orgId?: string | null }) =>
    z.object({ email: emailSchema, roleKey: roleSchema, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { createInvitation } = await import("@/lib/auth/invitations.server");
      const { token, meta } = await serverCtx();
      return createInvitation(
        token,
        data.orgId ?? null,
        { email: data.email, roleKey: data.roleKey },
        meta,
      );
    }),
  );

export const revokeInvitationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { invitationId: string; orgId?: string | null }) =>
    z.object({ invitationId: uuid, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { revokeInvitation } = await import("@/lib/auth/invitations.server");
      const { token, meta } = await serverCtx();
      return revokeInvitation(token, data.orgId ?? null, data.invitationId, meta);
    }),
  );

export const regenerateInvitationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { invitationId: string; orgId?: string | null }) =>
    z.object({ invitationId: uuid, orgId: uuid.nullish() }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { regenerateInvitation } = await import("@/lib/auth/invitations.server");
      const { token, meta } = await serverCtx();
      return regenerateInvitation(token, data.orgId ?? null, data.invitationId, meta);
    }),
  );

export const previewInvitationFn = createServerFn({ method: "GET" })
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(16).max(256) }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { previewInvitation } = await import("@/lib/auth/invitations.server");
      const { token } = await serverCtx();
      return previewInvitation(token, data.token);
    }),
  );

export const acceptInvitationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(16).max(256) }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { acceptInvitation } = await import("@/lib/auth/invitations.server");
      const { token, meta } = await serverCtx();
      return acceptInvitation(token, data.token, meta);
    }),
  );

// --- audit + sessions --------------------------------------------------------

export const listAuditEventsFn = createServerFn({ method: "GET" })
  .inputValidator((d: { orgId?: string | null; limit?: number }) =>
    z
      .object({ orgId: uuid.nullish(), limit: z.number().int().min(1).max(200).optional() })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { listAuditEvents } = await import("@/lib/auth/memberships.server");
      const { token, meta } = await serverCtx();
      return listAuditEvents(token, data.orgId ?? null, data.limit ?? 50, meta);
    }),
  );

export const listSessionsFn = createServerFn({ method: "GET" }).handler(async () =>
  guard(async () => {
    const [{ requireSession }, { getAuthAdapter }] = await Promise.all([
      import("@/lib/auth/authorize.server"),
      import("@/lib/auth/index.server"),
    ]);
    const { token } = await serverCtx();
    const auth = await requireSession(token);
    return getAuthAdapter().listSessions(auth.account.accountId, token);
  }),
);

export const revokeSessionFn = createServerFn({ method: "POST" })
  .inputValidator((d: { sessionId: string }) => z.object({ sessionId: uuid }).parse(d))
  .handler(async ({ data }) =>
    guard(async () => {
      const [{ requireSession }, { getAuthAdapter }] = await Promise.all([
        import("@/lib/auth/authorize.server"),
        import("@/lib/auth/index.server"),
      ]);
      const { token, meta } = await serverCtx();
      const auth = await requireSession(token);
      // Scoped to the caller's own account: a session ID from another account
      // is not found and therefore not revoked.
      const revoked = await getAuthAdapter().revokeSession(
        auth.account.accountId,
        data.sessionId,
        meta,
      );
      return { revoked };
    }),
  );

export const revokeAllSessionsFn = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const [{ requireSession }, { getAuthAdapter }, { clearSessionCookie }] = await Promise.all([
      import("@/lib/auth/authorize.server"),
      import("@/lib/auth/index.server"),
      import("./session-cookie.server"),
    ]);
    const { token, meta } = await serverCtx();
    const auth = await requireSession(token);
    const count = await getAuthAdapter().revokeAllSessions(auth.account.accountId, meta);
    clearSessionCookie();
    return { revoked: count };
  }),
);
// --- invitation-driven account activation -----------------------------------
// Unauthenticated by design: the one-time invitation token is the credential
// for this step only. Every validity rule is enforced server-side, and the
// result is a normal authenticated session — access itself is never bypassed.

export const previewActivationFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(16).max(512) }).parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { previewActivation } = await import("@/lib/auth/activation.server");
      return previewActivation(data.token);
    }),
  );

export const activateAccountFn = createServerFn({ method: "POST" })
  .inputValidator((d: { token: string; displayName: string; password: string }) =>
    z
      .object({
        token: z.string().min(16).max(512),
        displayName: z.string().min(2).max(120),
        password: z.string().min(12).max(512),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const [{ activateInvitation }, { writeSessionCookie }] = await Promise.all([
        import("@/lib/auth/activation.server"),
        import("./session-cookie.server"),
      ]);
      const { meta } = await serverCtx();
      const result = await activateInvitation(
        data.token,
        { displayName: data.displayName, password: data.password },
        meta,
      );
      writeSessionCookie(result.token, result.expiresAt);
      // The session token stays in the httpOnly cookie; it is never returned.
      return { orgId: result.orgId, roleKey: result.roleKey, expiresAt: result.expiresAt };
    }),
  );
