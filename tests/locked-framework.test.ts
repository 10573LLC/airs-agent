import { describe, expect, it } from "vitest";
import {
  authorizeAcquisition,
  observationSchema,
  projectObservations,
  sourceSchema,
  followUpQuestions,
  type Observation,
  type Source,
} from "../src/lib/operations/framework";
const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  incident: "10000000-0000-4000-8000-000000000002",
  recipient: "10000000-0000-4000-8000-000000000003",
  envelope: "10000000-0000-4000-8000-000000000004",
};
const now = Date.parse("2026-10-02T12:00:00Z");
const expiresAt = "2026-10-03T12:00:00Z";
const source: Source = {
  ...sourceSchema.parse({
    vendor: "Dedrone",
    systemType: "C-UAS",
    controllingEntity: "Agency A",
    method: "authorized_web",
    ingestionAuthorization: "authorized",
    dataClasses: ["uas_track"],
  }),
  id: ids.source,
  orgId: "agency-a",
  health: "identified",
};
const grant = {
  incidentId: ids.incident,
  recipientOrgId: ids.recipient,
  sourceId: ids.source,
  relationship: "associate" as const,
  dataClasses: ["uas_track"],
  expiresAt,
};
const context = {
  incidentStatus: "active",
  incidentType: "planned_event",
  source,
  grant,
  dataClass: "uas_track",
  now,
};
const observation: Observation = {
  id: "observation",
  orgId: "agency-a",
  incidentId: ids.incident,
  originatingEntity: "Agency A",
  platform: "radio",
  sourceRecordId: "",
  sourceTimestamp: "2026-10-02T11:59:59Z",
  receivedTimestamp: "2026-10-02T12:00:00Z",
  dataClass: "uas_track",
  entityType: "uas",
  label: "UAS",
  summary: "Reported aircraft",
  state: "known",
  verification: "confirmed",
  confidence: null,
  geographicPrecision: "exact",
  latitude: 42,
  longitude: -73,
  staleAfterSeconds: 30,
  operationalEntityId: null,
};
describe("locked entity / incident product framework", () => {
  it("source readiness does not grant cross-entity access", () => {
    expect(authorizeAcquisition(context)).toBe(true);
    expect(
      authorizeAcquisition({
        ...context,
        source: { ...source, ingestionAuthorization: "not_now" },
      }),
    ).toBe(false);
    expect(
      authorizeAcquisition({ ...context, grant: { ...grant, dataClasses: ["unit_status"] } }),
    ).toBe(false);
    expect(authorizeAcquisition({ ...context, grant: { ...grant, revoked: true } })).toBe(false);
  });
  it.each(["draft", "scheduled", "paused", "closing", "closed", "archived"])(
    "denies ingestion in %s",
    (incidentStatus) => expect(authorizeAcquisition({ ...context, incidentStatus })).toBe(false),
  );
  it("denies expired grants and unrelated sources", () => {
    expect(
      authorizeAcquisition({ ...context, grant: { ...grant, expiresAt: "2026-10-02T12:00:00Z" } }),
    ).toBe(false);
    expect(authorizeAcquisition({ ...context, grant: { ...grant, sourceId: ids.recipient } })).toBe(
      false,
    );
  });
  it("Partners require a directional, qualifying, unrevoked envelope", () => {
    const envelope = {
      id: ids.envelope,
      recipientOrgId: ids.recipient,
      sourceId: ids.source,
      dataClasses: ["uas_track"],
      incidentTypes: ["planned_event"],
      activation: "approval_required" as const,
      expiresAt,
      revoked: false,
    };
    const partner = {
      ...context,
      grant: { ...grant, relationship: "partner" as const, envelopeId: ids.envelope },
      envelope,
    };
    expect(authorizeAcquisition(partner)).toBe(true);
    expect(authorizeAcquisition({ ...partner, envelope: undefined })).toBe(false);
    expect(authorizeAcquisition({ ...partner, incidentType: "fire" })).toBe(false);
    expect(
      authorizeAcquisition({ ...partner, envelope: { ...envelope, recipientOrgId: "different" } }),
    ).toBe(false);
    expect(authorizeAcquisition({ ...partner, envelope: { ...envelope, revoked: true } })).toBe(
      false,
    );
  });
  it("retains denied systems and asks vendor-specific follow-ups", () => {
    expect(sourceSchema.parse({ ...source, ingestionAuthorization: "denied" }).vendor).toBe(
      "Dedrone",
    );
    expect(followUpQuestions("Motorola CAD")).toContain("Controlling ECC");
    expect(followUpQuestions("Dedrone")).toContain(
      "Detection fields including operator/vehicle positions",
    );
  });
  it("never admits partial positions or hidden coordinates", () => {
    expect(observationSchema.safeParse({ ...observation, latitude: null }).success).toBe(false);
    expect(
      observationSchema.safeParse({ ...observation, geographicPrecision: "withheld" }).success,
    ).toBe(false);
    expect(observationSchema.safeParse({ ...observation, sourceId: ids.source }).success).toBe(
      false,
    );
  });
  it("keeps every observation while exposing correlated position conflicts", () => {
    const evidence = [
      { ...observation, operationalEntityId: "uas-1" },
      { ...observation, id: "second", operationalEntityId: "uas-1", latitude: 43 },
    ];
    const groups = projectObservations(evidence, now);
    expect(groups).toHaveLength(1);
    expect(groups[0].evidence).toHaveLength(2);
    expect(groups[0].state).toBe("conflicting");
    expect(evidence[0].latitude).toBe(42);
  });
  it("ages observations from source time and preserves explicit missing states", () => {
    expect(projectObservations([observation], now + 31000)[0].state).toBe("stale");
    for (const state of [
      "unknown",
      "not_provided",
      "not_authorized",
      "conflicting",
      "source_unavailable",
    ] as const)
      expect(projectObservations([{ ...observation, state }], now + 31000)[0].state).toBe(state);
    expect(
      projectObservations(
        [{ ...observation, latitude: null, longitude: null, entityType: "person" }],
        now,
      )[0].gap,
    ).toContain("location not provided");
  });
});
