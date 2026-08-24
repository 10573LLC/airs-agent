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
  timeText,
} from "@/components/awareness-ui";
import {
  awarenessSummaryFn,
  createObservationFn,
  listObservationsFn,
} from "@/lib/api/awareness.functions";
import { listIncidentsFn } from "@/lib/api/incidents.functions";
import {
  CLASSIFICATION_LABELS,
  CONFIDENCE_LEVELS,
  CONFIDENCE_LEVEL_LABELS,
  INFORMATION_CREDIBILITY,
  INFORMATION_CREDIBILITY_LABELS,
  LIFECYCLE_LABELS,
  LIFECYCLE_STATUSES,
  OBSERVATION_CLASSIFICATIONS,
  OBSERVATION_LOCATION_KINDS,
  OBSERVATION_LOCATION_LABELS,
  OBSERVATION_SOURCES,
  OBSERVATION_SOURCE_LABELS,
  OBSERVATION_TYPES,
  OBSERVATION_TYPE_LABELS,
  SOURCE_RELIABILITY,
  SOURCE_RELIABILITY_LABELS,
  TIME_PRECISIONS,
  TIME_PRECISION_LABELS,
  URGENCY_LABELS,
  URGENCY_LEVELS,
  VERIFICATION_STATUSES,
  VERIFICATION_STATUS_LABELS,
} from "@/lib/awareness/model";
import {
  awarenessBoardState,
  type AwarenessBoardFailure,
} from "@/lib/awareness/recovery";
import { PRECISION_LABELS, PRECISION_POLICIES } from "@/lib/map/model";

