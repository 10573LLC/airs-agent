import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { getMe } from "@/lib/api/auth.functions";
import {
  createIncidentFn,
  listIncidentsFn,
  listPendingInvitationsFn,
  partnerParticipationActionFn,
} from "@/lib/api/incidents.functions";
import { DENY_MESSAGES, Denied, Panel } from "@/components/incident-ui";
import {
  ACCESS_LEVEL_LABELS,
  INCIDENT_TYPES,
  INCIDENT_TYPE_LABELS,
  type AccessLevel,
} from "@/lib/incidents/lifecycle";

export const Route = createFileRoute("/incidents/")({
  head: () => ({
    meta: [
      { title: "Incident rooms — AIRS Agent" },
      {
        name: "description",
        content:
          "Create and monitor temporary incident rooms, review partner invitations and end sharing when an incident closes.",
      },
      { property: "og:title", content: "Incident rooms — AIRS Agent" },
      {
        property: "og:description",
        content:
          "Owner-controlled, temporary incident coordination rooms with audited partner access.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: IncidentsPage,
});

function IncidentsPage() {
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const list = useServerFn(listIncidentsFn);
  const invitations = useServerFn(listPendingInvitationsFn);
  const create = useServerFn(createIncidentFn);
  const respond = useServerFn(partnerParticipationActionFn);

  const [name, setName] = useState("");
  const [incidentType, setIncidentType] = useState<string>("critical_incident");
  const [notice, setNotice] = useState<string | null>(null);

  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const rooms = useQuery({ queryKey: ["incidents"], queryFn: () => list({ data: {} }) });
  const inbox = useQuery({
    queryKey: ["incident-invitations"],
    queryFn: () => invitations({ data: {} }),
  });

  const createRoom = useMutation({
    mutationFn: () => create({ data: { name, incidentType } }),
    onSuccess: (result) => {
      if (result.ok) {
        setName("");
        setNotice(`Created "${result.data.name}" in draft.`);
        void qc.invalidateQueries({ queryKey: ["incidents"] });
      } else {
        setNotice(DENY_MESSAGES[result.code] ?? "Access denied.");
      }
    },
  });

  const answer = useMutation({
    mutationFn: (input: { participantId: string; action: "accept" | "decline" }) =>
      respond({ data: input }),
    onSuccess: (result) => {
      setNotice(
        result.ok
          ? `Participation is now ${result.data.participationStatus.replace("_", " ")}.`
          : (DENY_MESSAGES[result.code] ?? "Access denied."),
      );
      void qc.invalidateQueries({ queryKey: ["incident-invitations"] });
      void qc.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  if (session.isLoading)
    return <main className="mx-auto max-w-4xl px-6 py-16 text-sm">Loading…</main>;
  if (!session.data?.ok) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold text-foreground">Session required</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in to reach incident rooms.</p>
        <Link to="/auth" className="mt-6 inline-block text-sm underline">
          Go to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        AIRS Agent
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Incident rooms</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every room is owned by the organization that created it. Partner access is temporary and
        ends when the room closes.
      </p>
      <Link to="/console" className="mt-3 inline-block text-sm underline">
        Agency console
      </Link>

      {notice && (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-foreground">{notice}</p>
      )}

      <Panel title="Open a new incident room">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            createRoom.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Room name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Incident type
            <select
              value={incidentType}
              onChange={(e) => setIncidentType(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
            >
              {INCIDENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {INCIDENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={createRoom.isPending}
            className="rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50"
          >
            Create draft room
          </button>
        </form>
      </Panel>

      <Panel title="Rooms visible to your organization">
        {rooms.data && !rooms.data.ok ? (
          <Denied code={rooms.data.code} />
        ) : (
          <ul className="space-y-2">
            {(rooms.data?.ok ? rooms.data.data : []).map((room) => (
              <li
                key={room.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  <Link
                    to="/incidents/$incidentId"
                    params={{ incidentId: room.id }}
                    className="underline"
                  >
                    {room.name}
                  </Link>{" "}
                  <span className="text-muted-foreground">
                    · {INCIDENT_TYPE_LABELS[room.incidentType]} · {room.status}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {room.relationship === "origin"
                    ? "Originating organization"
                    : `Partner · ${ACCESS_LEVEL_LABELS[(room.accessLevel ?? "view_only") as AccessLevel]}`}
                </span>
              </li>
            ))}
            {rooms.data?.ok && rooms.data.data.length === 0 && (
              <li className="text-sm text-muted-foreground">No incident rooms yet.</li>
            )}
          </ul>
        )}
      </Panel>

      <Panel title="Invitations to your organization">
        {inbox.data && !inbox.data.ok ? (
          <Denied code={inbox.data.code} />
        ) : (
          <ul className="space-y-2">
            {(inbox.data?.ok ? inbox.data.data : []).map((inv) => (
              <li
                key={inv.participantId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  {inv.incidentName}{" "}
                  <span className="text-muted-foreground">
                    · from {inv.ownerOrgName} · {ACCESS_LEVEL_LABELS[inv.accessLevel]}
                    {inv.requiresApproval ? " · approval required" : ""}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-input px-2 py-1 text-xs"
                    onClick={() =>
                      answer.mutate({ participantId: inv.participantId, action: "accept" })
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-input px-2 py-1 text-xs"
                    onClick={() =>
                      answer.mutate({ participantId: inv.participantId, action: "decline" })
                    }
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
            {inbox.data?.ok && inbox.data.data.length === 0 && (
              <li className="text-sm text-muted-foreground">No pending invitations.</li>
            )}
          </ul>
        )}
      </Panel>
    </main>
  );
}
