import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { readFrameworkFn, writeFrameworkFn } from "@/lib/api/framework.functions";
import {
  ACCESS_METHODS,
  ENTITY_TYPES,
  INFORMATION_STATES,
  followUpQuestions,
  projectObservations,
  type Source,
} from "@/lib/operations/framework";
import type { FrameworkCommand } from "@/lib/operations/framework.server";

const inputClass = "mt-1 block w-full rounded border bg-background p-2 text-sm";
const buttonClass = "rounded border px-3 py-2 text-sm font-semibold disabled:opacity-50";
const list = (v: FormData, key: string) =>
  String(v.get(key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const val = (v: FormData, key: string) => String(v.get(key) ?? "");
function Field({
  name,
  label,
  value = "",
  required = false,
  type = "text",
}: {
  name: string;
  label: string;
  value?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      {label}
      <input
        className={inputClass}
        name={name}
        defaultValue={value}
        required={required}
        type={type}
        maxLength={2000}
      />
    </label>
  );
}
function Select({
  name,
  label,
  values,
  value,
}: {
  name: string;
  label: string;
  values: readonly string[];
  value?: string;
}) {
  return (
    <label className="block text-sm">
      {label}
      <select className={inputClass} name={name} defaultValue={value}>
        {values.map((v) => (
          <option key={v} value={v}>
            {v.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
export function FrameworkPanel({ incidentId, orgId }: { incidentId?: string; orgId: string }) {
  const read = useServerFn(readFrameworkFn),
    write = useServerFn(writeFrameworkFn),
    qc = useQueryClient();
  const query = useQuery({
    queryKey: ["framework", orgId, incidentId ?? "profile"],
    queryFn: () => read({ data: { incidentId } }),
    refetchInterval: incidentId ? 5000 : false,
  });
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Source | null>(null);
  const [vendor, setVendor] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const mutation = useMutation({
    mutationFn: (command: FrameworkCommand) => write({ data: command }),
    onSuccess: (r) => {
      setMessage(
        r.ok
          ? "Saved. Authorization changes apply to subsequent reads."
          : `Could not save: ${r.code}`,
      );
      if (r.ok) {
        void qc.invalidateQueries({ queryKey: ["framework"] });
        setSelected([]);
      }
    },
    onError: () => setMessage("Could not save. Check the connection and try again."),
  });
  function submit(event: FormEvent<HTMLFormElement>, build: (data: FormData) => FrameworkCommand) {
    event.preventDefault();
    try {
      mutation.mutate(build(new FormData(event.currentTarget)));
    } catch {
      setMessage("Check required fields, dates, and coordinates.");
    }
  }
  if (query.isPending) return <p role="status">Loading entity and source permissions…</p>;
  if (!query.data?.ok)
    return (
      <p role="alert">
        Entity and source information unavailable. {query.data?.code ?? "Connection error"}
      </p>
    );
  const data = query.data.data;
  const disabled = mutation.isPending;
  const sourceSelect = (
    <label className="block text-sm">
      Source system
      <select className={inputClass} name="sourceId" required>
        <option value="">Select a source</option>
        {data.sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.vendor} · {s.systemType} · {s.ingestionAuthorization}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="space-y-5 rounded border p-4">
      <h2 className="text-lg font-semibold">
        {incidentId
          ? "Incident sharing and source observations"
          : "Entity onboarding and source readiness"}
      </h2>
      <p className="text-sm">
        AIRS represents authorized information in one Common Operating Picture. Source entities
        retain ownership. Source readiness, sharing permission, and supplemental application access
        are separate.
      </p>
      {message && (
        <p role="status" className="rounded border p-2">
          {message}
        </p>
      )}
      <details>
        <summary className="cursor-pointer font-semibold">
          Entity Directory — AIRS entity IDs
        </summary>
        <p className="text-sm">
          Use these IDs for incident invitations and sharing. Directory presence grants no
          operational access. Public contacts for entities without AIRS accounts are listed below
          the onboarding workspace.
        </p>
        <ul className="max-h-48 overflow-auto text-sm">
          {data.directory.map((e) => (
            <li key={e.id}>
              {e.name} · {e.entity_type} · <code>{e.id}</code>
            </li>
          ))}
        </ul>
      </details>
      {!incidentId && (
        <>
          {data.canManage && (
            <details open={!data.profile}>
              <summary className="cursor-pointer font-semibold">1. Entity profile</summary>
              <form
                key={JSON.stringify(data.profile)}
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "profile",
                    value: {
                      formalName: val(f, "formalName"),
                      entityType: val(f, "entityType"),
                      jurisdiction: val(f, "jurisdiction"),
                      administrators: val(f, "administrators"),
                      operationalContact: val(f, "operationalContact"),
                      emergencyContact: val(f, "emergencyContact"),
                      technicalContact: val(f, "technicalContact"),
                      identityProvider: val(f, "identityProvider"),
                      capabilities: list(f, "capabilities"),
                    },
                  }))
                }
              >
                {(
                  [
                    ["formalName", "Formal entity name"],
                    ["entityType", "Entity type"],
                    ["jurisdiction", "Service / jurisdiction area"],
                    ["administrators", "AIRS administrators"],
                    ["operationalContact", "Operational contact"],
                    ["emergencyContact", "24-hour contact, where applicable"],
                    ["technicalContact", "Technical contact"],
                    ["identityProvider", "Identity / SSO provider, if used"],
                  ] as const
                ).map(([name, label]) => (
                  <Field
                    key={name}
                    name={name}
                    label={label}
                    value={data.profile?.[name] ?? ""}
                    required={!["emergencyContact", "identityProvider"].includes(name)}
                  />
                ))}
                <Field
                  name="capabilities"
                  label="Capabilities (comma separated): drone program, RTCC, AVL, LPR, cameras…"
                  value={data.profile?.capabilities.join(", ")}
                />
                <button disabled={disabled} className={buttonClass}>
                  Save profile and continue
                </button>
              </form>
            </details>
          )}
          <div>
            <h3 className="font-semibold">2. Source systems</h3>
            <p className="text-sm">
              A configured source shares nothing until incident authorization is activated. Listed
              vendors describe acquisition requirements; they do not certify a working connector.
            </p>
            <ul className="mt-2 space-y-2">
              {data.sources.map((s) => (
                <li className="rounded border p-3 text-sm" key={s.id}>
                  <strong>
                    {s.vendor} · {s.systemType}
                  </strong>
                  <p>
                    {s.ingestionAuthorization.replaceAll("_", " ")} · {s.health} ·{" "}
                    {s.method.replaceAll("_", " ")}
                  </p>
                  <p>
                    Classes: {s.dataClasses.join(", ") || "Not provided"} · Fallback:{" "}
                    {s.fallback || "Not provided"}
                  </p>
                  {data.canManage && (
                    <button
                      className="underline"
                      onClick={() => {
                        setEditing(s);
                        setVendor(s.vendor);
                      }}
                    >
                      Edit source and authorization
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!data.sources.length && (
              <p className="text-sm">
                No sources identified. Human reporting remains available during incidents.
              </p>
            )}
          </div>
          {data.canManage && (
            <details open={!!editing}>
              <summary className="cursor-pointer font-semibold">
                {editing ? "Update source" : "Add a source"}
              </summary>
              <form
                key={editing?.id ?? "new"}
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "source",
                    value: {
                      id: editing?.id,
                      vendor: val(f, "vendor"),
                      systemType: val(f, "systemType"),
                      controllingEntity: val(f, "controllingEntity"),
                      dataClasses: list(f, "dataClasses"),
                      method: val(f, "method") as Source["method"],
                      ingestionAuthorization: val(
                        f,
                        "ingestionAuthorization",
                      ) as Source["ingestionAuthorization"],
                      technicalContact: val(f, "technicalContact"),
                      limitations: val(f, "limitations"),
                      restrictions: val(f, "restrictions"),
                      fallback: val(f, "fallback"),
                      answers: Object.fromEntries(
                        followUpQuestions(vendor).map((question, i) => [
                          question,
                          val(f, `answer${i}`),
                        ]),
                      ),
                    },
                  }))
                }
              >
                <label className="block text-sm">
                  Platform / vendor
                  <input
                    name="vendor"
                    required
                    className={inputClass}
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    list="source-vendors"
                  />
                  <datalist id="source-vendors">
                    {["Motorola", "Fusus", "DroneSense", "ArcGIS", "Dedrone", "Skydio"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </datalist>
                </label>
                <Field name="systemType" label="System type" value={editing?.systemType} required />
                <Field
                  name="controllingEntity"
                  label="Who controls this source?"
                  value={editing?.controllingEntity}
                  required
                />
                <Select
                  name="ingestionAuthorization"
                  label="May AIRS ingest authorized operational information?"
                  values={["not_now", "authorized", "denied"]}
                  value={editing?.ingestionAuthorization}
                />
                <Select
                  name="method"
                  label="Acquisition method"
                  values={ACCESS_METHODS}
                  value={editing?.method}
                />
                <Field
                  name="dataClasses"
                  label="Available information classes (comma separated)"
                  value={editing?.dataClasses.join(", ")}
                />
                <Field
                  name="technicalContact"
                  label="Technical contact"
                  value={editing?.technicalContact}
                />
                <Field name="limitations" label="Known limitations" value={editing?.limitations} />
                <Field
                  name="restrictions"
                  label="Source sharing restrictions"
                  value={editing?.restrictions}
                />
                <Field name="fallback" label="Fallback reporting path" value={editing?.fallback} />
                {followUpQuestions(vendor).map((question, i) => (
                  <Field
                    key={question}
                    name={`answer${i}`}
                    label={question}
                    value={editing?.answers[question]}
                  />
                ))}
                <p className="text-sm md:col-span-2">
                  This authorizes AIRS ingestion only. Other entities do not receive permission to
                  browse the source platform. Do not enter passwords or session cookies.
                </p>
                <button disabled={disabled} className={buttonClass}>
                  Save source
                </button>
                {editing && (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      setEditing(null);
                      setVendor("");
                    }}
                  >
                    Add another source
                  </button>
                )}
              </form>
            </details>
          )}
          {data.canManage && editing && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Record connection readiness for {editing.vendor}
              </summary>
              <p className="text-sm">
                Record a configuration or verification result from the controlling entity. This
                records a receipt; it does not run a vendor connector.
              </p>
              <form
                className="space-y-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "readiness",
                    value: {
                      id: editing.id,
                      health: val(f, "health") as
                        | "identified"
                        | "configured"
                        | "verified"
                        | "unavailable",
                      receipt: val(f, "receipt"),
                    },
                  }))
                }
              >
                <Select
                  name="health"
                  label="Readiness state"
                  values={["identified", "configured", "verified", "unavailable"]}
                  value={editing.health}
                />
                <Field
                  name="receipt"
                  label="Verification result, configuration reference, or outage detail"
                  required
                />
                <button className={buttonClass} disabled={disabled}>
                  Record readiness
                </button>
              </form>
            </details>
          )}
          <div>
            <h3 className="font-semibold">3. Standing Partners</h3>
            <p className="text-sm">
              A Partner envelope is directional. Reciprocal sharing requires an envelope from each
              entity. Associates choose temporary sharing within an incident; Participants can
              contribute through human reporting without source ingestion.
            </p>
            {data.envelopes.map((e) => (
              <p className="mt-2 text-sm" key={e.id}>
                {e.policy.recipientOrgId} · {e.policy.dataClasses.join(", ")} ·{" "}
                {e.revokedAt ? "Revoked" : `Until ${e.policy.expiresAt}`}{" "}
                {data.canManage && e.orgId === data.orgId && !e.revokedAt && (
                  <button
                    className="underline"
                    onClick={() =>
                      mutation.mutate({ action: "revoke", value: { id: e.id, kind: "envelope" } })
                    }
                  >
                    Revoke
                  </button>
                )}
              </p>
            ))}
          </div>
          {data.canManage && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Create Partner sharing envelope
              </summary>
              <form
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "envelope",
                    value: {
                      recipientOrgId: val(f, "recipientOrgId"),
                      sourceId: val(f, "sourceId"),
                      dataClasses: list(f, "dataClasses"),
                      incidentTypes: list(f, "incidentTypes"),
                      activation: val(f, "activation") as "automatic" | "approval_required",
                      expiresAt: new Date(val(f, "expiresAt")).toISOString(),
                      revoked: false,
                    },
                  }))
                }
              >
                {sourceSelect}
                <Field name="recipientOrgId" label="Receiving entity AIRS ID" required />
                <Field
                  name="dataClasses"
                  label="Allowed information classes (comma separated)"
                  required
                />
                <Field
                  name="incidentTypes"
                  label="Qualifying incident types, e.g. planned_event, missing_person"
                  required
                />
                <Select
                  name="activation"
                  label="Activation policy"
                  values={["approval_required", "automatic"]}
                />
                <Field name="expiresAt" label="Envelope expiry" type="datetime-local" required />
                <button disabled={disabled} className={buttonClass}>
                  Create envelope
                </button>
              </form>
            </details>
          )}
        </>
      )}
      {incidentId && (
        <>
          {data.observationsTruncated && (
            <p role="alert">
              More than 500 observations are available. This view is incomplete; narrow the incident
              data before relying on completeness checks.
            </p>
          )}
          <p className="text-sm">
            Invite and accept entities in the incident roster before sharing. Entity authorization
            persists across personnel rotations.
          </p>
          {data.grants.map((g) => (
            <p key={g.id} className="text-sm">
              {g.relationship} · {g.dataClasses.join(", ")} ·{" "}
              {g.revokedAt ? "Revoked" : `Until ${g.expiresAt}`}{" "}
              {data.canManage && !g.revokedAt && (
                <button
                  className="underline"
                  onClick={() =>
                    mutation.mutate({ action: "revoke", value: { id: g.id, kind: "grant" } })
                  }
                >
                  End sharing
                </button>
              )}
            </p>
          ))}
          {data.canManage && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Authorize incident source sharing
              </summary>
              <form
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "grant",
                    value: {
                      incidentId,
                      sourceId: val(f, "sourceId"),
                      recipientOrgId: val(f, "recipientOrgId"),
                      relationship: val(f, "relationship") as
                        | "partner"
                        | "associate"
                        | "originating_entity",
                      envelopeId: val(f, "envelopeId") || undefined,
                      dataClasses: list(f, "dataClasses"),
                      expiresAt: new Date(val(f, "expiresAt")).toISOString(),
                    },
                  }))
                }
              >
                {sourceSelect}
                <Field name="recipientOrgId" label="Receiving entity AIRS ID" required />
                <Select
                  name="relationship"
                  label="Relationship"
                  values={["associate", "partner", "originating_entity"]}
                />
                <label className="block text-sm">
                  Partner envelope (Partners only)
                  <select className={inputClass} name="envelopeId">
                    <option value="">Incident-only Associate</option>
                    {data.envelopes
                      .filter((e) => e.orgId === data.orgId && !e.revokedAt)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.policy.recipientOrgId} · {e.policy.dataClasses.join(", ")}
                        </option>
                      ))}
                  </select>
                </label>
                <Field
                  name="dataClasses"
                  label="Authorized information classes (comma separated)"
                  required
                />
                <Field
                  name="expiresAt"
                  label="Incident sharing expiry"
                  type="datetime-local"
                  required
                />
                <button disabled={disabled} className={buttonClass}>
                  Authorize selected sharing
                </button>
              </form>
            </details>
          )}
          {data.canReport && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Report an observation into the COP
              </summary>
              <form
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => {
                    const grant = data.grants.find((g) => g.id === val(f, "grantId"));
                    return {
                      action: "report",
                      value: {
                        incidentId,
                        sourceId: grant?.sourceId,
                        grantId: grant?.id,
                        originatingEntity: val(f, "originatingEntity"),
                        platform: val(f, "platform"),
                        sourceRecordId: val(f, "sourceRecordId"),
                        sourceTimestamp: new Date(val(f, "sourceTimestamp")).toISOString(),
                        dataClass: val(f, "dataClass"),
                        entityType: val(f, "entityType") as (typeof ENTITY_TYPES)[number],
                        label: val(f, "label"),
                        summary: val(f, "summary"),
                        state: val(f, "state") as (typeof INFORMATION_STATES)[number],
                        verification: val(f, "verification") as
                          | "unverified"
                          | "reported"
                          | "confirmed",
                        confidence: val(f, "confidence") ? Number(val(f, "confidence")) : null,
                        geographicPrecision: val(f, "geographicPrecision") as
                          | "exact"
                          | "approximate"
                          | "area_only"
                          | "unknown"
                          | "withheld",
                        longitude: val(f, "longitude") ? Number(val(f, "longitude")) : null,
                        latitude: val(f, "latitude") ? Number(val(f, "latitude")) : null,
                        staleAfterSeconds: 300,
                      },
                    };
                  })
                }
              >
                <label className="block text-sm">
                  Information path
                  <select name="grantId" className={inputClass}>
                    <option value="">
                      Human reporting (radio / phone / dispatch / liaison / manual entry)
                    </option>
                    {data.grants
                      .filter((g) => !g.revokedAt)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          Authorized source · {g.dataClasses.join(", ")}
                        </option>
                      ))}
                  </select>
                </label>
                <Field
                  name="originatingEntity"
                  label="Originating entity / reporting participant"
                  required
                />
                <Field name="platform" label="Source platform or human reporting path" required />
                <Field name="sourceRecordId" label="Source record identifier, if available" />
                <Field
                  name="sourceTimestamp"
                  label="Time observed"
                  type="datetime-local"
                  required
                />
                <Field name="dataClass" label="Information class" required />
                <Select name="entityType" label="Operational entity type" values={ENTITY_TYPES} />
                <Field name="label" label="COP label" required />
                <Field name="summary" label="Operational observation" required />
                <Select
                  name="state"
                  label="Information state"
                  values={INFORMATION_STATES}
                  value="unverified"
                />
                <Select
                  name="verification"
                  label="Verification state"
                  values={["unverified", "reported", "confirmed"]}
                />
                <Field name="confidence" label="Confidence 0–1, if known" />
                <Select
                  name="geographicPrecision"
                  label="Geographic precision"
                  values={["unknown", "exact", "approximate", "area_only", "withheld"]}
                />
                <Field name="latitude" label="Latitude, if provided" />
                <Field name="longitude" label="Longitude, if provided" />
                <button disabled={disabled} className={buttonClass}>
                  Add observation to COP
                </button>
              </form>
            </details>
          )}
          <div className="space-y-2">
            {projectObservations(data.observations, Date.now()).map((group) => (
              <article key={group.id} className="rounded border p-3 text-sm">
                <h3 className="font-semibold">
                  {group.latest.label} · {group.state.replaceAll("_", " ")}
                </h3>
                <p>{group.latest.summary}</p>
                {group.gap && <p className="text-amber-700">{group.gap}</p>}
                <details>
                  <summary>Provenance · {group.evidence.length} observation(s)</summary>
                  {group.evidence.map((o) => (
                    <p key={o.id}>
                      {data.canCorrelate && (
                        <input
                          aria-label={`Correlate ${o.label}`}
                          type="checkbox"
                          checked={selected.includes(o.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, o.id]
                                : selected.filter((id) => id !== o.id),
                            )
                          }
                        />
                      )}{" "}
                      {o.originatingEntity} · {o.platform} · record{" "}
                      {o.sourceRecordId || "not provided"} · observed {o.sourceTimestamp} · received{" "}
                      {o.receivedTimestamp} · {o.verification} · precision {o.geographicPrecision} ·
                      confidence {o.confidence ?? "unknown"}
                    </p>
                  ))}
                </details>
              </article>
            ))}
          </div>
          {selected.length > 1 && (
            <form
              className="space-y-2"
              onSubmit={(e) =>
                submit(e, (f) => ({
                  action: "correlate",
                  value: { incidentId, observationIds: selected, reason: val(f, "reason") },
                }))
              }
            >
              <Field
                name="reason"
                label="Evidence that the selected observations describe the same operational entity"
                required
              />
              <button className={buttonClass} disabled={disabled}>
                Correlate and preserve every observation
              </button>
            </form>
          )}
          {data.canManage && (
            <details>
              <summary className="cursor-pointer font-semibold">
                Specialized supplemental source access
              </summary>
              <p className="text-sm">
                Record external provisioning for an entity and event. The COP remains the shared
                operational picture. No credentials are stored here.
              </p>
              <form
                className="mt-3 grid gap-3 md:grid-cols-2"
                onSubmit={(e) =>
                  submit(e, (f) => ({
                    action: "supplemental",
                    value: {
                      incidentId,
                      sourceId: val(f, "sourceId"),
                      recipientOrgId: val(f, "recipientOrgId"),
                      accessProfile: val(f, "accessProfile"),
                      expiresAt: new Date(val(f, "expiresAt")).toISOString(),
                      provisioningStatus: val(f, "provisioningStatus") as
                        | "requested"
                        | "provisioned"
                        | "failed",
                      revocationOwner: val(f, "revocationOwner"),
                    },
                  }))
                }
              >
                {sourceSelect}
                <Field name="recipientOrgId" label="Authorized entity AIRS ID" required />
                <Field
                  name="accessProfile"
                  label="Source access profile, e.g. Observation Only"
                  required
                />
                <Field
                  name="expiresAt"
                  label="Operational period ends"
                  type="datetime-local"
                  required
                />
                <Select
                  name="provisioningStatus"
                  label="External provisioning status"
                  values={["requested", "provisioned", "failed"]}
                />
                <Field name="revocationOwner" label="Who revokes external access?" required />
                <button disabled={disabled} className={buttonClass}>
                  Record supplemental access
                </button>
              </form>
            </details>
          )}
          {data.supplemental.map((s) => (
            <div key={s.id} className="rounded border p-2 text-sm">
              <p>
                {s.profile.accessProfile} · entity {s.profile.recipientOrgId} · provisioning{" "}
                {s.profile.provisioningStatus} · revocation {s.revocationStatus}
              </p>
              {data.canManage && s.revocationStatus !== "confirmed" && (
                <form
                  onSubmit={(e) =>
                    submit(e, (f) => ({
                      action: "revocation_receipt",
                      value: {
                        id: s.id,
                        confirmed: val(f, "result") === "confirmed",
                        receipt: val(f, "receipt"),
                      },
                    }))
                  }
                >
                  <Select
                    name="result"
                    label="Provider revocation result"
                    values={["failed", "confirmed"]}
                  />
                  <Field
                    name="receipt"
                    label="Provider receipt or failure detail (no credentials)"
                    required
                  />
                  <button disabled={disabled} className={buttonClass}>
                    Record revocation result
                  </button>
                </form>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
