import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { PageHeading, SectionCard, StatusPill } from "@/components/brand";
import { DENY_MESSAGES } from "@/components/incident-ui";
import {
  Detail,
  Field,
  FreshnessPill,
  UrgencyPill,
  VerificationPill,
  buttonClass,
  inputClass,
  smallButton,
  timeText,
} from "@/components/awareness-ui";
import {
  addEvidenceReferenceFn,
  addInformationGapFn,
  addObservationAnnotationFn,
  closeInformationGapFn,
  getObservationFn,
  invalidateRelationshipFn,
  listObservationsFn,
  relateObservationsFn,
  removeEvidenceReferenceFn,
  revokeObservationShareFn,
  setObservationLifecycleFn,
  setVerificationStatusFn,
  shareObservationFn,
} from "@/lib/api/awareness.functions";
import { listTrustedAgenciesFn } from "@/lib/api/incidents.functions";
import {
  ANNOTATION_LABELS,
  ANNOTATION_TYPES,
  CLASSIFICATION_LABELS,
  CONFIDENCE_LEVEL_LABELS,
  EVIDENCE_LABELS,
  EVIDENCE_TYPES,
  GAP_LABELS,
  GAP_TYPES,
  INFORMATION_CREDIBILITY_LABELS,
  LIFECYCLE_LABELS,
  OBSERVATION_LOCATION_LABELS,
  OBSERVATION_SOURCE_LABELS,
  OBSERVATION_TYPE_LABELS,
  RELATIONSHIP_LABELS,
  RELATIONSHIP_TYPES,
  SOURCE_RELIABILITY_LABELS,
  TIME_PRECISION_LABELS,
  VERIFICATION_STATUSES,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_TRANSITIONS,
  type VerificationStatus,
} from "@/lib/awareness/model";
import { DISCLOSURE_PROFILE_LABELS, type DisclosureProfile } from "@/lib/resources/disclosure";
import { PRECISION_LABELS, PRECISION_POLICIES, type PrecisionPolicy } from "@/lib/map/model";

