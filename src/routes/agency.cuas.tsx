import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { DataRow, PageHeading, PageShell, SectionCard, StatusPill } from "@/components/brand";
import { getOrganization } from "@/lib/api/auth.functions";
import { readCuasReadinessFn, saveCuasAgencyProfileFn } from "@/lib/api/cuas.functions";
import type { CuasParticipationStatus } from "@/lib/cuas/capability";

export const Route = createFileRoute("/agency/cuas")({
  head: () => ({
    meta: [
      { title: "C-UAS Readiness — AIRS Agent" },
      {
        name: "description",
        content:
          "Optional SAFER SKIES C-UAS readiness, personnel/equipment capability, compliance, reporting, and mutual-aid posture.",
      },
    ],
  }),
  ssr: false,
  component: CuasReadinessPage,
});

type FormState = {
  participationStatus: CuasParticipationStatus;
  agencyApprovingOfficial: string;
  counselReviewer: string;
  policyAdoptedAt: string | null;
  annualAttestationAt: string | null;
  annualAttestationDueAt: string | null;
  federalPortalReference: string;
  mutualAidAuthorized: boolean;
  notes: string;
};

const LABELS: Record<CuasParticipationStatus, string> = {
  not_participating: "Not participating",
  detection_warning: "Detection & Warning",
  mitigation: "Mitigation",
  correctional_mitigation: "Correctional mitigation",
  suspended: "Suspended",
};

function stateTone(state: string): "neutral" | "info" | "active" | "caution" | "critical" {
  if (state === "mitigation_ready" || state === "detection_ready") return "active";
  if (state === "mutual_aid_only") return "info";
  if (state === "temporarily_unavailable") return "caution";
  if (state === "dormant" || state === "no_local_capability") return "neutral";
  return "critical";
}

function dateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function isoOrNull(value: string) {
  return value ? new Date(`${value}T12:00:00Z`).toISOString() : null;
}

