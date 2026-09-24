import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { getLoginMode, signIn } from "@/lib/api/auth.functions";
import { BRAND, BrandMark } from "@/components/brand";

export const Route = createFileRoute("/auth")({
  loader: () => getLoginMode(),
  validateSearch: (search: Record<string, unknown>) => {
    // Only same-origin, absolute-path redirects are honoured — never a full URL.
    const raw = typeof search.redirect === "string" ? search.redirect : "";
    const redirect = /^\/[A-Za-z0-9\-._~/%$]*$/.test(raw) && !raw.startsWith("//") ? raw : "";
    return {
      ...(redirect ? { redirect } : {}),
      ...(search.error === "sign_in_failed" ? { error: "sign_in_failed" } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "Sign in — AIRS Agent" },
      {
        name: "description",
        content:
          "Sign in to AIRS Agent to reach your agency's incident airspace coordination console.",
      },
      { property: "og:title", content: "Sign in — AIRS Agent" },
      {
        property: "og:description",
        content: "Authenticated access to agency airspace coordination.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SignInPage,
});

const MESSAGES: Record<string, string> = {
  unauthenticated: "Those credentials were not accepted.",
  internal_error: "Sign-in is temporarily unavailable. Try again shortly.",
};

function SignInPage() {
  const navigate = useNavigate();
  const { redirect, error: loginError } = Route.useSearch();
  const { managed } = Route.useLoaderData();
  const submit = useServerFn(signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await submit({ data: { email, password } });
      if (!result.ok) {
        setError(MESSAGES[result.code] ?? "Those credentials were not accepted.");
        return;
      }
      await navigate({ to: redirect || "/console" });
    } catch {
      setError("Sign-in is temporarily unavailable. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <BrandMark size={80} className="mb-6" />
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {BRAND.name} — {BRAND.tagline}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in with your agency account to continue.
      </p>

      {managed ? (
        <div className="mt-8 space-y-4">
          {loginError ? (
            <p role="alert" className="text-sm text-destructive">
              Sign-in could not be completed. Please try again or contact your administrator.
            </p>
          ) : null}
          <a
            href={`/auth/login?redirect=${encodeURIComponent(redirect || "/console")}`}
            className="block w-full rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground"
          >
            Sign in securely
          </a>
          <p className="text-sm text-muted-foreground">
            Use your invitation credentials and authenticator app. Contact your administrator if you
            need access.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium text-foreground">
              Agency e-mail
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      <Link to="/" className="mt-8 text-xs text-muted-foreground underline">
        Back to overview
      </Link>
    </main>
  );
}
