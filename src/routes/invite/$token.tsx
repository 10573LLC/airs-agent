// Invitation acceptance.
//
// Everything that matters happens on the server:
//   * the raw token is only ever presented by the browser; the stored SHA-256
//     hash is never returned to the client;
//   * organization and role come from the stored invitation row, so neither the
//     URL nor the form can influence them (there is no control for either);
//   * validity (pending / unexpired / unused / not revoked) and the identity
//     binding rule (invited e-mail == authenticated account e-mail) are checked
//     server-side both on preview and again inside the acceptance transaction.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import {
  acceptInvitationFn,
  getMe,
  previewInvitationFn,
  selectOrganization,
} from "@/lib/api/auth.functions";
import { ROLE_LABELS, type RoleKey } from "@/lib/rbac/roles";

export const Route = createFileRoute("/invite/$token")({
  head: () => ({
    meta: [
      { title: "Accept invitation — AIRS Agent" },
      {
        name: "description",
        content:
          "Accept an agency invitation to join an AIRS Agent organization with the role assigned by its administrator.",
      },
      { property: "og:title", content: "Accept invitation — AIRS Agent" },
      {
        property: "og:description",
        content: "Server-validated, single-use agency invitation acceptance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  // The invitation token must never be sent to a prerender/SSR cache.
  ssr: false,
  component: AcceptInvitationPage,
});

/** Deliberately non-enumerating: every failure reads as "this link is not usable". */
const MESSAGES: Record<string, string> = {
  invitation_invalid: "This invitation link is not valid.",
  invitation_expired: "This invitation link is no longer valid.",
  invitation_revoked: "This invitation link is no longer valid.",
  invitation_used: "This invitation link has already been used.",
  invitation_wrong_recipient:
    "This invitation was issued to a different account. Sign in as the invited recipient.",
  unauthenticated: "Sign in to continue.",
  session_invalid: "Your session has expired. Sign in again to continue.",
  invalid_input: "This invitation link is not valid.",
  internal_error: "Invitations are temporarily unavailable. Try again shortly.",
};

function message(code: string) {
  return MESSAGES[code] ?? "This invitation link is not valid.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        AIRS Agent
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        Agency invitation
      </h1>
      {children}
    </main>
  );
}

function AcceptInvitationPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();

  const me = useServerFn(getMe);
  const preview = useServerFn(previewInvitationFn);
  const accept = useServerFn(acceptInvitationFn);
  const selectOrg = useServerFn(selectOrganization);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const previewQuery = useQuery({
    queryKey: ["invite-preview", token],
    // Only ask for the preview once we know a session exists; otherwise the
    // server would (correctly) refuse and we would render a confusing error.
    enabled: meQuery.data?.ok === true,
    retry: false,
    queryFn: () => preview({ data: { token } }),
  });

  async function onAccept() {
    setBusy(true);
    setError(null);
    try {
      const result = await accept({ data: { token } });
      if (!result.ok) {
        setError(message(result.code));
        return;
      }
      // Land the user in the organization they just joined.
      await selectOrg({ data: { orgId: result.data.orgId } });
      await navigate({ to: "/console" });
    } catch {
      setError(message("internal_error"));
    } finally {
      setBusy(false);
    }
  }

  if (meQuery.isPending) {
    return (
      <Shell>
        <p className="mt-4 text-sm text-muted-foreground">Checking your session…</p>
      </Shell>
    );
  }

  // Not authenticated: initiate authentication, then return here.
  if (!meQuery.data?.ok) {
    return (
      <Shell>
        <p className="mt-4 text-sm text-muted-foreground">
          Sign in with the account this invitation was sent to, then open the invitation link again.
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

  if (previewQuery.isPending) {
    return (
      <Shell>
        <p className="mt-4 text-sm text-muted-foreground">Validating invitation…</p>
      </Shell>
    );
  }

  if (!previewQuery.data || !previewQuery.data.ok) {
    const code =
      previewQuery.data && !previewQuery.data.ok ? previewQuery.data.code : "internal_error";
    return (
      <Shell>
        <p
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {message(code)}
        </p>
        <Link to="/console" className="mt-8 text-xs text-muted-foreground underline">
          Go to the console
        </Link>
      </Shell>
    );
  }

  const invite = previewQuery.data.data;

  // Identity binding: the authenticated account must be the invited recipient.
  if (!invite.recipientMatches) {
    return (
      <Shell>
        <p
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {message("invitation_wrong_recipient")}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Signed in as {meQuery.data.data.account.email}. Invited recipient: {invite.maskedEmail}.
        </p>
        <Link to="/console" className="mt-8 text-xs text-muted-foreground underline">
          Go to the console
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="mt-2 text-sm text-muted-foreground">
        The organization and role below were set by the inviting administrator and cannot be changed
        here.
      </p>

      <dl className="mt-8 space-y-4 rounded-lg border border-border px-4 py-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Organization</dt>
          <dd className="mt-1 font-medium text-foreground">{invite.orgName}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Assigned role</dt>
          <dd className="mt-1 font-medium text-foreground">
            {ROLE_LABELS[invite.roleKey as RoleKey] ?? invite.roleKey}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Recipient</dt>
          <dd className="mt-1 text-foreground">{invite.maskedEmail}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Valid until</dt>
          <dd className="mt-1 text-foreground">{new Date(invite.expiresAt).toLocaleString()}</dd>
        </div>
      </dl>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onAccept}
        disabled={busy}
        className="mt-6 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? "Accepting…" : "Accept invitation"}
      </button>

      <Link to="/console" className="mt-8 text-xs text-muted-foreground underline">
        Cancel
      </Link>
    </Shell>
  );
}
