// Incident resource and personnel assignments panel.
//
// Assignment is temporary use inside one room: it never transfers ownership,
// custody or the right to edit or re-share the record. Only records this
// agency owns can be offered, and only while the room is open.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { DENY_MESSAGES, Denied, Panel } from "@/components/incident-ui";
import { StatusPill, type StatusTone } from "@/components/brand";
import {
  assignToIncidentFn,
  endAssignmentFn,
  listIncidentAssignmentsFn,
  listPersonnelFn,
  listResourcesFn,
  revokeResourceShareFn,
  shareResourceFn,
} from "@/lib/api/resources.functions";
import { CATEGORY_LABELS, SHARING_CLASSIFICATIONS } from "@/lib/resources/model";

const label = (value: string) => value.replaceAll("_", " ");

function tone(status: string): StatusTone {
  if (["active", "deployed"].includes(status)) return "active";
  if (["assigned", "deploying"].includes(status)) return "info";
  if (["released", "completed"].includes(status)) return "neutral";
  if (status === "cancelled") return "critical";
  return "neutral";
}

const inputClass =
  "rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground";
const buttonClass =
  "rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50";
const smallButton =
  "rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted";

export function IncidentAssignments({ incidentId }: { incidentId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listIncidentAssignmentsFn);
  const resourcesFn = useServerFn(listResourcesFn);
  const personnelFn = useServerFn(listPersonnelFn);
  const assignFn = useServerFn(assignToIncidentFn);
  const endFn = useServerFn(endAssignmentFn);
  const shareFn = useServerFn(shareResourceFn);
  const revokeFn = useServerFn(revokeResourceShareFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState("");
  const [personId, setPersonId] = useState("");
  const [classification, setClassification] = useState<string>("participating_orgs");

  const assignments = useQuery({
    queryKey: ["incident-assignments", incidentId],
    queryFn: () => listFn({ data: { incidentId } }),
  });
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => resourcesFn({ data: {} }) });
  const personnel = useQuery({ queryKey: ["personnel"], queryFn: () => personnelFn({ data: {} }) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["incident-assignments", incidentId] });
    void qc.invalidateQueries({ queryKey: ["shared-resources"] });
  };
  const report = (result: { ok: boolean; code?: string }, success: string) => {
    setNotice(result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code}).`));
    refresh();
  };

  const assignResource = useMutation({
    mutationFn: async () => {
      const assigned = await assignFn({
        data: {
          incidentId,
          assignmentType: "resource",
          resourceId,
          visibilityClassification: classification,
        },
      });
      if (assigned.ok && classification !== "originating_org_only") {
        await shareFn({ data: { resourceId, incidentId, classification } });
      }
      return assigned;
    },
    onSuccess: (result) => report(result, "Resource assigned to this room."),
  });

  const assignPerson = useMutation({
    mutationFn: () =>
      assignFn({
        data: {
          incidentId,
          assignmentType: "person",
          personId,
          visibilityClassification: classification,
        },
      }),
    onSuccess: (result) => report(result, "Person assigned to this room."),
  });

  const release = useMutation({
    mutationFn: async (input: { assignmentId: string; resourceId: string | null }) => {
      const ended = await endFn({ data: { assignmentId: input.assignmentId, status: "released" } });
      if (ended.ok && input.resourceId) {
        await revokeFn({
          data: { resourceId: input.resourceId, incidentId, reason: "assignment_released" },
        });
      }
      return ended;
    },
    onSuccess: (result) => report(result, "Assignment released and sharing ended."),
  });

  const owned = resources.data?.ok ? resources.data.data : [];
  const people = personnel.data?.ok ? personnel.data.data : [];

  return (
    <Panel title="Assigned resources and personnel">
      <p className="text-xs text-muted-foreground">
        Assignment grants temporary use inside this room only. Ownership, custody and editing
        authority stay with the owning agency, and release ends partner visibility immediately.
      </p>

      {notice ? (
        <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-foreground">{notice}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <select
          className={inputClass}
          value={resourceId}
          onChange={(event) => setResourceId(event.target.value)}
        >
          <option value="">Select a resource…</option>
          {owned.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.displayName} · {CATEGORY_LABELS[resource.category]}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={personId}
          onChange={(event) => setPersonId(event.target.value)}
        >
          <option value="">Select a person…</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={classification}
          onChange={(event) => setClassification(event.target.value)}
        >
          {SHARING_CLASSIFICATIONS.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={buttonClass}
          disabled={!resourceId || assignResource.isPending}
          onClick={() => assignResource.mutate()}
        >
          Assign resource
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!personId || assignPerson.isPending}
          onClick={() => assignPerson.mutate()}
        >
          Assign person
        </button>
      </div>

      {assignments.data && !assignments.data.ok ? (
        <Denied code={assignments.data.code} />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {(assignments.data?.ok ? assignments.data.data : []).map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-40 flex-1">
                <span className="font-medium">{row.label ?? "(hidden)"}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {label(row.assignmentType)}
                  {row.ownerOrgName ? ` · ${row.ownerOrgName}` : " · your agency"}
                  {` · ${label(row.visibilityClassification)}`}
                </span>
              </span>
              <StatusPill tone={tone(row.status)}>{label(row.status)}</StatusPill>
              {["assigned", "deploying", "active", "deployed"].includes(row.status) &&
              !row.ownerOrgName ? (
                <button
                  type="button"
                  className={smallButton}
                  onClick={() =>
                    release.mutate({ assignmentId: row.id, resourceId: row.resourceId })
                  }
                >
                  Release
                </button>
              ) : null}
            </li>
          ))}
          {(assignments.data?.ok ? assignments.data.data.length : 0) === 0 ? (
            <li className="py-2 text-sm text-muted-foreground">
              Nothing is assigned to this room yet.
            </li>
          ) : null}
        </ul>
      )}
    </Panel>
  );
}