export const Route = createFileRoute("/awareness/")({
  head: () => ({
    meta: [
      { title: "Awareness board — AIRS Agent" },
      {
        name: "description",
        content:
          "Human-reported airspace observations with source reliability, information credibility, verification review, freshness ageing and owner-controlled release to partner agencies.",
      },
      { property: "og:title", content: "Awareness board — AIRS Agent" },
      {
        property: "og:description",
        content:
          "Manually entered airspace observations, reviewed and released under the reporting agency's own disclosure and precision rules.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  ssr: false,
  component: AwarenessBoard,
});

const emptyForm = {
  incidentId: "",
  observationType: "unmanned_aircraft" as string,
  title: "",
  description: "",
  observedObject: "",
  observedBehavior: "",
  observedCount: "",
  observedAltitudeFt: "",
  observedAt: "",
  observedTimePrecision: "estimated" as string,
  locationKind: "unknown" as string,
  sourceType: "officer_report" as string,
  sourceDetail: "",
  reporterIdentity: "",
  reporterContact: "",
  internalNotes: "",
  internalCaseNumber: "",
  sourceReliability: "not_assessed" as string,
  informationCredibility: "not_assessed" as string,
  confidenceLevel: "unknown" as string,
  urgency: "routine" as string,
  classification: "law_enforcement_sensitive" as string,
  precisionPolicy: "generalized" as string,
  lat: "",
  lng: "",
};

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function AwarenessBoard() {
  const qc = useQueryClient();
  const listFn = useServerFn(listObservationsFn);
  const summaryFn = useServerFn(awarenessSummaryFn);
  const incidentsFn = useServerFn(listIncidentsFn);
  const createFn = useServerFn(createObservationFn);

  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    incidentId: "",
    observationType: "",
    verificationStatus: "",
    lifecycleStatus: "",
    urgency: "",
    sourceType: "",
    includeTerminal: false,
  });
  const [form, setForm] = useState(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [retryFailure, setRetryFailure] = useState<AwarenessBoardFailure | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const incidents = useQuery({
    queryKey: ["incidents"],
    queryFn: () => incidentsFn({ data: {} }),
  });
  const summary = useQuery({
    queryKey: ["awareness-summary", filters.incidentId],
    queryFn: () => summaryFn({ data: { incidentId: filters.incidentId || null } }),
  });
  const observations = useQuery({
    queryKey: ["observations", filters],
    queryFn: () =>
      listFn({
        data: {
          incidentId: filters.incidentId || null,
          observationType: filters.observationType || null,
          verificationStatus: filters.verificationStatus || null,
          lifecycleStatus: filters.lifecycleStatus || null,
          urgency: filters.urgency || null,
          sourceType: filters.sourceType || null,
          includeTerminal: filters.includeTerminal,
        },
      }),
  });

  const create = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          incidentId: form.incidentId || null,
          observationType: form.observationType,
          title: form.title,
          description: form.description || null,
          observedObject: form.observedObject || null,
          observedBehavior: form.observedBehavior || null,
          observedCount: form.observedCount ? Number(form.observedCount) : null,
          observedAltitudeFt: form.observedAltitudeFt ? Number(form.observedAltitudeFt) : null,
          observedAt: form.observedAt ? new Date(form.observedAt).toISOString() : null,
          observedTimePrecision: form.observedTimePrecision,
          locationKind: form.locationKind,
          geometry:
            form.lat && form.lng
              ? {
                  type: "Point" as const,
                  coordinates: [Number(form.lng), Number(form.lat)] as [number, number],
                }
              : null,
          precisionPolicy: form.precisionPolicy,
          sourceType: form.sourceType,
          sourceDetail: form.sourceDetail || null,
          reporterIdentity: form.reporterIdentity || null,
          reporterContact: form.reporterContact || null,
          internalNotes: form.internalNotes || null,
          internalCaseNumber: form.internalCaseNumber || null,
          sourceReliability: form.sourceReliability,
          informationCredibility: form.informationCredibility,
          confidenceLevel: form.confidenceLevel,
          urgency: form.urgency,
          classification: form.classification,
        },
      }),
    onSuccess: (r) => {
      if (r.ok) {
        setNotice("Observation filed. It starts unverified until a reviewer acts on it.");
        setForm(emptyForm);
        setFormOpen(false);
        void qc.invalidateQueries({ queryKey: ["observations"] });
        void qc.invalidateQueries({ queryKey: ["awareness-summary"] });
      } else {
        setNotice(DENY_MESSAGES[r.code] ?? `Denied (${r.code}).`);
      }
    },
  });

  const boardState = awarenessBoardState({
    data: observations.data,
    isError: observations.isError,
  });
  const displayedBoardState = retryFailure ?? boardState;
  const rows = displayedBoardState.status === "success" ? displayedBoardState.rows : [];
  const stats = summary.data?.ok ? summary.data.data : null;
  const incidentRows = incidents.data?.ok ? incidents.data.data : [];
  const boardFailureMessage =
    displayedBoardState.status === "failed"
      ? displayedBoardState.kind === "api"
        ? (DENY_MESSAGES[displayedBoardState.code] ?? `Denied (${displayedBoardState.code}).`)
        : "The Awareness Board could not be loaded. Please try again."
      : null;
  const isRetrying = retryFailure !== null;

  const retryObservations = async () => {
    if (boardState.status !== "failed" || retryFailure) return;

    setRetryFailure(boardState);
    try {
      await observations.refetch();
    } finally {
      setRetryFailure(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
      <PageHeading
        eyebrow="Awareness"
        title="Manual airspace observations"
        description="Every entry here is a human report, not a sensor track. Reliability, credibility and freshness are stated explicitly so a reader can weigh the report instead of assuming it is fact."
        actions={
          <button className={buttonClass} onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Close report form" : "File an observation"}
          </button>
        }
      />

      {notice ? (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      {stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Observations" value={stats.total} />
          <Tile label="Awaiting review" value={stats.awaitingReview} />
          <Tile label="Open information gaps" value={stats.openGaps} />
          <Tile label="Released to partners" value={stats.sharedOut} />
        </div>
      ) : null}

      {formOpen ? (
        <SectionCard
          title="File an observation"
          description="Only what was actually seen. Reporter identity, contact and internal notes stay with your agency and are never included in a partner release."
        >
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Incident room (optional)">
              <select
                className={inputClass}
                value={form.incidentId}
                onChange={(e) => set("incidentId", e.target.value)}
              >
                <option value="">Not tied to a room</option>
                {incidentRows.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Observation type">
              <select
                className={inputClass}
                value={form.observationType}
                onChange={(e) => set("observationType", e.target.value)}
              >
                {OBSERVATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {OBSERVATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Urgency">
              <select
                className={inputClass}
                value={form.urgency}
                onChange={(e) => set("urgency", e.target.value)}
              >
                {URGENCY_LEVELS.map((u) => (
                  <option key={u} value={u}>
                    {URGENCY_LABELS[u]}
                  </option>
                ))}
              </select>
            </Field>

            <div className="sm:col-span-3">
              <Field label="Title">
                <input
                  className={inputClass}
                  required
                  maxLength={160}
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                />
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label="What was observed">
                <textarea
                  className={inputClass}
                  rows={3}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </Field>
            </div>

            <Field label="Object observed">
              <input
                className={inputClass}
                value={form.observedObject}
                onChange={(e) => set("observedObject", e.target.value)}
              />
            </Field>
            <Field label="Observed behavior">
              <input
                className={inputClass}
                value={form.observedBehavior}
                onChange={(e) => set("observedBehavior", e.target.value)}
              />
            </Field>
            <Field label="Count">
              <input
                className={inputClass}
                type="number"
                min={0}
                value={form.observedCount}
                onChange={(e) => set("observedCount", e.target.value)}
              />
            </Field>

            <Field label="Estimated altitude (ft AGL)">
              <input
                className={inputClass}
                type="number"
                value={form.observedAltitudeFt}
                onChange={(e) => set("observedAltitudeFt", e.target.value)}
              />
            </Field>
            <Field label="Observed at">
              <input
                className={inputClass}
                type="datetime-local"
                value={form.observedAt}
                onChange={(e) => set("observedAt", e.target.value)}
              />
            </Field>
            <Field label="Time precision">
              <select
                className={inputClass}
                value={form.observedTimePrecision}
                onChange={(e) => set("observedTimePrecision", e.target.value)}
              >
                {TIME_PRECISIONS.map((t) => (
                  <option key={t} value={t}>
                    {TIME_PRECISION_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Location basis">
              <select
                className={inputClass}
                value={form.locationKind}
                onChange={(e) => set("locationKind", e.target.value)}
              >
                {OBSERVATION_LOCATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {OBSERVATION_LOCATION_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Latitude">
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.lat}
                onChange={(e) => set("lat", e.target.value)}
              />
            </Field>
            <Field label="Longitude">
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.lng}
                onChange={(e) => set("lng", e.target.value)}
              />
            </Field>

            <Field label="Released precision">
              <select
                className={inputClass}
                value={form.precisionPolicy}
                onChange={(e) => set("precisionPolicy", e.target.value)}
              >
                {PRECISION_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {PRECISION_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Source">
              <select
                className={inputClass}
                value={form.sourceType}
                onChange={(e) => set("sourceType", e.target.value)}
              >
                {OBSERVATION_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {OBSERVATION_SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Handling classification">
              <select
                className={inputClass}
                value={form.classification}
                onChange={(e) => set("classification", e.target.value)}
              >
                {OBSERVATION_CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>
                    {CLASSIFICATION_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Source reliability">
              <select
                className={inputClass}
                value={form.sourceReliability}
                onChange={(e) => set("sourceReliability", e.target.value)}
              >
                {SOURCE_RELIABILITY.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_RELIABILITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Information credibility">
              <select
                className={inputClass}
                value={form.informationCredibility}
                onChange={(e) => set("informationCredibility", e.target.value)}
              >
                {INFORMATION_CREDIBILITY.map((c) => (
                  <option key={c} value={c}>
                    {INFORMATION_CREDIBILITY_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reporter confidence">
              <select
                className={inputClass}
                value={form.confidenceLevel}
                onChange={(e) => set("confidenceLevel", e.target.value)}
              >
                {CONFIDENCE_LEVELS.map((c) => (
                  <option key={c} value={c}>
                    {CONFIDENCE_LEVEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>

            <fieldset className="sm:col-span-3 rounded-md border border-border px-3 py-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Restricted — your agency only
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Source detail">
                  <input
                    className={inputClass}
                    value={form.sourceDetail}
                    onChange={(e) => set("sourceDetail", e.target.value)}
                  />
                </Field>
                <Field label="Internal case number">
                  <input
                    className={inputClass}
                    value={form.internalCaseNumber}
                    onChange={(e) => set("internalCaseNumber", e.target.value)}
                  />
                </Field>
                <Field label="Reporter identity">
                  <input
                    className={inputClass}
                    value={form.reporterIdentity}
                    onChange={(e) => set("reporterIdentity", e.target.value)}
                  />
                </Field>
                <Field label="Reporter contact">
                  <input
                    className={inputClass}
                    value={form.reporterContact}
                    onChange={(e) => set("reporterContact", e.target.value)}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Internal notes">
                    <textarea
                      className={inputClass}
                      rows={2}
                      value={form.internalNotes}
                      onChange={(e) => set("internalNotes", e.target.value)}
                    />
                  </Field>
                </div>
              </div>
            </fieldset>

            <div className="sm:col-span-3">
              <button className={buttonClass} disabled={create.isPending || !form.title}>
                {create.isPending ? "Filing…" : "File observation"}
              </button>
            </div>
          </form>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Observation board"
        description="Reports age visibly. A stale or expired report is still shown, marked as such, rather than quietly dropped."
      >
        <fieldset className="mb-4 grid gap-3 sm:grid-cols-3">
          <legend className="sr-only">Filter observations</legend>
          <Field label="Incident room">
            <select
              className={inputClass}
              value={filters.incidentId}
              onChange={(e) => setFilters((f) => ({ ...f, incidentId: e.target.value }))}
            >
              <option value="">All rooms</option>
              {incidentRows.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              className={inputClass}
              value={filters.observationType}
              onChange={(e) => setFilters((f) => ({ ...f, observationType: e.target.value }))}
            >
              <option value="">All types</option>
              {OBSERVATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {OBSERVATION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Verification">
            <select
              className={inputClass}
              value={filters.verificationStatus}
              onChange={(e) => setFilters((f) => ({ ...f, verificationStatus: e.target.value }))}
            >
              <option value="">Any status</option>
              {VERIFICATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {VERIFICATION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Urgency">
            <select
              className={inputClass}
              value={filters.urgency}
              onChange={(e) => setFilters((f) => ({ ...f, urgency: e.target.value }))}
            >
              <option value="">Any urgency</option>
              {URGENCY_LEVELS.map((u) => (
                <option key={u} value={u}>
                  {URGENCY_LABELS[u]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lifecycle">
            <select
              className={inputClass}
              value={filters.lifecycleStatus}
              onChange={(e) => setFilters((f) => ({ ...f, lifecycleStatus: e.target.value }))}
            >
              <option value="">Any lifecycle</option>
              {LIFECYCLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LIFECYCLE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-end gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={filters.includeTerminal}
              onChange={(e) => setFilters((f) => ({ ...f, includeTerminal: e.target.checked }))}
            />
            Include closed and expired reports
          </label>
        </fieldset>

        {displayedBoardState.status === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading observations…
          </p>
        ) : null}

        {displayedBoardState.status === "failed" ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
          >
            <p className="text-sm font-semibold text-destructive">Unable to load observations</p>
            <p className="mt-1 text-sm text-foreground">{boardFailureMessage}</p>
            <button
              type="button"
              className={`${buttonClass} mt-3`}
              disabled={isRetrying}
              onClick={() => void retryObservations()}
            >
              {isRetrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : null}

        {displayedBoardState.status === "empty" ? (
          <p className="text-sm text-muted-foreground">No observations match these filters.</p>
        ) : null}

        {displayedBoardState.status === "success" ? (
          <ul className="flex flex-col gap-3">
            {rows.map((o) => (
              <li key={o.id} className="rounded-md border border-border px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      to="/awareness/$observationId"
                      params={{ observationId: o.id }}
                      className="text-sm font-semibold text-foreground underline"
                    >
                      {o.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {OBSERVATION_TYPE_LABELS[o.observationType]} ·{" "}
                      {OBSERVATION_SOURCE_LABELS[o.sourceType]} · {o.ownerOrgName}
                      {o.relationship === "partner" ? " (released to you)" : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <UrgencyPill value={o.urgency} />
                    <VerificationPill value={o.verificationStatus} />
                    <FreshnessPill value={o.freshness} />
                    <StatusPill tone="neutral">{LIFECYCLE_LABELS[o.lifecycleStatus]}</StatusPill>
                  </div>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <Detail label="Observed" value={timeText(o.observedAt)} />
                  <Detail
                    label="Reliability / credibility"
                    value={`${SOURCE_RELIABILITY_LABELS[o.sourceReliability]} · ${INFORMATION_CREDIBILITY_LABELS[o.informationCredibility]}`}
                  />
                  <Detail
                    label="Location basis"
                    value={OBSERVATION_LOCATION_LABELS[o.locationKind]}
                  />
                  <Detail
                    label="Geography"
                    value={o.geometry ? PRECISION_LABELS[o.precision] : null}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>
    </div>
  );
}
