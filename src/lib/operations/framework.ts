import { z } from "zod";

export const ACCESS_METHODS = [
  "native_api",
  "secure_tunnel",
  "authorized_web",
  "structured_transport",
  "human_reporting",
] as const;
export const INFORMATION_STATES = [
  "known",
  "unknown",
  "not_provided",
  "not_authorized",
  "stale",
  "conflicting",
  "unverified",
  "source_unavailable",
] as const;
export const ENTITY_TYPES = [
  "person",
  "responder",
  "vehicle",
  "ground_unit",
  "uas",
  "crewed_aircraft",
  "sensor",
  "vessel",
  "command_post",
  "hazard",
  "critical_infrastructure",
  "point_of_interest",
] as const;
const text = z.string().trim().max(2000);
const name = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
export const entityProfileSchema = z.object({
  formalName: name,
  entityType: name,
  jurisdiction: name,
  administrators: name,
  operationalContact: name,
  emergencyContact: text.default(""),
  technicalContact: name,
  identityProvider: text.default(""),
  capabilities: z.array(name).max(50).default([]),
});
export const sourceSchema = z.object({
  id: uuid.optional(),
  vendor: name,
  systemType: name,
  controllingEntity: name,
  dataClasses: z.array(name).max(50).default([]),
  method: z.enum(ACCESS_METHODS),
  ingestionAuthorization: z.enum(["authorized", "not_now", "denied"]).default("not_now"),
  technicalContact: text.default(""),
  limitations: text.default(""),
  restrictions: text.default(""),
  fallback: text.default(""),
  answers: z.record(z.string().max(120), text).default({}),
});
export type Source = z.infer<typeof sourceSchema> & { id: string; orgId: string; health: string };
export const envelopeSchema = z.object({
  id: uuid.optional(),
  recipientOrgId: uuid,
  sourceId: uuid,
  dataClasses: z.array(name).min(1).max(50),
  incidentTypes: z.array(name).min(1).max(30),
  activation: z.enum(["automatic", "approval_required"]),
  expiresAt: z.string().datetime(),
  revoked: z.boolean().default(false),
});
export const grantSchema = z.object({
  incidentId: uuid,
  recipientOrgId: uuid,
  sourceId: uuid,
  relationship: z.enum(["partner", "associate", "originating_entity"]),
  envelopeId: uuid.optional(),
  dataClasses: z.array(name).min(1).max(50),
  expiresAt: z.string().datetime(),
});
export const observationSchema = z
  .object({
    incidentId: uuid,
    sourceId: uuid.optional(),
    grantId: uuid.optional(),
    originatingEntity: name,
    platform: name,
    sourceRecordId: text.default(""),
    sourceTimestamp: z.string().datetime(),
    dataClass: name,
    entityType: z.enum(ENTITY_TYPES),
    label: name,
    summary: text,
    state: z.enum(INFORMATION_STATES),
    verification: z.enum(["unverified", "reported", "confirmed"]),
    confidence: z.number().min(0).max(1).nullable(),
    geographicPrecision: z.enum(["exact", "approximate", "area_only", "unknown", "withheld"]),
    longitude: z.number().min(-180).max(180).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    staleAfterSeconds: z.number().int().min(1).max(86400).default(300),
  })
  .superRefine((v, ctx) => {
    if ((v.latitude === null) !== (v.longitude === null))
      ctx.addIssue({ code: "custom", message: "Both coordinates are required" });
    if (["withheld", "unknown"].includes(v.geographicPrecision) && v.latitude !== null)
      ctx.addIssue({ code: "custom", message: "Undisclosed precision cannot contain coordinates" });
    if (v.sourceId && !v.grantId)
      ctx.addIssue({ code: "custom", message: "Source ingestion requires an incident grant" });
  });
export type Observation = z.infer<typeof observationSchema> & {
  id: string;
  orgId: string;
  receivedTimestamp: string;
  operationalEntityId: string | null;
};
export const supplementalSchema = z.object({
  incidentId: uuid,
  sourceId: uuid,
  recipientOrgId: uuid,
  accessProfile: name,
  expiresAt: z.string().datetime(),
  provisioningStatus: z.enum(["requested", "provisioned", "failed"]),
  revocationOwner: name,
});

