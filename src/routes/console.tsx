import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import {
  changeMemberRoleFn,
  getMe,
  getOrganization,
  inviteMember,
  listAuditEventsFn,
  listInvitationsFn,
  listOrganizationMembers,
  listSessionsFn,
  regenerateInvitationFn,
  reinstateMembershipFn,
  revokeAllSessionsFn,
  revokeInvitationFn,
  revokeMembershipFn,
  revokeSessionFn,
  selectOrganization,
  signOut,
  suspendMembershipFn,
} from "@/lib/api/auth.functions";
import { AppChrome } from "@/components/brand";
import { ROLE_KEYS, ROLE_LABELS } from "@/lib/rbac/roles";

export const Route = createFileRoute("/console")({
  head: () => ({
    meta: [
      { title: "Agency console — AIRS Agent" },
      {
        name: "description",
        content:
          "Manage organization membership, invitations, roles, sessions and audit history in AIRS Agent.",
      },
      { property: "og:title", content: "Agency console — AIRS Agent" },
      {
        property: "og:description",
        content: "Server-authorized membership, invitation and audit administration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: ConsolePage,
});

const DENY_MESSAGES: Record<string, string> = {
  unauthenticated: "Your session is not valid. Sign in again.",
  session_invalid: "Your session has expired or was revoked. Sign in again.",
  no_active_org: "Select an organization to continue.",
  not_a_member: "You do not hold a membership in that organization.",
  membership_invited: "Your invitation to this organization has not been accepted yet.",
  membership_suspended: "Your membership in this organization is suspended.",
  membership_revoked: "Your membership in this organization was revoked.",
  forbidden: "Your role does not include the permission required for this action.",
  tenant_mismatch: "That record does not belong to your active organization.",
  internal_error: "Something went wrong on the server.",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-border">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        {title}
      </h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Denied({ code }: { code: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {DENY_MESSAGES[code] ?? "Access denied."}
    </p>
  );
}

function ConsolePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("visual_observer");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const me = useServerFn(getMe);
  const org = useServerFn(getOrganization);
  const members = useServerFn(listOrganizationMembers);
  const invites = useServerFn(listInvitationsFn);
  const audit = useServerFn(listAuditEventsFn);
  const sessions = useServerFn(listSessionsFn);
  const selectOrgFn = useServerFn(selectOrganization);
  const inviteFn = useServerFn(inviteMember);
  const revokeInvite = useServerFn(revokeInvitationFn);
  const regenInvite = useServerFn(regenerateInvitationFn);
  const changeRole = useServerFn(changeMemberRoleFn);
  const suspend = useServerFn(suspendMembershipFn);
  const revokeMember = useServerFn(revokeMembershipFn);
  const reinstate = useServerFn(reinstateMembershipFn);
  const revokeSession = useServerFn(revokeSessionFn);
  const revokeAll = useServerFn(revokeAllSessionsFn);
  const doSignOut = useServerFn(signOut);

  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const orgQuery = useQuery({ queryKey: ["org"], queryFn: () => org({ data: {} }) });
  const membersQuery = useQuery({ queryKey: ["members"], queryFn: () => members({ data: {} }) });
  const invitesQuery = useQuery({ queryKey: ["invites"], queryFn: () => invites({ data: {} }) });
  const auditQuery = useQuery({
    queryKey: ["audit"],
    queryFn: () => audit({ data: { limit: 50 } }),
  });
  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: () => sessions() });

  const refreshAll = () =>
    Promise.all(
      ["me", "org", "members", "invites", "audit", "sessions"].map((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      ),
    );

  async function run(action: () => Promise<{ ok: boolean; code?: string }>) {
    const result = await action();
    setNotice(result.ok ? null : (DENY_MESSAGES[result.code ?? ""] ?? "Action denied."));
    await refreshAll();
  }

  if (meQuery.isLoading) {
    return (
      <AppChrome>
        <main className="mx-auto max-w-4xl px-6 py-16 text-sm">Loading…</main>
      </AppChrome>
    );
  }

  const meResult = meQuery.data;
  if (!meResult || !meResult.ok) {
    return (
      <AppChrome>
        <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold text-foreground">Session required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {DENY_MESSAGES[meResult?.code ?? "unauthenticated"]}
        </p>
        <Link to="/auth" className="mt-6 inline-block text-sm underline">
          Go to sign in
        </Link>
        </main>
      </AppChrome>
    );
  }

  const { account, memberships, activeOrgId } = meResult.data;
  const orgResult = orgQuery.data;
  const permissions: string[] = orgResult?.ok ? orgResult.data.permissions : [];
  const canManageUsers = permissions.includes("user.manage");
  const canReadAudit = permissions.includes("audit.read");

  return (
    <AppChrome>
      <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            AIRS Agent console
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            {account.displayName}
          </h1>
          <p className="text-sm text-muted-foreground">{account.email}</p>
          <p className="mt-2 text-sm text-foreground">
            Active organization:{" "}
            <strong>{orgResult?.ok ? orgResult.data.name : "none selected"}</strong>
            {orgResult?.ok ? (
              <span className="text-muted-foreground">
                {" "}
                · {ROLE_LABELS[orgResult.data.roleKey]}
              </span>
            ) : null}
          </p>
          <nav className="mt-3 flex gap-4 text-sm">
            <Link to="/incidents" className="underline">
              Incident rooms
            </Link>
            <Link to="/resources" className="underline">
              Readiness board
            </Link>
            <Link to="/map" className="underline">
              Common operating picture
            </Link>
            <Link to="/awareness" className="underline">
              Awareness board
            </Link>
          </nav>
        </div>
        <button
          onClick={async () => {
            await doSignOut();
            qc.clear();
            await navigate({ to: "/auth" });
          }}
          className="rounded-md border border-input px-3 py-2 text-sm"
        >
          Sign out
        </button>
      </div>

      {notice ? (
        <p
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {notice}
        </p>
      ) : null}

      <Panel title="Organizations">
        <ul className="space-y-2">
          {memberships.map((m) => (
            <li key={m.membershipId} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {m.orgName}{" "}
                <span className="text-muted-foreground">
                  · {ROLE_LABELS[m.roleKey]} · {m.status}
                </span>
              </span>
              <button
                disabled={m.status !== "active" || m.orgId === activeOrgId}
                onClick={() => run(() => selectOrgFn({ data: { orgId: m.orgId } }))}
                className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
              >
                {m.orgId === activeOrgId ? "Active" : "Switch"}
              </button>
            </li>
          ))}
          {memberships.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              You hold no organization memberships yet. An administrator must invite you.
            </li>
          ) : null}
        </ul>
      </Panel>

      <Panel title="Members">
        {membersQuery.data?.ok ? (
          <ul className="space-y-2">
            {membersQuery.data.data.map((m) => (
              <li
                key={m.membershipId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  {m.displayName} <span className="text-muted-foreground">· {m.email}</span>{" "}
                  <span className="text-muted-foreground">· {m.status}</span>
                </span>
                <span className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${m.email}`}
                    value={m.roleKey}
                    disabled={!canManageUsers}
                    onChange={(e) =>
                      run(() =>
                        changeRole({
                          data: { membershipId: m.membershipId, roleKey: e.target.value },
                        }),
                      )
                    }
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  >
                    {ROLE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {ROLE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  {m.status === "suspended" ? (
                    <button
                      disabled={!canManageUsers}
                      onClick={() =>
                        run(() => reinstate({ data: { membershipId: m.membershipId } }))
                      }
                      className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Reinstate
                    </button>
                  ) : (
                    <button
                      disabled={!canManageUsers || m.status !== "active"}
                      onClick={() => run(() => suspend({ data: { membershipId: m.membershipId } }))}
                      className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Suspend
                    </button>
                  )}
                  <button
                    disabled={!canManageUsers || m.status === "revoked"}
                    onClick={() =>
                      run(() => revokeMember({ data: { membershipId: m.membershipId } }))
                    }
                    className="rounded-md border border-input px-2 py-1 text-xs disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : membersQuery.data ? (
          <Denied code={membersQuery.data.code} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </Panel>

      <Panel title="Invitations">
        {canManageUsers ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await inviteFn({ data: { email: inviteEmail, roleKey: inviteRole } });
              if (result.ok) {
                setIssuedToken(result.data.token);
                setInviteEmail("");
                setNotice(null);
              } else {
                setNotice(DENY_MESSAGES[result.code] ?? "Invitation denied.");
              }
              await refreshAll();
            }}
          >
            <label className="text-xs text-muted-foreground">
              E-mail
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="mt-1 block rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Role
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="mt-1 block rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {ROLE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {ROLE_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
              Invite
            </button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your role does not include user administration.
          </p>
        )}

        {issuedToken ? (
          <p className="mt-3 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
            Deliver this one-time link out of band: /invite/{issuedToken}
          </p>
        ) : null}

        {invitesQuery.data?.ok ? (
          <ul className="mt-4 space-y-2">
            {invitesQuery.data.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {i.email}{" "}
                  <span className="text-muted-foreground">
                    · {ROLE_LABELS[i.roleKey]} · {i.status} · expires{" "}
                    {new Date(i.expiresAt).toLocaleString()}
                  </span>
                </span>
                {i.status === "pending" ? (
                  <span className="flex gap-2">
                    <button
                      onClick={async () => {
                        const result = await regenInvite({ data: { invitationId: i.id } });
                        if (result.ok) setIssuedToken(result.data.token);
                        else setNotice(DENY_MESSAGES[result.code] ?? "Action denied.");
                        await refreshAll();
                      }}
                      className="rounded-md border border-input px-2 py-1 text-xs"
                    >
                      Resend
                    </button>
                    <button
                      onClick={() => run(() => revokeInvite({ data: { invitationId: i.id } }))}
                      className="rounded-md border border-input px-2 py-1 text-xs"
                    >
                      Revoke
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
            {invitesQuery.data.data.length === 0 ? (
              <li className="text-sm text-muted-foreground">No invitations.</li>
            ) : null}
          </ul>
        ) : invitesQuery.data ? (
          <div className="mt-3">
            <Denied code={invitesQuery.data.code} />
          </div>
        ) : null}
      </Panel>

      <Panel title="Sessions">
        {sessionsQuery.data?.ok ? (
          <>
            <ul className="space-y-2">
              {sessionsQuery.data.data.map((s) => (
                <li key={s.sessionId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {s.current ? "This device · " : ""}issued{" "}
                    {new Date(s.issuedAt).toLocaleString()} · {s.revokedAt ? "revoked" : "active"}
                  </span>
                  {!s.revokedAt ? (
                    <button
                      onClick={async () => {
                        await revokeSession({ data: { sessionId: s.sessionId } });
                        if (s.current) {
                          qc.clear();
                          await navigate({ to: "/auth" });
                        } else await refreshAll();
                      }}
                      className="rounded-md border border-input px-2 py-1 text-xs"
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              onClick={async () => {
                await revokeAll();
                qc.clear();
                await navigate({ to: "/auth" });
              }}
              className="mt-3 rounded-md border border-input px-3 py-1.5 text-xs"
            >
              Revoke all sessions
            </button>
          </>
        ) : sessionsQuery.data ? (
          <Denied code={sessionsQuery.data.code} />
        ) : null}
      </Panel>

      <Panel title="Audit history">
        {canReadAudit ? (
          auditQuery.data?.ok ? (
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {auditQuery.data.data.map((e) => (
                <li key={e.id}>
                  {new Date(e.occurredAt).toLocaleString()} · {e.outcome} · {e.action} ·{" "}
                  {e.actor ?? "system"}
                </li>
              ))}
            </ul>
          ) : auditQuery.data ? (
            <Denied code={auditQuery.data.code} />
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground">
            Your role does not include the audit.read permission.
          </p>
        )}
      </Panel>
      </main>
    </AppChrome>
  );
}
