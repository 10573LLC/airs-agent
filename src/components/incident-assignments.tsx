// Incident resource and personnel assignments panel.
//
// Assignment is temporary use inside one room: it never transfers ownership,
// custody or the right to edit or re-share the record. Only records this
// agency owns can be offered, and only while the room is open.
//
// Resource commitment is two explicit AIRS choices:
//  - "Assign to incident (agency only)": the assignment is recorded with
//    visibilityClassification originating_org_only and NOTHING is shared with
//    partners. The Readiness Board remains this agency's master inventory.
//  - "Assign and share with partners": the assignment is created first; only
//    after it succeeds is the record shared under the operator-selected
//    existing sharing classification and disclosure profile.
// Release always ends the assignment and revokes any resource share
// immediately, through the existing APIs.
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
import {
  DISCLOSURE_PROFILE_LABELS,
  PARTNER_DISCLOSURE_PROFILES,
  type DisclosureProfile,
} from "@/lib/resources/disclosure";
import {
  executeResourceCommitment,
  PARTNER_SHARING_CLASSIFICATIONS,
  planResourceCommitment,
  type ResourceCommitmentChoice,
} from "@/lib/resources/assignment-sharing";

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
const secondaryButtonClass =
  "rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50";
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
  // Partner sharing selections for RESOURCE commitment. Only used by the
  // "Assign and share with partners" choice; agency-only ignores both.
  const [shareClassification, setShareClassification] = useState<string>("participating_orgs");
  const [shareProfile, setShareProfile] = useState<DisclosureProfile>("summary");
  // Personnel assignment keeps its existing classification/profile behavior.
  const [personClassification, setPersonClassification] = useState<string>("participating_orgs");
  const [personProfile, setPersonProfile] = useState<DisclosureProfile>("summary");

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
    setNotice(
      result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code}).`),
    );
    refresh();
  };

  const assignResource = useMutation({
    mutationFn: async (choice: ResourceCommitmentChoice) => {
      const plan = planResourceCommitment({
        choice,
        classification: shareClassification,
        disclosureProfile: shareProfile,
      });
      return executeResourceCommitment(
        plan,
        () =>
          assignFn({
            data: {
              incidentId,
              assignmentType: "resource",
              resourceId,
              visibilityClassification: plan.visibilityClassification,
              disclosureProfile: plan.disclosureProfile,
            },
          }),
        (share) =>
          shareFn({
            data: {
              resourceId,
              incidentId,
              classification: share.classification,
              disclosureProfile: share.disclosureProfile,
            },
          }),
      );
    },
    onSuccess: ({ assigned, shareResult, shared }) => {
      if (assigned.ok && shareResult && !shareResult.ok) {
        const denial =
          DENY_MESSAGES[shareResult.code ?? ""] ?? `Denied (${shareResult.code ?? "unknown"}).`;
        setNotice(`Resource assigned to this incident, but partner sharing failed: ${denial}`);
        refresh();
        return;
      }
      report(
        assigned,
        shared
          ? "Resource assigned and shared with partners under the selected classification and disclosure profile."
          : "Resource assigned for your agency only. Partners cannot see it.",
      );
    },
  });

  const assignPerson = useMutation({
    mutationFn: () =>
      assignFn({
        data: {
          incidentId,
          assignmentType: "person",
          personId,
          visibilityClassification: personClassification,
          disclosureProfile: personProfile,
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
        authority stay with the owning agency, whose Readiness Board remains the master inventory.
        Release ends the assignment and revokes any partner sharing immediately.
      </p>

      {notice ? (
        <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-foreground">{notice}</p>
      ) : null}

      <fieldset className="mt-4 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">Commit a resource</legend>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Agency only</span> records the assignment
          for your agency alone — nothing is disclosed to partner agencies.{" "}
          <span className="font-medium text-foreground">Share with partners</span> creates the
          assignment first, then shares the record under the sharing classification and disclosure
          profile selected below.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <select
            className={inputClass}
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
            aria-label="Resource to commit"
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
            value={shareClassification}
            onChange={(event) => setShareClassification(event.target.value)}
            aria-label="Partner sharing classification"
          >
            {PARTNER_SHARING_CLASSIFICATIONS.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            value={shareProfile}
            onChange={(event) => setShareProfile(event.target.value as DisclosureProfile)}
            aria-label="Disclosure profile"
          >
            {PARTNER_DISCLOSURE_PROFILES.map((value) => (
              <option key={value} value={value}>
                Discloses: {DISCLOSURE_PROFILE_LABELS[value]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={!resourceId || assignResource.isPending}
            onClick={() => assignResource.mutate("agency_only")}
          >
            Assign to incident (agency only)
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!resourceId || assignResource.isPending}
            onClick={() => assignResource.mutate("share_with_partners")}
          >
            Assign and share with partners
          </button>
        </div>
      </fieldset>

      <fieldset className="mt-3 rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-foreground">Assign personnel</legend>
        <div className="flex flex-wrap items-end gap-2">
          <select
            className={inputClass}
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            aria-label="Person to assign"
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
            value={personClassification}
            onChange={(event) => setPersonClassification(event.target.value)}
            aria-label="Personnel visibility classification"
          >
            {SHARING_CLASSIFICATIONS.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            value={personProfile}
            onChange={(event) => setPersonProfile(event.target.value as DisclosureProfile)}
            aria-label="Personnel disclosure profile"
          >
            {PARTNER_DISCLOSURE_PROFILES.map((value) => (
              <option key={value} value={value}>
                Discloses: {DISCLOSURE_PROFILE_LABELS[value]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={buttonClass}
            disabled={!personId || assignPerson.isPending}
            onClick={() => assignPerson.mutate()}
          >
            Assign person
          </button>
        </div>
      </fieldset>

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
                  {row.visibilityClassification === "originating_org_only"
                    ? " · agency only (not shared)"
                    : ` · ${label(row.visibilityClassification)}`}
                  {row.disclosureProfile
                    ? ` · discloses ${DISCLOSURE_PROFILE_LABELS[row.disclosureProfile]}`
                    : ""}
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
