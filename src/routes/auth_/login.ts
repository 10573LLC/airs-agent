import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth_/login")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { startOidc } = await import("@/lib/auth/oidc.server");
        const { setCookie } = await import("@tanstack/react-start/server");
        try {
          const flow = await startOidc(new URL(request.url).searchParams.get("redirect"));
          setCookie("__Host-airs_oidc", flow.cookie, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: flow.maxAge,
          });
          return new Response(null, {
            status: 302,
            headers: {
              Location: flow.location,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            },
          });
        } catch {
          return new Response("Sign-in is temporarily unavailable.", {
            status: 503,
            headers: { "Cache-Control": "no-store" },
          });
        }
      },
    },
  },
});
