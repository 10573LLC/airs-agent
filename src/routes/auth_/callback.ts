import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth_/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getCookie, setCookie } = await import("@tanstack/react-start/server");
        const { finishOidc } = await import("@/lib/auth/oidc.server");
        const { createOidcSession } = await import("@/lib/auth/oidc-adapter.server");
        const { writeSessionCookie, readSessionToken } =
          await import("@/lib/api/session-cookie.server");
        const { getAuthAdapter } = await import("@/lib/auth/index.server");
        const cookie = getCookie("__Host-airs_oidc") ?? "";
        setCookie("__Host-airs_oidc", "", {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 0,
        });
        let location = "/auth?error=sign_in_failed";
        try {
          const params = new URL(request.url).searchParams;
          if (params.has("error")) throw new Error("Sign-in cancelled");
          const result = await finishOidc(
            cookie,
            params.get("state") ?? "",
            params.get("code") ?? "",
          );
          const session = await createOidcSession(result.identity, {
            userAgent: request.headers.get("user-agent"),
          });
          const old = readSessionToken();
          if (old) await getAuthAdapter().signOut(old, {});
          writeSessionCookie(session.token, session.expiresAt);
          location = result.returnTo;
        } catch {
          // Never log authorization codes, token bodies, cookies or provider errors.
          console.warn("Cognito sign-in was not completed");
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      },
    },
  },
});