export const Route = createFileRoute("/awareness/$observationId")({
  head: () => ({
    meta: [
      { title: "Observation review — AIRS Agent" },
      {
        name: "description",
        content:
          "Review a single manual airspace observation: source assessment, verification history, corroboration, information gaps, evidence references and partner releases.",
      },
      { property: "og:title", content: "Observation review — AIRS Agent" },
      {
        property: "og:description",
        content:
          "A reviewer's view of one human-reported observation, with every conclusion recorded as an explicit act.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: ObservationDetailPage,
});

const SHAREABLE_PROFILES: DisclosureProfile[] = [
  "summary",
  "operational",
  "aviation",
  "incident_command",
  "full",
];

function ObservationDetailPage() {
  const { observationId } = Route.useParams();
  const qc = useQueryClient();

  const getFn = useServerFn(getObservationFn);
  const listFn = useServerFn(listObservationsFn);
  const trustedFn = useServerFn(listTrustedAgenciesFn);
  const verifyFn = useServerFn(setVerificationStatusFn);
  const lifecycleFn = useServerFn(setObservationLifecycleFn);
  const annotateFn = useServerFn(addObservationAnnotationFn);
  const relateFn = useServerFn(relateObservationsFn);
  const unrelateFn = useServerFn(invalidateRelationshipFn);
  const gapFn = useServerFn(addInformationGapFn);
  const closeGapFn = useServerFn(closeInformationGapFn);
  const evidenceFn = useServerFn(addEvidenceReferenceFn);
  const removeEvidenceFn = useServerFn(removeEvidenceReferenceFn);
  const shareFn = useServerFn(shareObservationFn);
  const revokeShareFn = useServerFn(revokeObservationShareFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<VerificationStatus>("under_review");
  const [rationale, setRationale] = useState("");
  const [annotationType, setAnnotationType] = useState<string>("review_note");
  const [annotationBody, setAnnotationBody] = useState("");
  const [annotationVisibility, setAnnotationVisibility] = useState<"internal" | "shared">(
    "internal",
  );
  const [relatedId, setRelatedId] = useState("");
  const [relationship, setRelationship] = useState<string>("corroborates");
  const [gapType, setGapType] = useState<string>("identity_unknown");
  const [gapDetail, setGapDetail] = useState("");
  const [evidenceType, setEvidenceType] = useState<string>("photograph");
  const [evidenceName, setEvidenceName] = useState("");
  const [evidenceValue, setEvidenceValue] = useState("");
  const [partnerOrgId, setPartnerOrgId] = useState("");
  const [shareProfile, setShareProfile] = useState<DisclosureProfile>("summary");
  const [sharePrecision, setSharePrecision] = useState<PrecisionPolicy>("area_only");

  const detail = useQuery({
    queryKey: ["observation", observationId],
    queryFn: () => getFn({ data: { observationId } }),
  });
  const others = useQuery({
    queryKey: ["observations", "link-picker"],
    queryFn: () => listFn({ data: { limit: 100 } }),
  });
  const trusted = useQuery({
    queryKey: ["trusted-agencies"],
    queryFn: () => trustedFn({ data: {} }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["observation", observationId] });
    void qc.invalidateQueries({ queryKey: ["observations"] });
    void qc.invalidateQueries({ queryKey: ["awareness-summary"] });
  };
  const report = (r: { ok: boolean; code?: string }, success: string) => {
    setNotice(r.ok ? success : (DENY_MESSAGES[r.code ?? ""] ?? `Denied (${r.code}).`));
    if (r.ok) refresh();
  };

  const act = <T,>(run: (input: T) => Promise<{ ok: boolean; code?: string }>, success: string) =>
    useMutation({
      mutationFn: (input: T) => run(input),
      onSuccess: (r) => report(r, success),
    });

  const setVerification = act<void>(
    () =>
      verifyFn({
        data: { observationId, status: reviewStatus, rationale: rationale || null },
      }),
    "Verification status recorded.",
  );
  const setLifecycle = useMutation({
    mutationFn: (status: string) => lifecycleFn({ data: { observationId, status } }),
    onSuccess: (r) => report(r, "Lifecycle updated."),
  });
  const addAnnotation = act<void>(
    () =>
      annotateFn({
        data: {
          observationId,
          annotationType,
          body: annotationBody,
          visibility: annotationVisibility,
        },
      }),
    "Annotation added.",
  );
  const addLink = act<void>(
    () => relateFn({ data: { observationId, relatedObservationId: relatedId, relationship } }),
    "Observations linked.",
  );
  const dropLink = useMutation({
    mutationFn: (relationshipId: string) => unrelateFn({ data: { relationshipId } }),
    onSuccess: (r) => report(r, "Link withdrawn."),
  });
  const addGap = act<void>(
    () => gapFn({ data: { observationId, gapType, detail: gapDetail || null } }),
    "Information gap recorded.",
  );
  const resolveGap = useMutation({
    mutationFn: (gapId: string) => closeGapFn({ data: { gapId, status: "resolved" as const } }),
    onSuccess: (r) => report(r, "Gap closed."),
  });
  const addEvidence = act<void>(
    () =>
      evidenceFn({
        data: {
          observationId,
          referenceType: evidenceType,
          displayName: evidenceName,
          referenceValue: evidenceValue || null,
        },
      }),
    "Evidence reference recorded.",
  );
  const dropEvidence = useMutation({
    mutationFn: (evidenceId: string) => removeEvidenceFn({ data: { evidenceId } }),
    onSuccess: (r) => report(r, "Evidence reference removed."),
  });
  const share = act<void>(
    () =>
      shareFn({
        data: {
          observationId,
          partnerOrgId,
          disclosureProfile: shareProfile,
          precisionPolicy: sharePrecision,
        },
      }),
    "Observation released to the partner agency.",
  );
  const revokeShare = useMutation({
    mutationFn: (shareId: string) => revokeShareFn({ data: { shareId } }),
    onSuccess: (r) => report(r, "Release revoked."),
  });

  if (detail.isLoading) {
    return <p className="mx-auto max-w-4xl px-6 py-12 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!detail.data?.ok) {
    const code = detail.data && !detail.data.ok ? detail.data.code : "internal_error";
    return (
      <div className="mx-auto max-w-4xl px-6 py-12">
        <p role="alert" className="text-sm text-destructive">
          {DENY_MESSAGES[code] ?? `Denied (${code}).`}
        </p>
        <Link to="/awareness" className="mt-6 inline-block text-sm underline">
          Back to the awareness board
        </Link>
      </div>
    );
  }

  const d = detail.data.data;
  const o = d.observation;
  const isOwner = o.relationship === "owner";
  const allowedNext = VERIFICATION_TRANSITIONS[o.verificationStatus] ?? [];
  const linkOptions = (others.data?.ok ? others.data.data : []).filter((r) => r.id !== o.id);
  const partners = (trusted.data?.ok ? trusted.data.data : []).filter(
    (t) => t.status === "approved",
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
      <Link to="/awareness" className="text-sm underline">
        Back to the awareness board
      </Link>

      <PageHeading
        eyebrow={`${OBSERVATION_TYPE_LABELS[o.observationType]} · ${o.ownerOrgName}`}
        title={o.title}
        description={o.description || "No narrative was supplied with this report."}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <UrgencyPill value={o.urgency} />
            <VerificationPill value={o.verificationStatus} />
            <FreshnessPill value={o.freshness} />
            <StatusPill tone="neutral">{LIFECYCLE_LABELS[o.lifecycleStatus]}</StatusPill>
          </div>
        }
      />

      {notice ? (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      <SectionCard
        title="Report"
        description="Reliability and credibility describe the source and the information separately. Neither is a verdict: verification is a separate, recorded act."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Detail label="Object observed" value={o.observedObject} />
          <Detail label="Behavior" value={o.observedBehavior} />
          <Detail label="Count" value={o.observedCount} />
          <Detail
            label="Estimated altitude"
            value={o.observedAltitudeFt ? `${o.observedAltitudeFt} ft` : null}
          />
          <Detail
            label="Observed at"
            value={
              o.observedAt
                ? `${timeText(o.observedAt)} (${TIME_PRECISION_LABELS[o.observedTimePrecision]})`
                : null
            }
          />
          <Detail label="Reported at" value={timeText(o.reportedAt)} />
          <Detail label="Source" value={OBSERVATION_SOURCE_LABELS[o.sourceType]} />
          <Detail
            label="Source reliability"
            value={SOURCE_RELIABILITY_LABELS[o.sourceReliability]}
          />
          <Detail
            label="Information credibility"
            value={INFORMATION_CREDIBILITY_LABELS[o.informationCredibility]}
          />
          <Detail label="Reporter confidence" value={CONFIDENCE_LEVEL_LABELS[o.confidenceLevel]} />
          <Detail label="Location basis" value={OBSERVATION_LOCATION_LABELS[o.locationKind]} />
          <Detail
            label="Geography released"
            value={o.geometry ? PRECISION_LABELS[o.precision] : null}
          />
          <Detail
            label="Handling"
            value={o.classification ? CLASSIFICATION_LABELS[o.classification] : null}
          />
          <Detail label="Corroborating links" value={d.corroborationCount} />
          <Detail label="Conflicting links" value={d.conflictCount} />
        </div>

        {isOwner ? (
          <fieldset className="mt-4 rounded-md border border-border px-3 py-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Restricted — your agency only
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Detail label="Source detail" value={o.sourceDetail} />
              <Detail label="Internal case number" value={o.internalCaseNumber} />
              <Detail label="Reporter identity" value={o.reporterIdentity} />
              <Detail label="Reporter contact" value={o.reporterContact} />
              <Detail label="Internal notes" value={o.internalNotes} />
            </div>
          </fieldset>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            This report was released to your agency by {o.ownerOrgName}. Source handling details and
            reporter information stay with the reporting agency.
          </p>
        )}
      </SectionCard>

      {isOwner ? (
        <SectionCard
          title="Verification review"
          description="Only transitions the model permits are offered. Every change is written to the audit log with the reviewer's rationale."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="New status">
              <select
                className={inputClass}
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value as VerificationStatus)}
              >
                {VERIFICATION_STATUSES.filter((s) => allowedNext.includes(s)).map((s) => (
                  <option key={s} value={s}>
                    {VERIFICATION_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Rationale">
                <input
                  className={inputClass}
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={setVerification.isPending || allowedNext.length === 0}
              onClick={() => setVerification.mutate()}
            >
              Record verification status
            </button>
            <button className={smallButton} onClick={() => setLifecycle.mutate("resolved")}>
              Mark resolved
            </button>
            <button className={smallButton} onClick={() => setLifecycle.mutate("closed")}>
              Close observation
            </button>
            <button className={smallButton} onClick={() => setLifecycle.mutate("active")}>
              Reopen
            </button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Annotations"
        description="Notes, corrections and reviewer assessments. Internal notes are never included in a partner release."
      >
        <ul className="mb-3 flex flex-col gap-2">
          {d.annotations.length === 0 ? (
            <li className="text-sm text-muted-foreground">No annotations recorded.</li>
          ) : null}
          {d.annotations.map((a) => (
            <li key={a.id} className="rounded-md border border-border px-3 py-2 text-sm">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {ANNOTATION_LABELS[a.annotationType]} · {a.visibility} · {timeText(a.createdAt)}
                {a.authorName ? ` · ${a.authorName}` : ""}
              </span>
              <p className="mt-1 text-foreground">{a.body}</p>
            </li>
          ))}
        </ul>
        {isOwner ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Type">
              <select
                className={inputClass}
                value={annotationType}
                onChange={(e) => setAnnotationType(e.target.value)}
              >
                {ANNOTATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ANNOTATION_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Visibility">
              <select
                className={inputClass}
                value={annotationVisibility}
                onChange={(e) => setAnnotationVisibility(e.target.value as "internal" | "shared")}
              >
                <option value="internal">Internal to my agency</option>
                <option value="shared">Shared with released partners</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Note">
                <input
                  className={inputClass}
                  value={annotationBody}
                  onChange={(e) => setAnnotationBody(e.target.value)}
                />
              </Field>
            </div>
            <div>
              <button
                className={buttonClass}
                disabled={!annotationBody || addAnnotation.isPending}
                onClick={() => addAnnotation.mutate()}
              >
                Add annotation
              </button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Related observations"
        description="Corroboration and contradiction are shown for a reviewer to weigh. No status is ever changed automatically by a link."
      >
        <ul className="mb-3 flex flex-col gap-2">
          {d.relationships.length === 0 ? (
            <li className="text-sm text-muted-foreground">No links recorded.</li>
          ) : null}
          {d.relationships.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>
                {RELATIONSHIP_LABELS[r.relationship as keyof typeof RELATIONSHIP_LABELS] ??
                  r.relationship}{" "}
                <Link
                  to="/awareness/$observationId"
                  params={{ observationId: r.relatedObservationId }}
                  className="underline"
                >
                  {r.relatedTitle ?? "linked observation"}
                </Link>
                {r.invalidatedAt ? " (withdrawn)" : ""}
              </span>
              {isOwner && !r.invalidatedAt ? (
                <button className={smallButton} onClick={() => dropLink.mutate(r.id)}>
                  Withdraw link
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Relationship">
              <select
                className={inputClass}
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
              >
                {RELATIONSHIP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {RELATIONSHIP_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Observation">
              <select
                className={inputClass}
                value={relatedId}
                onChange={(e) => setRelatedId(e.target.value)}
              >
                <option value="">Select an observation</option>
                {linkOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button
                className={buttonClass}
                disabled={!relatedId}
                onClick={() => addLink.mutate()}
              >
                Link observations
              </button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Information gaps"
        description="What is still unknown is stated explicitly, so an incomplete report is never read as a complete one."
      >
        <ul className="mb-3 flex flex-col gap-2">
          {d.gaps.length === 0 ? (
            <li className="text-sm text-muted-foreground">No gaps recorded.</li>
          ) : null}
          {d.gaps.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>
                <strong>{GAP_LABELS[g.gapType as keyof typeof GAP_LABELS] ?? g.gapType}</strong>
                {g.detail ? ` — ${g.detail}` : ""}{" "}
                <StatusPill tone={g.status === "open" ? "caution" : "neutral"}>
                  {g.status}
                </StatusPill>
              </span>
              {isOwner && g.status === "open" ? (
                <button className={smallButton} onClick={() => resolveGap.mutate(g.id)}>
                  Close gap
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Gap">
              <select
                className={inputClass}
                value={gapType}
                onChange={(e) => setGapType(e.target.value)}
              >
                {GAP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {GAP_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Detail">
              <input
                className={inputClass}
                value={gapDetail}
                onChange={(e) => setGapDetail(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button className={buttonClass} onClick={() => addGap.mutate()}>
                Record gap
              </button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Evidence references"
        description="References only. AIRS Agent points at the system of record; it never stores the media itself."
      >
        <ul className="mb-3 flex flex-col gap-2">
          {d.evidence.length === 0 ? (
            <li className="text-sm text-muted-foreground">No evidence referenced.</li>
          ) : null}
          {d.evidence.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>
                {EVIDENCE_LABELS[e.referenceType as keyof typeof EVIDENCE_LABELS] ??
                  e.referenceType}{" "}
                · {e.displayName}
                {e.referenceValue ? ` · ${e.referenceValue}` : ""}
              </span>
              {isOwner ? (
                <button className={smallButton} onClick={() => dropEvidence.mutate(e.id)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Type">
              <select
                className={inputClass}
                value={evidenceType}
                onChange={(e) => setEvidenceType(e.target.value)}
              >
                {EVIDENCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVIDENCE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Display name">
              <input
                className={inputClass}
                value={evidenceName}
                onChange={(e) => setEvidenceName(e.target.value)}
              />
            </Field>
            <Field label="Reference in system of record">
              <input
                className={inputClass}
                value={evidenceValue}
                onChange={(e) => setEvidenceValue(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button
                className={buttonClass}
                disabled={!evidenceName}
                onClick={() => addEvidence.mutate()}
              >
                Add reference
              </button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {isOwner ? (
        <SectionCard
          title="Partner releases"
          description="Releasing an observation never releases the restricted plane. You choose how much of the record and how much geography a partner receives, and you can end it at any time."
        >
          <ul className="mb-3 flex flex-col gap-2">
            {d.shares.length === 0 ? (
              <li className="text-sm text-muted-foreground">Not released to any partner.</li>
            ) : null}
            {d.shares.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>
                  {s.partnerOrgName} ·{" "}
                  {DISCLOSURE_PROFILE_LABELS[s.disclosureProfile as DisclosureProfile] ??
                    s.disclosureProfile}{" "}
                  · {PRECISION_LABELS[s.precisionPolicy as PrecisionPolicy] ?? s.precisionPolicy} ·{" "}
                  <StatusPill tone={s.status === "active" ? "active" : "neutral"}>
                    {s.status}
                  </StatusPill>
                </span>
                {s.status === "active" ? (
                  <button className={smallButton} onClick={() => revokeShare.mutate(s.id)}>
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Partner agency">
              <select
                className={inputClass}
                value={partnerOrgId}
                onChange={(e) => setPartnerOrgId(e.target.value)}
              >
                <option value="">Select an approved partner</option>
                {partners.map((p) => (
                  <option key={p.partnerOrgId} value={p.partnerOrgId}>
                    {p.partnerOrgName ?? p.partnerOrgId}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Disclosure profile">
              <select
                className={inputClass}
                value={shareProfile}
                onChange={(e) => setShareProfile(e.target.value as DisclosureProfile)}
              >
                {SHAREABLE_PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {DISCLOSURE_PROFILE_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Geographic precision">
              <select
                className={inputClass}
                value={sharePrecision}
                onChange={(e) => setSharePrecision(e.target.value as PrecisionPolicy)}
              >
                {PRECISION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {PRECISION_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button
                className={buttonClass}
                disabled={!partnerOrgId}
                onClick={() => share.mutate()}
              >
                Release to partner
              </button>
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
