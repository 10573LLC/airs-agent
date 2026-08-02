import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import {
  activateIncidentFn,
  archiveIncidentFn,
  beginClosureFn,
  closeIncidentFn,
  invitePartnerFn,
  listParticipantsFn,
  listTrustedAgenciesFn,
  ownerParticipantActionFn,
  pauseIncidentFn,
  readIncidentAuditFn,
  readIncidentFn,
  resumeIncidentFn,
  scheduleIncidentFn,
  setTrustedAgencyStatusFn,
} from "@/lib/api/incidents.functions";
import {
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABELS,
  INCIDENT_TYPE_LABELS,
  TRUST_STATUSES,
  type AccessLevel,
} from "@/lib/incidents/lifecycle";

import { DENY_MESSAGES, Denied, Panel } from "./incidents";

export const Route = createFileRoute("/incidents/$incidentId")({
  head: () => ({
    meta: [
      { title: "Incident room — AIRS Agent" },
      {
        name: "description",
        content:
          "Run one incident room: lifecycle state, participating agencies, access levels and the room's audit history.",
      },
      { property: "og:title", content: "Incident room — AIRS Agent" },
      {
        property: "og:description",
        content: "Lifecycle, participation and audit history for a single AIRS Agent incident room.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: IncidentDetailPage,
});

function hoursFromNow(h: number) {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

function IncidentDetailPage() {
  const { incidentId } = Route.useParams();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [partnerOrgId, setPartnerOrgId] = useState("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("view_only");
  const [closureReason, setClosureReason] = useState("");
  const [trustOrgId, setTrustOrgId] = useState("");
  const [trustStatus, setTrustStatus] = useState<string>("approved");

  const read = useServerFn(readIncidentFn);
  const participants = useServerFn(listParticipantsFn);
  const auditFn = useServerFn(readIncidentAuditFn);
  const trusted = useServerFn(listTrustedAgenciesFn);
  const setTrust = useServerFn(setTrustedAgencyStatusFn);
  const invite = useServerFn(invitePartnerFn);
  const ownerAction = useServerFn(ownerParticipantActionFn);
  const activate = useServerFn(activateIncidentFn);
  const schedule = useServerFn(scheduleIncidentFn);
  const pause = useServerFn(pauseIncidentFn);
  const resume = useServerFn(resumeIncidentFn);
  const beginClose = useServerFn(beginClosureFn);
  const close = useServerFn(closeIncidentFn);
  const archive = useServerFn(archiveIncidentFn);

  const room = useQuery({
    queryKey: ["incident", incidentId],
    queryFn: () => read({ data: { incidentId } }),
  });
  const roster = useQuery({
    queryKey: ["incident-participants", incidentId],
    queryFn: () => participants({ data: { incidentId } }),
  });
  const history = useQuery({
    queryKey: ["incident-audit", incidentId],
    queryFn: () => auditFn({ data: { incidentId } }),
  });
  const trustList = useQuery({ queryKey: ["trusted"], queryFn: () => trusted({ data: {} }) });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["incident", incidentId] });
    void qc.invalidateQueries({ queryKey: ["incident-participants", incidentId] });
    void qc.invalidateQueries({ queryKey: ["incident-audit", incidentId] });
    void qc.invalidateQueries({ queryKey: ["incidents"] });
  }

  function report(result: { ok: boolean; code?: string }, success: string) {
    setNotice(result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? "Access denied."));
    refresh();
  }

  const transition = useMutation({
    mutationFn: async (action: string) => {
      if (!room.data?.ok) throw new Error("unavailable");
      const expectedVersion = room.data.data.incident.version;
      const data = { incidentId, expectedVersion };
      switch (action) {
        case "schedule":
          return schedule({
            data: { ...data, startAt: hoursFromNow(1), expiresAt: hoursFromNow(24) },
          });
        case "activate":
          return activate({ data });
        case "pause":
          return pause({ data });
        case "resume":
          return resume({ data });
        case "begin_closure":
          return beginClose({ data: { ...data, reason: closureReason || "Operation concluded" } });
        case "close":
          return close({ data: { ...data, reason: closureReason || null } });
        default:
          return archive({ data });
      }
    },
    onSuccess: (result) => report(result, "Lifecycle state updated."),
  });

  const invitePartnerM = useMutation({
    mutationFn: () =>
      invite({
        data: {
          incidentId,
          partnerOrgId,
          accessLevel,
          invitationExpiresAt: hoursFromNow(48),
          participationExpiresAt: hoursFromNow(72),
          requiresApproval: true,
        },
      }),
    onSuccess: (result) => {
      if (result.ok) setIssuedToken(result.data.invitationToken);
      report(result, "Invitation issued.");
    },
  });

  const participantM = useMutation({
    mutationFn: (input: { participantId: string; action: string }) =>
      ownerAction({
        data: {
          incidentId,
          participantId: input.participantId,
          action: input.action as "approve_partner",
          reason: null,
        },
      }),
    onSuccess: (result) => report(result, "Participation updated."),
  });

  const trustM = useMutation({
    mutationFn: () => setTrust({ data: { partnerOrgId: trustOrgId, status: trustStatus } }),
    onSuccess: (result) => {
      setNotice(
        result.ok
          ? "Trusted-agency relationship updated."
          : (DENY_MESSAGES[result.code] ?? "Access denied."),
      );
      void qc.invalidateQueries({ queryKey: ["trusted"] });
    },
  });

  if (room.isLoading) return <main className="mx-auto max-w-4xl px-6 py-16 text-sm">Loading…</main>;
  if (!room.data?.ok) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16">
        <Denied code={room.data?.code ?? "internal_error"} />
        <Link to="/incidents" className="mt-6 inline-block text-sm underline">
          Back to incident rooms
        </Link>
      </main>
    );
  }

  const { incident, relationship } = room.data.data;
  const isOwner = relationship === "origin_admin";

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link to="/incidents" className="text-sm underline">
        Back to incident rooms
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{incident.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {INCIDENT_TYPE_LABELS[incident.incidentType]} · state {incident.status} ·{" "}
        {incident.classification} · version {incident.version}
      </p>
      <p className="text-xs text-muted-foreground">
        Your organization is {isOwner ? "the originating agency" : `a partner (${relationship})`}.
      </p>

      {notice && (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-foreground">{notice}</p>
      )}

      <Panel title="Lifecycle">
        <div className="flex flex-wrap gap-2">
          {["schedule", "activate", "pause", "resume", "begin_closure", "close", "archive"].map(
            (action) => (
              <button
                key={action}
                type="button"
                disabled={transition.isPending}
                onClick={() => transition.mutate(action)}
                className="rounded-md border border-input px-3 py-1 text-xs disabled:opacity-50"
              >
                {action.replace("_", " ")}
              </button>
            ),
          )}
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          Closure reason (required to begin closure)
          <input
            value={closureReason}
            maxLength={1000}
            onChange={(e) => setClosureReason(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          Closing a room revokes every partner grant and expires every pending invitation in the
          same transaction. The server rejects any transition the lifecycle model does not allow.
        </p>
      </Panel>

      {isOwner && (
        <Panel title="Trusted agencies">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              trustM.mutate();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Partner organization ID
              <input
                required
                value={trustOrgId}
                onChange={(e) => setTrustOrgId(e.target.value)}
                className="w-80 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Relationship
              <select
                value={trustStatus}
                onChange={(e) => setTrustStatus(e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              >
                {TRUST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-md border border-input px-3 py-2 text-sm">
              Save relationship
            </button>
          </form>
          <ul className="mt-3 space-y-1 text-sm">
            {(trustList.data?.ok ? trustList.data.data : []).map((t) => (
              <li key={t.id}>
                {t.partnerOrgName ?? t.partnerOrgId}{" "}
                <span className="text-muted-foreground">· {t.status}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {isOwner && (
        <Panel title="Invite a partner agency">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              invitePartnerM.mutate();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Partner organization ID
              <input
                required
                value={partnerOrgId}
                onChange={(e) => setPartnerOrgId(e.target.value)}
                className="w-80 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Access level
              <select
                value={accessLevel}
                onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              >
                {ACCESS_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {ACCESS_LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={invitePartnerM.isPending}
              className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50"
            >
              Issue invitation
            </button>
          </form>
          {issuedToken && (
            <p className="mt-3 break-all rounded-md bg-muted px-3 py-2 text-xs text-foreground">
              One-time invitation reference (shown once, never stored in clear text):{" "}
              <code>{issuedToken}</code>
            </p>
          )}
        </Panel>
      )}

      <Panel title="Participating agencies">
        {roster.data && !roster.data.ok ? (
          <Denied code={roster.data.code} />
        ) : (
          <ul className="space-y-2">
            {(roster.data?.ok ? roster.data.data : []).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {p.partnerOrgName ?? p.partnerOrgId}{" "}
                  <span className="text-muted-foreground">
                    · {ACCESS_LEVEL_LABELS[p.accessLevel]} · invitation {p.invitationStatus} ·{" "}
                    {p.participationStatus}
                  </span>
                </span>
                {isOwner && (
                  <span className="flex flex-wrap gap-2">
                    {(
                      [
                        "approve_partner",
                        "restrict_partner",
                        "revoke_partner",
                        "remove_partner",
                        "revoke_invitation",
                      ] as const
                    ).map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="rounded-md border border-input px-2 py-1 text-xs"
                        onClick={() =>
                          participantM.mutate({ participantId: p.id, action })
                        }
                      >
                        {action.replace("_", " ")}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
            {roster.data?.ok && roster.data.data.length === 0 && (
              <li className="text-sm text-muted-foreground">No partner agencies invited.</li>
            )}
          </ul>
        )}
      </Panel>

      <Panel title="Room history">
        {history.data && !history.data.ok ? (
          <Denied code={history.data.code} />
        ) : (
          <ul className="space-y-1 text-xs">
            {(history.data?.ok ? history.data.data : []).map((row) => (
              <li key={row.id} className="text-muted-foreground">
                <span className="text-foreground">{row.action}</span> · {row.outcome} ·{" "}
                {row.occurredAt} · {row.actorName ?? "system"}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}