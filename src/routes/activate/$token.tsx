// One-time account activation for an invited recipient.
//
// The token in the URL only makes the invitation readable; organization, role
// and e-mail all come from the stored row. The page never displays the full
// invited address and never receives a session token in its response body —
// the session arrives as the standard httpOnly cookie.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import {
  activateAccountFn,
  previewActivationFn,
  selectOrganization,
} from "@/lib/api/auth.functions";
import { ROLE_LABELS, type RoleKey } from "@/lib/rbac/roles";

export const Route = createFileRoute("/activate/$token")({
  head: () => ({
    meta: [
      { title: "Activate your account — AIRS Agent" },
      {
        name: "description",
        content:
          "Complete a single-use AIRS Agent invitation by setting the credential for your account.",
      },
      { property: "og:title", content: "Activate your account — AIRS Agent" },
      {
        property: "og:description",
        content: "Server-validated, single-use account activation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  // The activation token must never reach a prerender/SSR cache.
  ssr: false,
  component: ActivateAccountPage,
});

const MESSAGES: Record<string, string> = {
  invitation_invalid: "This activation link is not valid.",
  invitation_expired: "This activation link is no longer valid.",
  invitation_revoked: "This activation link is no longer valid.",
  invitation_used: "This activation link has already been used.",
  invitation_wrong_recipient:
    "An account already exists for this invitation. Sign in first, then open the invitation link.",
  invalid_input: "Check the details you entered and try again.",
  unauthenticated: "Activation could not be completed. Request a new link.",
  internal_error: "Activation is temporarily unavailable. Try again shortly.",
};

function message(code: string) {
  return MESSAGES[code] ?? "This activation link is not valid.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        AIRS Agent
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        Activate your account
      </h1>
      {children}
    </main>
  );
}

function ActivateAccountPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();

  const preview = useServerFn(previewActivationFn);
  const activate = useServerFn(activateAccountFn);
  const selectOrg = useServerFn(selectOrganization);

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const previewQuery = useQuery({
    queryKey: ["activation-preview", token],
    retry: false,
    queryFn: () => preview({ data: { token } }),
  });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await activate({ data: { token, displayName, password } });
      if (!result.ok) {
        setError(message(result.code));
        return;
      }
      await selectOrg({ data: { orgId: result.data.orgId } });
      await navigate({ to: "/console" });
    } catch {
      setError(message("internal_error"));
    } finally {
      setBusy(false);
    }
  }

  if (previewQuery.isPending) {
    return (
      <Shell>
        <p className="mt-4 text-sm text-muted-foreground">Checking this invitation…</p>
      </Shell>
    );
  }

  const data = previewQuery.data;
  if (!data || !data.ok) {
    return (
      <Shell>
        <p
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {message(data && !data.ok ? data.code : "invitation_invalid")}
        </p>
        <Link to="/auth" className="mt-6 text-xs text-muted-foreground underline">
          Go to sign in
        </Link>
      </Shell>
    );
  }

  if (data.data.accountExists) {
    return (
      <Shell>
        <p className="mt-4 text-sm text-muted-foreground">
          An account already exists for this invitation. Sign in first, then open the invitation
          link again to accept it.
        </p>
        <Link
          to="/auth"
          search={{ redirect: `/invite/${token}` }}
          className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Sign in
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <dl className="mt-6 space-y-2 rounded-md border border-border bg-card px-4 py-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Organization</dt>
          <dd className="font-medium text-foreground">{data.data.orgName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="font-medium text-foreground">
            {ROLE_LABELS[data.data.roleKey as RoleKey] ?? data.data.roleKey}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Invited address</dt>
          <dd className="font-medium text-foreground">{data.data.maskedEmail}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Link expires</dt>
          <dd className="font-medium text-foreground">
            {new Date(data.data.expiresAt).toLocaleString()}
          </dd>
        </div>
      </dl>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1">
          <label htmlFor="displayName" className="text-sm font-medium text-foreground">
            Display name
          </label>
          <input
            id="displayName"
            required
            minLength={2}
            maxLength={120}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium text-foreground">
            Password (minimum 12 characters)
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm" className="text-sm font-medium text-foreground">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
          {busy ? "Activating…" : "Activate and sign in"}
        </button>
      </form>
    </Shell>
  );
}
