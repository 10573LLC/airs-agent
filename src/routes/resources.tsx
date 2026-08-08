import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { DENY_MESSAGES } from "@/components/incident-ui";
import {
  PageHeading,
  PageShell,
  SectionCard,
  StatusPill,
  type StatusTone,
} from "@/components/brand";
import { getMe } from "@/lib/api/auth.functions";
import { DISCLOSURE_PROFILE_LABELS } from "@/lib/resources/disclosure";
import {
  addQualificationFn,
  createResourceFn,
  createShiftFn,
  listPersonnelFn,
  listQualificationsFn,
  listResourcesFn,
  listSharedResourcesFn,
  listShiftsFn,
  readinessSummaryFn,
  retireResourceFn,
  setPersonnelAvailabilityFn,
  setResourceStatusFn,
  upsertPersonnelFn,
  verifyQualificationFn,
} from "@/lib/api/resources.functions";
import {
  AVAILABILITY_STATUSES,
  CATEGORY_LABELS,
  CATEGORY_STATUSES,
  OPERATIONAL_ROLES,
  QUALIFICATION_TYPES,
  RESOURCE_CATEGORIES,
  STATUS_LABELS,
  type ReadinessStatus,
  type ResourceCategory,
} from "@/lib/resources/model";

export const Route = createFileRoute("/resources")({
  head: () => ({
    meta: [
      { title: "Readiness board — AIRS Agent" },
      {
        name: "description",
        content:
          "Agency-owned registry of aircraft, vehicles, docks, launch sites, sensors and personnel, with live readiness and incident assignments.",
      },
      { property: "og:title", content: "Readiness board — AIRS Agent" },
      {
        property: "og:description",
        content:
          "Every resource belongs to one agency. Readiness, qualifications and shifts stay under owner control.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: ResourcesPage,
});

const label = (value: string) => value.replaceAll("_", " ");

function toneForStatus(status: string): StatusTone {
  if (["available", "ready", "in_service", "operational", "on_duty"].includes(status))
    return "active";
  if (["assigned", "deployed", "in_use", "standby", "on_call"].includes(status)) return "info";
  if (["maintenance", "charging", "inspection", "limited", "rest"].includes(status))
    return "caution";
  if (["out_of_service", "unavailable", "retired", "non_operational"].includes(status))
    return "critical";
  return "neutral";
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {text}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
const buttonClass =
  "rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";
const smallButton =
  "rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted";

function ResourcesPage() {
  const qc = useQueryClient();
  const me = useServerFn(getMe);
  const summaryFn = useServerFn(readinessSummaryFn);
  const resourcesFn = useServerFn(listResourcesFn);
  const sharedFn = useServerFn(listSharedResourcesFn);
  const personnelFn = useServerFn(listPersonnelFn);
  const qualsFn = useServerFn(listQualificationsFn);
  const shiftsFn = useServerFn(listShiftsFn);

  const createResource = useServerFn(createResourceFn);
  const setStatus = useServerFn(setResourceStatusFn);
  const retire = useServerFn(retireResourceFn);
  const upsertPerson = useServerFn(upsertPersonnelFn);
  const setAvailability = useServerFn(setPersonnelAvailabilityFn);
  const addQual = useServerFn(addQualificationFn);
  const verifyQual = useServerFn(verifyQualificationFn);
  const createShift = useServerFn(createShiftFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<ResourceCategory>("aircraft");
  const [displayName, setDisplayName] = useState("");
  const [callsign, setCallsign] = useState("");
  const [personName, setPersonName] = useState("");
  const [personRole, setPersonRole] = useState<string>(OPERATIONAL_ROLES[0]);
  const [qualPerson, setQualPerson] = useState("");
  const [qualType, setQualType] = useState<string>(QUALIFICATION_TYPES[0]);
  const [qualExpiry, setQualExpiry] = useState("");
  const [shiftPerson, setShiftPerson] = useState("");
  const [shiftRole, setShiftRole] = useState<string>(OPERATIONAL_ROLES[0]);
  const [shiftStart, setShiftStart] = useState("");
  const [shiftEnd, setShiftEnd] = useState("");

  const session = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const signedIn = session.data?.ok === true;

  const summary = useQuery({
    queryKey: ["readiness-summary"],
    queryFn: () => summaryFn({ data: {} }),
    enabled: signedIn,
  });
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => resourcesFn({ data: { includeRetired: true } }),
    enabled: signedIn,
  });
  const shared = useQuery({
    queryKey: ["shared-resources"],
    queryFn: () => sharedFn({ data: {} }),
    enabled: signedIn,
  });
  const personnel = useQuery({
    queryKey: ["personnel"],
    queryFn: () => personnelFn({ data: {} }),
    enabled: signedIn,
  });
  const qualifications = useQuery({
    queryKey: ["qualifications"],
    queryFn: () => qualsFn({ data: {} }),
    enabled: signedIn,
  });
  const shifts = useQuery({
    queryKey: ["shifts"],
    queryFn: () => shiftsFn({ data: {} }),
    enabled: signedIn,
  });

  const report = (result: { ok: boolean; code?: string }, success: string) => {
    setNotice(
      result.ok ? success : (DENY_MESSAGES[result.code ?? ""] ?? `Denied (${result.code}).`),
    );
  };
  const refresh = (...keys: string[]) => {
    for (const key of [...keys, "readiness-summary"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const addResource = useMutation({
    mutationFn: () =>
      createResource({ data: { category, displayName, callsign: callsign || null } }),
    onSuccess: (result) => {
      report(result, `Registered ${displayName}.`);
      if (result.ok) {
        setDisplayName("");
        setCallsign("");
        refresh("resources");
      }
    },
  });

  const changeStatus = useMutation({
    mutationFn: (input: { resourceId: string; readinessStatus: string }) =>
      setStatus({ data: input }),
    onSuccess: (result) => {
      report(result, "Readiness updated.");
      refresh("resources");
    },
  });

  const retireOne = useMutation({
    mutationFn: (resourceId: string) => retire({ data: { resourceId } }),
    onSuccess: (result) => {
      report(result, "Resource retired and its shares ended.");
      refresh("resources", "shared-resources");
    },
  });

  const addPerson = useMutation({
    mutationFn: () =>
      upsertPerson({ data: { displayName: personName, operationalRoles: [personRole] } }),
    onSuccess: (result) => {
      report(result, `Added ${personName}.`);
      if (result.ok) {
        setPersonName("");
        refresh("personnel");
      }
    },
  });

  const changeAvailability = useMutation({
    mutationFn: (input: { personId: string; availabilityStatus: string }) =>
      setAvailability({ data: input }),
    onSuccess: (result) => {
      report(result, "Availability updated.");
      refresh("personnel");
    },
  });

  const recordQual = useMutation({
    mutationFn: () =>
      addQual({
        data: {
          personId: qualPerson,
          qualificationType: qualType,
          expiresOn: qualExpiry || null,
        },
      }),
    onSuccess: (result) => {
      report(result, "Qualification recorded as pending verification.");
      if (result.ok) {
        setQualExpiry("");
        refresh("qualifications");
      }
    },
  });

  const verify = useMutation({
    mutationFn: (qualificationId: string) => verifyQual({ data: { qualificationId } }),
    onSuccess: (result) => {
      report(result, "Qualification verified.");
      refresh("qualifications");
    },
  });

  const scheduleShift = useMutation({
    mutationFn: () =>
      createShift({
        data: {
          personId: shiftPerson,
          operationalRole: shiftRole,
          startsAt: new Date(shiftStart).toISOString(),
          endsAt: new Date(shiftEnd).toISOString(),
        },
      }),
    onSuccess: (result) => {
      report(result, "Shift scheduled.");
      if (result.ok) refresh("shifts", "personnel");
    },
  });

  const people = personnel.data?.ok ? personnel.data.data : [];
  const owned = resources.data?.ok ? resources.data.data : [];
  const statusOptions = useMemo(() => CATEGORY_STATUSES[category], [category]);

  if (session.isLoading) {
    return (
      <PageShell width="narrow">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </PageShell>
    );
  }

  if (!signedIn) {
    return (
      <PageShell width="narrow">
        <PageHeading
          eyebrow="AIRS Agent"
          title="Session required"
          description="Sign in to reach your agency's resource registry and readiness board."
        />
        <Link to="/auth" className="mt-6 inline-block text-sm underline">
          Go to sign in
        </Link>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeading
        eyebrow="Operational readiness"
        title="Resource registry and readiness board"
        description="Every record here belongs to your agency. Partner agencies see only what you share into an incident, and only while that sharing lasts."
      />

      {notice ? (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-foreground">{notice}</p>
      ) : null}

      <div className="mt-8 grid gap-6">
        <SectionCard title="Readiness at a glance" description="Live roll-up across your agency.">
          {summary.data?.ok ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Resources</p>
                <ul className="mt-2 space-y-1">
                  {summary.data.data.byStatus.map((row) => (
                    <li
                      key={row.status}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <StatusPill tone={toneForStatus(row.status)}>{label(row.status)}</StatusPill>
                      <span className="font-mono text-xs">{row.count}</span>
                    </li>
                  ))}
                  {summary.data.data.byStatus.length === 0 ? (
                    <li className="text-sm text-muted-foreground">No resources yet.</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Personnel</p>
                <ul className="mt-2 space-y-1">
                  {summary.data.data.personnel.map((row) => (
                    <li
                      key={row.availabilityStatus}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <StatusPill tone={toneForStatus(row.availabilityStatus)}>
                        {label(row.availabilityStatus)}
                      </StatusPill>
                      <span className="font-mono text-xs">{row.count}</span>
                    </li>
                  ))}
                  {summary.data.data.personnel.length === 0 ? (
                    <li className="text-sm text-muted-foreground">No personnel yet.</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Qualifications
                </p>
                <p className="mt-2 text-sm">
                  <span className="font-mono">{summary.data.data.qualifications.current}</span>{" "}
                  current ·{" "}
                  <span className="font-mono">{summary.data.data.qualifications.expired}</span> not
                  current
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Shared into incidents
                </p>
                <p className="mt-2 font-mono text-sm">{summary.data.data.sharedIn}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {summary.isLoading ? "Loading…" : "Summary unavailable."}
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Register a resource"
          description="Aircraft, vehicles, docks, launch sites and sensors are owned by the registering agency."
        >
          <form
            className="grid gap-3 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              addResource.mutate();
            }}
          >
            <Field label="Category">
              <select
                className={inputClass}
                value={category}
                onChange={(event) => setCategory(event.target.value as ResourceCategory)}
              >
                {RESOURCE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input
                className={inputClass}
                value={displayName}
                required
                maxLength={160}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label="Callsign (optional)">
              <input
                className={inputClass}
                value={callsign}
                maxLength={60}
                onChange={(event) => setCallsign(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button className={buttonClass} disabled={addResource.isPending}>
                Register
              </button>
            </div>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            New resources start unavailable. Valid readiness states for {CATEGORY_LABELS[category]}:{" "}
            {statusOptions.map((s) => STATUS_LABELS[s]).join(", ")}.
          </p>
        </SectionCard>

        <SectionCard title="Your resources" description="Owner view — full detail, full control.">
          {owned.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing registered yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {owned.map((resource) => (
                <li key={resource.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-48 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {resource.displayName}
                      {resource.callsign ? (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {resource.callsign}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {CATEGORY_LABELS[resource.category]}
                    </p>
                  </div>
                  <StatusPill tone={toneForStatus(resource.readinessStatus)}>
                    {label(resource.readinessStatus)}
                  </StatusPill>
                  {resource.lifecycleStatus === "retired" ? (
                    <StatusPill tone="critical">retired</StatusPill>
                  ) : (
                    <>
                      <select
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                        value={resource.readinessStatus}
                        onChange={(event) =>
                          changeStatus.mutate({
                            resourceId: resource.id,
                            readinessStatus: event.target.value,
                          })
                        }
                      >
                        {CATEGORY_STATUSES[resource.category].map((value: ReadinessStatus) => (
                          <option key={value} value={value}>
                            {STATUS_LABELS[value]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className={smallButton}
                        onClick={() => retireOne.mutate(resource.id)}
                      >
                        Retire
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Shared with you"
          description="Partner-owned resources visible only through an active incident share. Each record shows the disclosure profile its originating agency approved — fields outside that profile are not withheld from view, they are never sent."
        >
          {shared.data?.ok && shared.data.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {shared.data.data.map((resource) => (
                <li key={`${resource.id}-${resource.incidentId}`} className="py-3 text-sm">
                  <span className="font-medium">{resource.displayName}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {CATEGORY_LABELS[resource.category]} · {label(resource.classification)}
                  </span>
                  <StatusPill className="ml-2" tone={toneForStatus(resource.readinessStatus)}>
                    {label(resource.readinessStatus)}
                  </StatusPill>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Disclosed as{" "}
                    <span className="font-medium text-foreground">
                      {DISCLOSURE_PROFILE_LABELS[resource.disclosureProfile ?? "summary"]}
                    </span>{" "}
                    · {resource.disclosedFields?.length ?? 0} approved fields · the originating
                    agency may narrow this at any time
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No partner resources are shared with you right now.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Personnel readiness"
          description="Operational profiles only — no payroll, HR or medical records are stored."
        >
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              addPerson.mutate();
            }}
          >
            <Field label="Name">
              <input
                className={inputClass}
                value={personName}
                required
                maxLength={160}
                onChange={(event) => setPersonName(event.target.value)}
              />
            </Field>
            <Field label="Operational role">
              <select
                className={inputClass}
                value={personRole}
                onChange={(event) => setPersonRole(event.target.value)}
              >
                {OPERATIONAL_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button className={buttonClass} disabled={addPerson.isPending}>
                Add person
              </button>
            </div>
          </form>

          <ul className="mt-4 divide-y divide-border">
            {people.map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="text-sm font-medium text-foreground">{person.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {person.operationalRoles.map(label).join(", ") || "no role recorded"}
                  </p>
                </div>
                <StatusPill tone={toneForStatus(person.availabilityStatus)}>
                  {label(person.availabilityStatus)}
                </StatusPill>
                <select
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  value={person.availabilityStatus}
                  onChange={(event) =>
                    changeAvailability.mutate({
                      personId: person.id,
                      availabilityStatus: event.target.value,
                    })
                  }
                >
                  {AVAILABILITY_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </li>
            ))}
            {people.length === 0 ? (
              <li className="py-3 text-sm text-muted-foreground">No personnel recorded yet.</li>
            ) : null}
          </ul>
        </SectionCard>

        <SectionCard
          title="Qualifications"
          description="Recorded as pending until an authorized verifier confirms them; expiry is enforced on read."
        >
          <form
            className="grid gap-3 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              recordQual.mutate();
            }}
          >
            <Field label="Person">
              <select
                className={inputClass}
                value={qualPerson}
                required
                onChange={(event) => setQualPerson(event.target.value)}
              >
                <option value="">Select…</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Qualification">
              <select
                className={inputClass}
                value={qualType}
                onChange={(event) => setQualType(event.target.value)}
              >
                {QUALIFICATION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Expires on">
              <input
                type="date"
                className={inputClass}
                value={qualExpiry}
                onChange={(event) => setQualExpiry(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button className={buttonClass} disabled={recordQual.isPending || !qualPerson}>
                Record
              </button>
            </div>
          </form>

          <ul className="mt-4 divide-y divide-border">
            {(qualifications.data?.ok ? qualifications.data.data : []).map((qual) => (
              <li key={qual.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-48 flex-1">
                  <span className="font-medium">{qual.personName}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {label(qual.qualificationType)}
                    {qual.expiresOn ? ` · expires ${qual.expiresOn}` : ""}
                  </span>
                </span>
                <StatusPill tone={qual.isCurrent ? "active" : "critical"}>
                  {qual.isCurrent ? "current" : label(qual.status)}
                </StatusPill>
                <StatusPill tone={qual.verificationStatus === "verified" ? "info" : "caution"}>
                  {label(qual.verificationStatus)}
                </StatusPill>
                {qual.verificationStatus !== "verified" && qual.status !== "revoked" ? (
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() => verify.mutate(qual.id)}
                  >
                    Verify
                  </button>
                ) : null}
              </li>
            ))}
            {(qualifications.data?.ok ? qualifications.data.data.length : 0) === 0 ? (
              <li className="py-3 text-sm text-muted-foreground">No qualifications recorded.</li>
            ) : null}
          </ul>
        </SectionCard>

        <SectionCard
          title="Shifts"
          description="Scheduling windows drive who is on duty; overlapping shifts for one person are rejected."
        >
          <form
            className="grid gap-3 sm:grid-cols-5"
            onSubmit={(event) => {
              event.preventDefault();
              scheduleShift.mutate();
            }}
          >
            <Field label="Person">
              <select
                className={inputClass}
                value={shiftPerson}
                required
                onChange={(event) => setShiftPerson(event.target.value)}
              >
                <option value="">Select…</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select
                className={inputClass}
                value={shiftRole}
                onChange={(event) => setShiftRole(event.target.value)}
              >
                {OPERATIONAL_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Starts">
              <input
                type="datetime-local"
                className={inputClass}
                value={shiftStart}
                required
                onChange={(event) => setShiftStart(event.target.value)}
              />
            </Field>
            <Field label="Ends">
              <input
                type="datetime-local"
                className={inputClass}
                value={shiftEnd}
                required
                onChange={(event) => setShiftEnd(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button
                className={buttonClass}
                disabled={scheduleShift.isPending || !shiftPerson || !shiftStart || !shiftEnd}
              >
                Schedule
              </button>
            </div>
          </form>

          <ul className="mt-4 divide-y divide-border">
            {(shifts.data?.ok ? shifts.data.data : []).slice(0, 12).map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-48 flex-1">
                  <span className="font-medium">{shift.personName}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {label(shift.operationalRole)} · {new Date(shift.startsAt).toLocaleString()} →{" "}
                    {new Date(shift.endsAt).toLocaleString()}
                  </span>
                </span>
                <StatusPill tone={toneForStatus(shift.availabilityStatus)}>
                  {label(shift.availabilityStatus)}
                </StatusPill>
              </li>
            ))}
            {(shifts.data?.ok ? shifts.data.data.length : 0) === 0 ? (
              <li className="py-3 text-sm text-muted-foreground">No shifts scheduled.</li>
            ) : null}
          </ul>
        </SectionCard>
      </div>
    </PageShell>
  );
}