function CuasReadinessPage() {
  const qc = useQueryClient();
  const orgFn = useServerFn(getOrganization);
  const readFn = useServerFn(readCuasReadinessFn);
  const saveFn = useServerFn(saveCuasAgencyProfileFn);
  const org = useQuery({ queryKey: ["org"], queryFn: () => orgFn({ data: {} }) });
  const readiness = useQuery({ queryKey: ["cuas-readiness"], queryFn: () => readFn({ data: {} }) });
  const canManage = org.data?.ok === true && org.data.data.permissions.includes("org.manage");
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (readiness.data?.ok) setForm(readiness.data.data.profile);
  }, [readiness.data]);

  if (org.isLoading || readiness.isLoading) {
    return <PageShell width="narrow"><p className="text-sm text-muted-foreground">Loading C-UAS readiness…</p></PageShell>;
  }

  if (!org.data?.ok || !readiness.data?.ok || !form) {
    return (
      <PageShell width="narrow">
        <PageHeading
          eyebrow="Optional capability"
          title="C-UAS readiness unavailable"
          description="Select an active agency organization with operational access to view this module."
        />
        <Link to="/console" className="mt-6 inline-block text-sm underline">Return to Agency Dashboard</Link>
      </PageShell>
    );
  }

  const summary = readiness.data.data;
  const dormant = summary.capability.state === "dormant";

  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link to="/console" className="underline underline-offset-4">Agency Dashboard</Link>
        <span aria-hidden="true">/</span>
        <span className="font-medium text-foreground">C-UAS Readiness</span>
      </div>

      <PageHeading
        eyebrow="Optional capability"
        title="C-UAS / SAFER SKIES"
        description="Capability-aware compliance support. AIRS does not assume every agency or every incident has C-UAS personnel, equipment, or authority, and ordinary AIRS operations remain available when this module is dormant."
      />

      <div className="mt-6 rounded-md border border-border bg-muted/35 px-4 py-3 text-sm text-muted-foreground">
        AIRS records agency-entered capability and compliance facts. It does not create legal authority, transfer authority through mutual aid, or make a credible-threat determination for an operator.
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="Current capability"
          description="Derived only from stored agency participation, active certifications, and usable systems."
          actions={<StatusPill tone={stateTone(summary.capability.state)}>{summary.capability.state.replaceAll("_", " ")}</StatusPill>}
        >
          {dormant ? (
            <p className="mb-4 text-sm text-muted-foreground">
              C-UAS is not currently enabled for this agency. No C-UAS workflow is imposed on incidents.
            </p>
          ) : null}
          <DataRow label="Participation" value={LABELS[summary.profile.participationStatus]} />
          <DataRow label="Detection personnel" value={summary.counts.activeDetectionPersonnel} />
          <DataRow label="Mitigation personnel" value={summary.counts.activeMitigationPersonnel} />
          <DataRow label="Detection systems" value={summary.counts.availableDetectionSystems} />
          <DataRow label="Mitigation systems" value={summary.counts.availableMitigationSystems} />
          <DataRow label="Mutual aid" value={summary.profile.mutualAidAuthorized ? "available" : "not declared"} />
          {summary.capability.reasons.length ? (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {summary.capability.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : null}
        </SectionCard>

        <SectionCard title="Compliance queue" description="Only applies when a C-UAS workflow has actually been activated.">
          <DataRow label="Reports due" value={summary.counts.reportsDue} />
          <DataRow label="Reports overdue" value={summary.counts.reportsOverdue} />
          <DataRow label="Retention actions ≤14 days" value={summary.counts.retentionRecordsDue} />
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Mitigation actions create a 48-hour post-operation report task. Intercepted-communications records default to a 180-day deletion target unless a documented exception applies.
          </p>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard
          title="Agency C-UAS posture"
          description="Administrative declaration only. Selecting Not participating leaves this domain dormant without affecting other AIRS modules."
        >
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={async (event) => {
              event.preventDefault();
              setNotice(null);
              const result = await saveFn({ data: { ...form } });
              if (!result.ok) {
                setNotice(`Save denied: ${result.code}`);
                return;
              }
              await qc.invalidateQueries({ queryKey: ["cuas-readiness"] });
              setNotice("C-UAS posture saved.");
            }}
          >
            <label className="text-xs font-medium text-muted-foreground">
              Participation
              <select
                disabled={!canManage}
                value={form.participationStatus}
                onChange={(e) => setForm({ ...form, participationStatus: e.target.value as CuasParticipationStatus })}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
              <input
                type="checkbox"
                disabled={!canManage}
                checked={form.mutualAidAuthorized}
                onChange={(e) => setForm({ ...form, mutualAidAuthorized: e.target.checked })}
              />
              Mutual-aid C-UAS support may be requested/received under agency arrangements
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Agency Approving Official
              <input disabled={!canManage} value={form.agencyApprovingOfficial} onChange={(e) => setForm({ ...form, agencyApprovingOfficial: e.target.value })} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Counsel reviewer
              <input disabled={!canManage} value={form.counselReviewer} onChange={(e) => setForm({ ...form, counselReviewer: e.target.value })} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Policy adopted
              <input type="date" disabled={!canManage} value={dateInput(form.policyAdoptedAt)} onChange={(e) => setForm({ ...form, policyAdoptedAt: isoOrNull(e.target.value) })} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Annual attestation due
              <input type="date" disabled={!canManage} value={dateInput(form.annualAttestationDueAt)} onChange={(e) => setForm({ ...form, annualAttestationDueAt: isoOrNull(e.target.value) })} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
              Federal portal/reference
              <input disabled={!canManage} value={form.federalPortalReference} onChange={(e) => setForm({ ...form, federalPortalReference: e.target.value })} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
              Notes
              <textarea disabled={!canManage} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" />
            </label>
            <div className="sm:col-span-2 flex items-center gap-3">
              <button disabled={!canManage} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Save posture</button>
              {!canManage ? <span className="text-xs text-muted-foreground">Your role can view but not manage agency C-UAS posture.</span> : null}
              {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
            </div>
          </form>
        </SectionCard>
      </div>
    </PageShell>
  );
}