export const FOLLOW_UPS: Record<string, readonly string[]> = {
  Motorola: [
    "Product and version",
    "Cloud, on premises, or hybrid",
    "Controlling ECC",
    "Available interface and approval owner",
  ],
  Fusus: ["Environment owner", "FususOne usage", "Camera ownership", "Integration permissions"],
  DroneSense: ["Hand flown, DFR, or both", "Telemetry and mission status", "Account administrator"],
  ArcGIS: [
    "Online or Enterprise",
    "Relevant feature services",
    "Layer sensitivity and sharing restrictions",
  ],
  Dedrone: [
    "Product and deployment period",
    "Detection fields including operator/vehicle positions",
    "Temporary observation account capability",
    "Provisioning and revocation owner",
  ],
  Skydio: [
    "Aircraft and docks",
    "Cloud and remote operations",
    "Telemetry and dock status",
    "Already exposed through another source",
  ],
};
export function followUpQuestions(vendor: string): readonly string[] {
  return (
    Object.entries(FOLLOW_UPS).find(([key]) =>
      vendor.toLowerCase().includes(key.toLowerCase()),
    )?.[1] ?? [
      "Available operational fields",
      "Integration approval owner",
      "Available interface",
      "Fallback reporting path",
    ]
  );
}

export function authorizeAcquisition(input: {
  incidentStatus: string;
  incidentType: string;
  source: Source;
  grant: z.infer<typeof grantSchema> & { revoked?: boolean };
  envelope?: z.infer<typeof envelopeSchema>;
  dataClass: string;
  now: number;
}): boolean {
  const { source, grant, envelope, now } = input;
  if (
    input.incidentStatus !== "active" ||
    source.ingestionAuthorization !== "authorized" ||
    grant.revoked ||
    !(Date.parse(grant.expiresAt) > now) ||
    grant.sourceId !== source.id ||
    !source.dataClasses.includes(input.dataClass) ||
    !grant.dataClasses.includes(input.dataClass)
  )
    return false;
  if (grant.relationship === "associate") return !grant.envelopeId;
  if (grant.relationship === "originating_entity")
    return !grant.envelopeId && grant.recipientOrgId === source.orgId;
  return (
    !!envelope &&
    !envelope.revoked &&
    grant.envelopeId === envelope.id &&
    envelope.sourceId === source.id &&
    envelope.recipientOrgId === grant.recipientOrgId &&
    Date.parse(envelope.expiresAt) > now &&
    Date.parse(grant.expiresAt) <= Date.parse(envelope.expiresAt) &&
    envelope.incidentTypes.includes(input.incidentType) &&
    envelope.dataClasses.includes(input.dataClass)
  );
}

export function observationState(o: Observation, now: number): (typeof INFORMATION_STATES)[number] {
  if (
    ["not_authorized", "source_unavailable", "conflicting", "not_provided", "unknown"].includes(
      o.state,
    )
  )
    return o.state;
  if (now - Date.parse(o.sourceTimestamp) > o.staleAfterSeconds * 1000) return "stale";
  if (o.verification === "unverified") return "unverified";
  return o.state;
}

/** Only observations already authorized for the viewer enter this projection. */
export function projectObservations(observations: Observation[], now: number) {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = observation.operationalEntityId ?? observation.id;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups].map(([id, evidence]) => {
    const latest = [...evidence].sort(
      (a, b) => Date.parse(b.sourceTimestamp) - Date.parse(a.sourceTimestamp),
    )[0];
    const freshPositions = evidence.filter(
      (o) => o.latitude !== null && observationState(o, now) === "known",
    );
    const conflicting = freshPositions.some(
      (o) =>
        o.latitude !== freshPositions[0]?.latitude || o.longitude !== freshPositions[0]?.longitude,
    );
    const state = conflicting ? "conflicting" : observationState(latest, now);
    return {
      id,
      latest,
      evidence,
      state,
      gap:
        latest.latitude === null
          ? `${latest.label}: location ${latest.geographicPrecision === "withheld" ? "not authorized" : "not provided"}.`
          : state !== "known"
            ? `${latest.label}: ${state.replaceAll("_", " ")}.`
            : null,
    };
  });
}
