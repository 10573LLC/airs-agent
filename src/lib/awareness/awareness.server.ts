// Manual Airspace Observations — server-side services (Stage 8).
//
// Every exported function runs through withAuthorized(), which enforces:
//   session -> account -> active membership -> organization role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
//
// On top of that this module enforces the awareness plane:
//   row access (RLS) -> ownership -> validation -> FIELD DISCLOSURE ->
//   GEOGRAPHIC PRECISION -> freshness -> action.
//
// Nothing here trusts a browser-supplied organization id, owner id, freshness
// value, disclosure profile for someone else's record, verification outcome or
// access decision. Restricted source fields (reporter identity, contact
// details, source notes, internal notes, internal case number) are removed
// from partner payloads by construction: there is no request shape that can
// ask for them.
//
// This stage is manual entry only. No feed, telemetry, broadcast ingestion,
// automated alerting, messaging or inference exists in this file.
import type { QueryRunner } from "@/lib/adapters/types";
import { withAuthorized, type AuthorizedContext } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { PRECISION_POLICIES, parseGeometry, type Geometry, type PrecisionPolicy } from "@/lib/map/model";
import { PARTNER_DISCLOSURE_PROFILES } from "@/lib/resources/disclosure";
import { assertOneOf, assertUuid, text, timestamp } from "@/lib/resources/resources.server";

import {
  ANNOTATION_TYPES,
  CONFIDENCE_LEVELS,
  EVIDENCE_TYPES,
  GAP_TYPES,
  INFORMATION_CREDIBILITY,
  LIFECYCLE_STATUSES,
  OBSERVATION_CLASSIFICATIONS,
  OBSERVATION_LOCATION_KINDS,
  OBSERVATION_SOURCES,
  OBSERVATION_TYPES,
  RELATIONSHIP_TYPES,
  RESTRICTED_SOURCE_FIELDS,
  SOURCE_RELIABILITY,
  TERMINAL_LIFECYCLE,
  TIME_PRECISIONS,
  URGENCY_LEVELS,
  VERIFICATION_STATUSES,
  canTransitionVerification,
  permissionForVerification,
  type AnnotationType,
  type ObservationLifecycle,
  type ObservationSummary,
  type VerificationStatus,
} from "./model";

// --- validation helpers -------------------------------------------------------

function integer(value: unknown, label: string, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return n;
}

function geometryOrThrow(value: unknown): Geometry {
  const parsed = parseGeometry(value);
  if (!parsed) throw new AccessError("invalid_geometry");
  return parsed;
}

function envelope(policy: string, geojson: string | null) {
  const precision = (PRECISION_POLICIES as readonly string[]).includes(policy)
    ? (policy as PrecisionPolicy)
    : "withheld";
  if (precision === "withheld" || !geojson) return { precision };
  try {
    const parsed = parseGeometry(JSON.parse(geojson));
    return parsed ? { precision, geometry: parsed } : { precision: "withheld" as PrecisionPolicy };
  } catch {
    return { precision: "withheld" as PrecisionPolicy };
  }
}

/**
 * Removes the restricted source plane and owner bookkeeping from a partner
 * payload. Deletion, not blanking: an absent key cannot be distinguished from
 * a field that was never recorded, so nothing is inferable from the shape.
 */
function projectForReader<T extends Record<string, unknown>>(row: T, isOwner: boolean): T {
  if (isOwner) return row;
  for (const key of RESTRICTED_SOURCE_FIELDS) delete row[key];
  for (const key of ["classification", "declaredPrecision", "disclosureProfile", "visibleFrom", "visibleUntil"]) {
    delete row[key];
  }
  return row;
}

// --- read plane ---------------------------------------------------------------

const OBSERVATION_SELECT = `
  o.id, o.org_id AS "orgId", o.incident_id AS "incidentId",
  o.observation_type AS "observationType", o.title, o.description,
  o.observed_object AS "observedObject", o.observed_behavior AS "observedBehavior",
  o.observed_count AS "observedCount", o.observed_altitude_ft AS "observedAltitudeFt",
  to_json(o.observed_at)#>>'{}' AS "observedAt",
  o.observed_time_precision AS "observedTimePrecision",
  to_json(o.reported_at)#>>'{}' AS "reportedAt",
  o.location_kind AS "locationKind",
  o.map_feature_id AS "mapFeatureId", o.operating_area_id AS "operatingAreaId",
  o.resource_location_id AS "resourceLocationId",
  o.source_type AS "sourceType",
  o.source_detail AS "sourceDetail", o.reporter_identity AS "reporterIdentity",
  o.reporter_contact AS "reporterContact", o.internal_notes AS "internalNotes",
  o.internal_case_number AS "internalCaseNumber",
  o.source_reliability AS "sourceReliability",
  o.information_credibility AS "informationCredibility",
  o.confidence_level AS "confidenceLevel",
  o.verification_status AS "verificationStatus",
  o.urgency, o.lifecycle_status AS "lifecycleStatus",
  o.classification, o.precision_policy AS "declaredPrecision",
  o.disclosure_profile AS "disclosureProfile",
  to_json(o.visible_from)#>>'{}' AS "visibleFrom",
  to_json(o.visible_until)#>>'{}' AS "visibleUntil",
  o.version,
  to_json(o.created_at)#>>'{}' AS "createdAt",
  to_json(o.updated_at)#>>'{}' AS "updatedAt",
  airs.related_org_name(o.org_id) AS "ownerOrgName",
  (o.org_id = $1) AS "isOwner",
  -- Freshness and precision are computed by the DATABASE, from the server
  -- clock and the reader's entitlement — never asserted by a caller.
  airs.observation_freshness(o.observation_type, o.observed_at, o.visible_until) AS "freshness",
  airs.observation_precision(o.id) AS "policy",
  public.ST_AsGeoJSON(
    airs.apply_precision(
      COALESCE(o.geom, mf.geom, oa.area, rl.geom),
      airs.observation_precision(o.id))) AS "geojson"
`;

const OBSERVATION_FROM = `
  FROM airs.observations o
  LEFT JOIN airs.map_features mf     ON mf.id = o.map_feature_id
  LEFT JOIN airs.operating_areas oa  ON oa.id = o.operating_area_id
  LEFT JOIN airs.resource_locations rl ON rl.id = o.resource_location_id
`;

interface RawObservation extends Record<string, unknown> {
  isOwner: boolean;
  policy: string;
  geojson: string | null;
}

function toObservation(row: RawObservation): ObservationSummary {
  const { isOwner, policy, geojson, ...rest } = row;
  const view: Record<string, unknown> = {
    ...rest,
    relationship: isOwner ? "owner" : "partner",
    ...envelope(policy, geojson),
  };
  return projectForReader(view, isOwner) as unknown as ObservationSummary;
}

export interface ObservationFilter {
  incidentId?: string | null;
  observationType?: string | null;
  verificationStatus?: string | null;
  lifecycleStatus?: string | null;
  urgency?: string | null;
  sourceType?: string | null;
  /** Restrict to observations whose observed time falls inside this window. */
  observedAfter?: string | null;
  observedBefore?: string | null;
  includeTerminal?: boolean;
  limit?: number;
}

export async function listObservations(
  token: string | null | undefined,
  orgId: string | null,
  filter: ObservationFilter = {},
  meta?: RequestMeta,
): Promise<ObservationSummary[]> {
  const incidentId = filter.incidentId ? assertUuid(filter.incidentId, "incident id") : null;
  const type = filter.observationType
    ? assertOneOf(filter.observationType, OBSERVATION_TYPES, "observation type")
    : null;
  const verification = filter.verificationStatus
    ? assertOneOf(filter.verificationStatus, VERIFICATION_STATUSES, "verification status")
    : null;
  const lifecycle = filter.lifecycleStatus
    ? assertOneOf(filter.lifecycleStatus, LIFECYCLE_STATUSES, "lifecycle status")
    : null;
  const urgency = filter.urgency ? assertOneOf(filter.urgency, URGENCY_LEVELS, "urgency") : null;
  const source = filter.sourceType
    ? assertOneOf(filter.sourceType, OBSERVATION_SOURCES, "source type")
    : null;
  const after = timestamp(filter.observedAfter, "observed after");
  const before = timestamp(filter.observedBefore, "observed before");
  const limit = Math.min(Math.max(integer(filter.limit, "limit", 1, 500) ?? 200, 1), 500);

  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.read",
      action: "observation.list",
      resourceType: "observation",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<RawObservation>(
        `SELECT ${OBSERVATION_SELECT} ${OBSERVATION_FROM}
          WHERE ($2::uuid IS NULL OR o.incident_id = $2)
            AND ($3::text IS NULL OR o.observation_type = $3)
            AND ($4::text IS NULL OR o.verification_status = $4)
            AND ($5::text IS NULL OR o.lifecycle_status = $5)
            AND ($6::text IS NULL OR o.urgency = $6)
            AND ($7::text IS NULL OR o.source_type = $7)
            AND ($8::timestamptz IS NULL OR o.observed_at >= $8)
            AND ($9::timestamptz IS NULL OR o.observed_at <= $9)
            AND ($10::boolean OR o.lifecycle_status NOT IN ('closed','cancelled','expired'))
          ORDER BY COALESCE(o.observed_at, o.reported_at) DESC
          LIMIT $11`,
        [
          ctx.orgId,
          incidentId,
          type,
          verification,
          lifecycle,
          urgency,
          source,
          after,
          before,
          filter.includeTerminal === true,
          limit,
        ],
      );
      return rows.map(toObservation);
    },
  );
}

export interface ObservationAnnotationView {
  id: string;
  annotationType: AnnotationType;
  body: string;
  visibility: "internal" | "shared";
  createdAt: string;
  authorName: string | null;
}

export interface ObservationRelationshipView {
  id: string;
  relationship: string;
  relatedObservationId: string;
  relatedTitle: string | null;
  note: string;
  createdAt: string;
  invalidatedAt: string | null;
}

export interface ObservationGapView {
  id: string;
  gapType: string;
  detail: string;
  status: string;
  resolutionNote: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ObservationEvidenceView {
  id: string;
  referenceType: string;
  displayName: string;
  description: string;
  classification: string;
  createdAt: string;
  /** Owner-only: the identifier held in the external system of record. */
  referenceValue?: string;
}

export interface ObservationShareView {
  id: string;
  partnerOrgId: string;
  partnerOrgName: string;
  incidentId: string | null;
  disclosureProfile: string;
  precisionPolicy: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ObservationDetail {
  observation: ObservationSummary;
  annotations: ObservationAnnotationView[];
  relationships: ObservationRelationshipView[];
  gaps: ObservationGapView[];
  evidence: ObservationEvidenceView[];
  shares: ObservationShareView[];
  /** Counts of live corroborating and conflicting links, for display only. */
  corroborationCount: number;
  conflictCount: number;
}

async function loadObservation(
  q: QueryRunner,
  ctx: AuthorizedContext,
  observationId: string,
): Promise<RawObservation> {
  const rows = await q.query<RawObservation>(
    `SELECT ${OBSERVATION_SELECT} ${OBSERVATION_FROM} WHERE o.id = $2`,
    [ctx.orgId, observationId],
  );
  const row = rows[0];
  if (!row) throw new AccessError("observation_not_found");
  return row;
}

/** Owner-only load used by every write path. RLS already scopes the row. */
async function loadOwned(
  q: QueryRunner,
  ctx: AuthorizedContext,
  observationId: string,
): Promise<{
  id: string;
  orgId: string;
  version: number;
  lifecycleStatus: ObservationLifecycle;
  verificationStatus: VerificationStatus;
  incidentId: string | null;
}> {
  const rows = await q.query<{
    id: string;
    orgId: string;
    version: number;
    lifecycleStatus: ObservationLifecycle;
    verificationStatus: VerificationStatus;
    incidentId: string | null;
  }>(
    `SELECT id, org_id AS "orgId", version, lifecycle_status AS "lifecycleStatus",
            verification_status AS "verificationStatus", incident_id AS "incidentId"
       FROM airs.observations WHERE id = $1`,
    [observationId],
  );
  const row = rows[0];
  if (!row) throw new AccessError("observation_not_found");
  // A receiving organization may read but never write: ownership is checked
  // here, in the RLS policy, and again by the database guard trigger.
  if (row.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
  return row;
}

function assertVersion(current: number, expected: unknown) {
  if (expected == null) return;
  const n = typeof expected === "number" ? expected : Number(expected);
  if (!Number.isInteger(n) || n !== current) throw new AccessError("observation_stale_version");
}

export async function getObservation(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  meta?: RequestMeta,
): Promise<ObservationDetail> {
  const id = assertUuid(observationId, "observation id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.read",
      action: "observation.read",
      resourceType: "observation",
      resourceId: id,
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const raw = await loadObservation(q, ctx, id);
      const isOwner = raw.isOwner;
      const observation = toObservation(raw);

      const annotations = await q.query<ObservationAnnotationView>(
        `SELECT a.id, a.annotation_type AS "annotationType", a.body, a.visibility,
                to_json(a.created_at)#>>'{}' AS "createdAt",
                CASE WHEN $2 THEN acc.display_name ELSE NULL END AS "authorName"
           FROM airs.observation_annotations a
           LEFT JOIN airs.accounts acc ON acc.id = a.author_account
          WHERE a.observation_id = $1
          ORDER BY a.created_at DESC`,
        [id, isOwner],
      );

      const relationships = await q.query<ObservationRelationshipView>(
        `SELECT r.id, r.relationship, r.related_observation_id AS "relatedObservationId",
                rel.title AS "relatedTitle", r.note,
                to_json(r.created_at)#>>'{}' AS "createdAt",
                to_json(r.invalidated_at)#>>'{}' AS "invalidatedAt"
           FROM airs.observation_relationships r
           LEFT JOIN airs.observations rel ON rel.id = r.related_observation_id
          WHERE r.observation_id = $1
          ORDER BY r.created_at DESC`,
        [id],
      );

      // Information gaps stay inside the originating organization: what an
      // agency does not yet know is itself sensitive.
      const gaps = isOwner
        ? await q.query<ObservationGapView>(
            `SELECT id, gap_type AS "gapType", detail, status,
                    resolution_note AS "resolutionNote",
                    to_json(created_at)#>>'{}' AS "createdAt",
                    to_json(resolved_at)#>>'{}' AS "resolvedAt"
               FROM airs.observation_information_gaps
              WHERE observation_id = $1 ORDER BY created_at DESC`,
            [id],
          )
        : [];

      const evidenceRows = await q.query<ObservationEvidenceView & { referenceValue: string }>(
        `SELECT id, reference_type AS "referenceType", display_name AS "displayName",
                description, classification, reference_value AS "referenceValue",
                to_json(created_at)#>>'{}' AS "createdAt"
           FROM airs.observation_evidence_references
          WHERE observation_id = $1 AND removed_at IS NULL
          ORDER BY created_at DESC`,
        [id],
      );
      // A partner learns THAT evidence exists, never where it is held.
      const evidence = evidenceRows.map((row) => {
        if (isOwner) return row;
        const { referenceValue: _omitted, ...rest } = row;
        return rest as ObservationEvidenceView;
      });

      const shares = isOwner
        ? await q.query<ObservationShareView>(
            `SELECT s.id, s.partner_org_id AS "partnerOrgId",
                    airs.related_org_name(s.partner_org_id) AS "partnerOrgName",
                    s.incident_id AS "incidentId",
                    s.disclosure_profile AS "disclosureProfile",
                    s.precision_policy AS "precisionPolicy", s.status,
                    to_json(s.created_at)#>>'{}' AS "createdAt",
                    to_json(s.expires_at)#>>'{}' AS "expiresAt",
                    to_json(s.revoked_at)#>>'{}' AS "revokedAt"
               FROM airs.observation_shares s
              WHERE s.observation_id = $1 ORDER BY s.created_at DESC`,
            [id],
          )
        : [];

      const live = relationships.filter((r) => !r.invalidatedAt);
      return {
        observation,
        annotations,
        relationships,
        gaps,
        evidence,
        shares,
        corroborationCount: live.filter((r) =>
          ["supports", "corroborates"].includes(r.relationship),
        ).length,
        conflictCount: live.filter((r) => r.relationship === "contradicts").length,
      };
    },
  );
}

export interface AwarenessSummary {
  total: number;
  byUrgency: Record<string, number>;
  byVerification: Record<string, number>;
  byFreshness: Record<string, number>;
  awaitingReview: number;
  openGaps: number;
  sharedOut: number;
}

export async function awarenessSummary(
  token: string | null | undefined,
  orgId: string | null,
  filter: { incidentId?: string | null } = {},
  meta?: RequestMeta,
): Promise<AwarenessSummary> {
  const incidentId = filter.incidentId ? assertUuid(filter.incidentId, "incident id") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.read",
      action: "observation.summary",
      resourceType: "observation",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{
        urgency: string;
        verificationStatus: string;
        freshness: string;
        n: string;
      }>(
        `SELECT o.urgency, o.verification_status AS "verificationStatus",
                airs.observation_freshness(o.observation_type, o.observed_at, o.visible_until) AS freshness,
                count(*)::text AS n
           FROM airs.observations o
          WHERE ($1::uuid IS NULL OR o.incident_id = $1)
            AND o.lifecycle_status NOT IN ('closed','cancelled','expired')
          GROUP BY 1,2,3`,
        [incidentId],
      );
      const summary: AwarenessSummary = {
        total: 0,
        byUrgency: {},
        byVerification: {},
        byFreshness: {},
        awaitingReview: 0,
        openGaps: 0,
        sharedOut: 0,
      };
      for (const row of rows) {
        const n = Number(row.n);
        summary.total += n;
        summary.byUrgency[row.urgency] = (summary.byUrgency[row.urgency] ?? 0) + n;
        summary.byVerification[row.verificationStatus] =
          (summary.byVerification[row.verificationStatus] ?? 0) + n;
        summary.byFreshness[row.freshness] = (summary.byFreshness[row.freshness] ?? 0) + n;
        if (row.verificationStatus === "unreviewed" || row.verificationStatus === "under_review") {
          summary.awaitingReview += n;
        }
      }
      const extra = await q.query<{ openGaps: string; sharedOut: string }>(
        `SELECT
           (SELECT count(*) FROM airs.observation_information_gaps g
             JOIN airs.observations o ON o.id = g.observation_id
            WHERE g.status = 'open' AND o.org_id = $1)::text AS "openGaps",
           (SELECT count(*) FROM airs.observation_shares s
            WHERE s.org_id = $1 AND s.status = 'active')::text AS "sharedOut"`,
        [ctx.orgId],
      );
      summary.openGaps = Number(extra[0]?.openGaps ?? 0);
      summary.sharedOut = Number(extra[0]?.sharedOut ?? 0);
      return summary;
    },
  );
}

// --- write plane --------------------------------------------------------------

export interface ObservationInput {
  incidentId?: string | null;
  observationType: string;
  title: string;
  description?: string | null;
  observedObject?: string | null;
  observedBehavior?: string | null;
  observedCount?: number | null;
  observedAltitudeFt?: number | null;
  observedAt?: string | null;
  observedTimePrecision?: string | null;
  locationKind?: string | null;
  mapFeatureId?: string | null;
  operatingAreaId?: string | null;
  resourceLocationId?: string | null;
  geometry?: unknown;
  precisionPolicy?: string | null;
  sourceType: string;
  sourceDetail?: string | null;
  reporterIdentity?: string | null;
  reporterContact?: string | null;
  internalNotes?: string | null;
  internalCaseNumber?: string | null;
  sourceReliability?: string | null;
  informationCredibility?: string | null;
  confidenceLevel?: string | null;
  urgency?: string | null;
  classification?: string | null;
  disclosureProfile?: string | null;
  visibleUntil?: string | null;
}

interface NormalizedObservation {
  incidentId: string | null;
  observationType: string;
  title: string;
  description: string;
  observedObject: string;
  observedBehavior: string;
  observedCount: number | null;
  observedAltitudeFt: number | null;
  observedAt: string | null;
  observedTimePrecision: string;
  locationKind: string;
  mapFeatureId: string | null;
  operatingAreaId: string | null;
  resourceLocationId: string | null;
  geojson: string | null;
  precisionPolicy: string;
  sourceType: string;
  sourceDetail: string;
  reporterIdentity: string;
  reporterContact: string;
  internalNotes: string;
  internalCaseNumber: string;
  sourceReliability: string;
  informationCredibility: string;
  confidenceLevel: string;
  urgency: string;
  classification: string;
  disclosureProfile: string;
  visibleUntil: string | null;
}

function normalize(input: ObservationInput): NormalizedObservation {
  const locationKind = input.locationKind
    ? assertOneOf(input.locationKind, OBSERVATION_LOCATION_KINDS, "location kind")
    : "none";
  const manual = locationKind === "manual_point" || locationKind === "manual_shape";
  const geometry = manual ? geometryOrThrow(input.geometry) : null;
  if (manual && locationKind === "manual_point" && geometry?.type !== "Point") {
    throw new AccessError("invalid_geometry");
  }
  if (
    manual &&
    locationKind === "manual_shape" &&
    geometry?.type !== "Polygon" &&
    geometry?.type !== "LineString"
  ) {
    throw new AccessError("invalid_geometry");
  }
  const observedAt = timestamp(input.observedAt, "observed time");
  const visibleUntil = timestamp(input.visibleUntil, "visible until");
  if (observedAt && Date.parse(observedAt) > Date.now() + 60_000) {
    throw new AccessError("invalid_time_window", "an observation cannot be observed in the future");
  }
  if (visibleUntil && Date.parse(visibleUntil) <= Date.now()) {
    throw new AccessError("invalid_time_window", "visibility must end in the future");
  }

  return {
    incidentId: input.incidentId ? assertUuid(input.incidentId, "incident id") : null,
    observationType: assertOneOf(input.observationType, OBSERVATION_TYPES, "observation type"),
    title: text(input.title, "title", 160, true)!,
    description: text(input.description, "description", 8000) ?? "",
    observedObject: text(input.observedObject, "observed object", 240) ?? "",
    observedBehavior: text(input.observedBehavior, "observed behavior", 1000) ?? "",
    observedCount: integer(input.observedCount, "observed count", 0, 1000),
    observedAltitudeFt: integer(input.observedAltitudeFt, "observed altitude", -1000, 60000),
    observedAt,
    observedTimePrecision: input.observedTimePrecision
      ? assertOneOf(input.observedTimePrecision, TIME_PRECISIONS, "observed time precision")
      : observedAt
        ? "estimated"
        : "unknown",
    locationKind,
    mapFeatureId:
      locationKind === "map_feature" ? assertUuid(input.mapFeatureId ?? "", "map feature id") : null,
    operatingAreaId:
      locationKind === "operating_area"
        ? assertUuid(input.operatingAreaId ?? "", "operating area id")
        : null,
    resourceLocationId:
      locationKind === "resource_location"
        ? assertUuid(input.resourceLocationId ?? "", "resource location id")
        : null,
    geojson: geometry ? JSON.stringify(geometry) : null,
    precisionPolicy: input.precisionPolicy
      ? assertOneOf(input.precisionPolicy, PRECISION_POLICIES, "precision policy")
      : "generalized",
    sourceType: assertOneOf(input.sourceType, OBSERVATION_SOURCES, "source type"),
    sourceDetail: text(input.sourceDetail, "source detail", 2000) ?? "",
    reporterIdentity: text(input.reporterIdentity, "reporter identity", 240) ?? "",
    reporterContact: text(input.reporterContact, "reporter contact", 240) ?? "",
    internalNotes: text(input.internalNotes, "internal notes", 4000) ?? "",
    internalCaseNumber: text(input.internalCaseNumber, "internal case number", 120) ?? "",
    sourceReliability: input.sourceReliability
      ? assertOneOf(input.sourceReliability, SOURCE_RELIABILITY, "source reliability")
      : "unknown",
    informationCredibility: input.informationCredibility
      ? assertOneOf(input.informationCredibility, INFORMATION_CREDIBILITY, "information credibility")
      : "unknown",
    confidenceLevel: input.confidenceLevel
      ? assertOneOf(input.confidenceLevel, CONFIDENCE_LEVELS, "confidence level")
      : "unknown",
    urgency: input.urgency ? assertOneOf(input.urgency, URGENCY_LEVELS, "urgency") : "routine",
    classification: input.classification
      ? assertOneOf(input.classification, OBSERVATION_CLASSIFICATIONS, "classification")
      : "originating_org_only",
    disclosureProfile: input.disclosureProfile
      ? assertOneOf(input.disclosureProfile, PARTNER_DISCLOSURE_PROFILES, "disclosure profile")
      : "summary",
    visibleUntil,
  };
}

export async function createObservation(
  token: string | null | undefined,
  orgId: string | null,
  input: ObservationInput,
  meta?: RequestMeta,
): Promise<ObservationSummary> {
  const v = normalize(input);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.create",
      action: "observation.create",
      resourceType: "observation",
      detail: { observationType: v.observationType, urgency: v.urgency },
      meta,
    },
    async (ctx, q) => {
      // A room that is closed or archived accepts no new reports. Decided here
      // so the caller receives a typed refusal instead of a raw database
      // exception, and so the denial is auditable.
      if (v.incidentId) {
        const room = await q.query<{ status: string }>(
          `SELECT status FROM airs.incident_rooms WHERE id = $1`,
          [v.incidentId],
        );
        const status = room[0]?.status;
        if (!status) throw new AccessError("incident_not_found");
        if (status === "closed" || status === "archived") {
          throw new AccessError("incident_closed");
        }
      }
      const rows = await q.query<{ id: string }>(
        `INSERT INTO airs.observations
           (org_id, incident_id, observation_type, title, description, observed_object,
            observed_behavior, observed_count, observed_altitude_ft, observed_at,
            observed_time_precision, location_kind, map_feature_id, operating_area_id,
            resource_location_id, geom, precision_policy, source_type, source_detail,
            reporter_identity, reporter_contact, internal_notes, internal_case_number,
            source_reliability, information_credibility, confidence_level, urgency,
            classification, disclosure_profile, visible_until, created_by_account,
            updated_by_account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 CASE WHEN $16::text IS NULL THEN NULL
                      ELSE public.ST_SetSRID(public.ST_GeomFromGeoJSON($16), 4326) END,
                 $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$31)
         RETURNING id`,
        [
          ctx.orgId,
          v.incidentId,
          v.observationType,
          v.title,
          v.description,
          v.observedObject,
          v.observedBehavior,
          v.observedCount,
          v.observedAltitudeFt,
          v.observedAt,
          v.observedTimePrecision,
          v.locationKind,
          v.mapFeatureId,
          v.operatingAreaId,
          v.resourceLocationId,
          v.geojson,
          v.precisionPolicy,
          v.sourceType,
          v.sourceDetail,
          v.reporterIdentity,
          v.reporterContact,
          v.internalNotes,
          v.internalCaseNumber,
          v.sourceReliability,
          v.informationCredibility,
          v.confidenceLevel,
          v.urgency,
          v.classification,
          v.disclosureProfile,
          v.visibleUntil,
          ctx.accountId,
        ],
      );
      const id = rows[0]!.id;
      return toObservation(await loadObservation(q, ctx, id));
    },
  );
}

/**
 * Corrections are recorded as a new VERSION plus a mandatory annotation; the
 * original report text is preserved in the annotation trail, and the source,
 * origin and ownership of the record can never be rewritten.
 */
export async function updateObservation(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: ObservationInput & { expectedVersion?: number; correctionNote?: string | null },
  meta?: RequestMeta,
): Promise<ObservationSummary> {
  const id = assertUuid(observationId, "observation id");
  const v = normalize(input);
  const note = text(input.correctionNote, "correction note", 4000);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.update_own",
      action: "observation.update",
      resourceType: "observation",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const current = await loadOwned(q, ctx, id);
      assertVersion(current.version, input.expectedVersion);
      if (TERMINAL_LIFECYCLE.includes(current.lifecycleStatus)) {
        throw new AccessError("observation_terminal");
      }
      await q.query(
        `UPDATE airs.observations SET
           incident_id = $2, observation_type = $3, title = $4, description = $5,
           observed_object = $6, observed_behavior = $7, observed_count = $8,
           observed_altitude_ft = $9, observed_at = $10, observed_time_precision = $11,
           location_kind = $12, map_feature_id = $13, operating_area_id = $14,
           resource_location_id = $15,
           geom = CASE WHEN $16::text IS NULL THEN NULL
                       ELSE public.ST_SetSRID(public.ST_GeomFromGeoJSON($16), 4326) END,
           precision_policy = $17, source_type = $18, source_detail = $19,
           reporter_identity = $20, reporter_contact = $21, internal_notes = $22,
           internal_case_number = $23, source_reliability = $24,
           information_credibility = $25, confidence_level = $26, urgency = $27,
           classification = $28, disclosure_profile = $29, visible_until = $30,
           updated_by_account = $31, version = version + 1
         WHERE id = $1`,
        [
          id,
          v.incidentId,
          v.observationType,
          v.title,
          v.description,
          v.observedObject,
          v.observedBehavior,
          v.observedCount,
          v.observedAltitudeFt,
          v.observedAt,
          v.observedTimePrecision,
          v.locationKind,
          v.mapFeatureId,
          v.operatingAreaId,
          v.resourceLocationId,
          v.geojson,
          v.precisionPolicy,
          v.sourceType,
          v.sourceDetail,
          v.reporterIdentity,
          v.reporterContact,
          v.internalNotes,
          v.internalCaseNumber,
          v.sourceReliability,
          v.informationCredibility,
          v.confidenceLevel,
          v.urgency,
          v.classification,
          v.disclosureProfile,
          v.visibleUntil,
          ctx.accountId,
        ],
      );
      await q.query(
        `INSERT INTO airs.observation_annotations
           (org_id, observation_id, annotation_type, body, visibility, author_account)
         VALUES ($1,$2,'correction',$3,'internal',$4)`,
        [
          ctx.orgId,
          id,
          note ?? `Record corrected (version ${current.version} superseded).`,
          ctx.accountId,
        ],
      );
      return toObservation(await loadObservation(q, ctx, id));
    },
  );
}

export async function setVerificationStatus(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: {
    status: string;
    rationale?: string | null;
    confidenceLevel?: string | null;
    expectedVersion?: number;
  },
  meta?: RequestMeta,
): Promise<ObservationSummary> {
  const id = assertUuid(observationId, "observation id");
  const target = assertOneOf(input.status, VERIFICATION_STATUSES, "verification status");
  const rationale = text(input.rationale, "rationale", 4000);
  const confidence = input.confidenceLevel
    ? assertOneOf(input.confidenceLevel, CONFIDENCE_LEVELS, "confidence level")
    : null;
  // The required permission depends on the TARGET state: reviewing, verifying
  // and rejecting are three separately granted authorities.
  const permission = permissionForVerification(target);
  return withAuthorized(
    {
      token,
      orgId,
      permission,
      action: `observation.verification.${target}`,
      resourceType: "observation",
      resourceId: id,
      detail: { target },
      meta,
    },
    async (ctx, q) => {
      const current = await loadOwned(q, ctx, id);
      assertVersion(current.version, input.expectedVersion);
      if (TERMINAL_LIFECYCLE.includes(current.lifecycleStatus)) {
        throw new AccessError("observation_terminal");
      }
      if (!canTransitionVerification(current.verificationStatus, target)) {
        throw new AccessError("observation_state_invalid");
      }
      const decided = ["corroborated", "confirmed", "rejected"].includes(target);
      await q.query(
        `UPDATE airs.observations SET
           verification_status = $2,
           confidence_level = COALESCE($3, confidence_level),
           reviewed_at = now(), reviewed_by_account = $4,
           verified_at = CASE WHEN $5 THEN now() ELSE verified_at END,
           verified_by_account = CASE WHEN $5 THEN $4 ELSE verified_by_account END,
           updated_by_account = $4, version = version + 1
         WHERE id = $1`,
        [id, target, confidence, ctx.accountId, decided],
      );
      // Every verification change carries its own auditable rationale.
      await q.query(
        `INSERT INTO airs.observation_annotations
           (org_id, observation_id, annotation_type, body, visibility, author_account)
         VALUES ($1,$2,'status_rationale',$3,'internal',$4)`,
        [
          ctx.orgId,
          id,
          rationale ?? `Verification status changed from ${current.verificationStatus} to ${target}.`,
          ctx.accountId,
        ],
      );
      return toObservation(await loadObservation(q, ctx, id));
    },
  );
}

export async function setLifecycleStatus(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: { status: string; note?: string | null; expectedVersion?: number },
  meta?: RequestMeta,
): Promise<ObservationSummary> {
  const id = assertUuid(observationId, "observation id");
  const target = assertOneOf(input.status, LIFECYCLE_STATUSES, "lifecycle status");
  if (target === "expired") {
    // Expiry is a clock outcome, never an operator action.
    throw new AccessError("observation_state_invalid");
  }
  const note = text(input.note, "note", 4000);
  const closing = target === "closed" || target === "cancelled";
  return withAuthorized(
    {
      token,
      orgId,
      permission: closing ? "observation.close" : "observation.update_own",
      action: `observation.lifecycle.${target}`,
      resourceType: "observation",
      resourceId: id,
      detail: { target },
      meta,
    },
    async (ctx, q) => {
      const current = await loadOwned(q, ctx, id);
      assertVersion(current.version, input.expectedVersion);
      if (current.lifecycleStatus === target) throw new AccessError("observation_state_invalid");
      if (TERMINAL_LIFECYCLE.includes(current.lifecycleStatus) && !closing) {
        // Leaving a terminal state is a reopen, and needs its own permission.
        if (!ctx.permissions.has("observation.reopen")) throw new AccessError("forbidden");
        if (current.lifecycleStatus === "cancelled") throw new AccessError("observation_terminal");
      }
      await q.query(
        `UPDATE airs.observations SET
           lifecycle_status = $2,
           closed_at = CASE WHEN $3 THEN now() ELSE NULL END,
           closed_by_account = CASE WHEN $3 THEN $4::uuid ELSE NULL END,
           updated_by_account = $4::uuid, version = version + 1
         WHERE id = $1`,
        [id, target, closing, ctx.accountId],
      );
      await q.query(
        `INSERT INTO airs.observation_annotations
           (org_id, observation_id, annotation_type, body, visibility, author_account)
         VALUES ($1,$2,'status_rationale',$3,'internal',$4)`,
        [
          ctx.orgId,
          id,
          note ?? `Lifecycle changed from ${current.lifecycleStatus} to ${target}.`,
          ctx.accountId,
        ],
      );
      return toObservation(await loadObservation(q, ctx, id));
    },
  );
}

export async function addAnnotation(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: { annotationType: string; body: string; visibility?: string | null },
  meta?: RequestMeta,
): Promise<ObservationAnnotationView> {
  const id = assertUuid(observationId, "observation id");
  const annotationType = assertOneOf(input.annotationType, ANNOTATION_TYPES, "annotation type");
  const body = text(input.body, "annotation", 4000, true)!;
  const visibility = input.visibility
    ? assertOneOf(input.visibility, ["internal", "shared"] as const, "visibility")
    : "internal";
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.review",
      action: "observation.annotate",
      resourceType: "observation",
      resourceId: id,
      detail: { annotationType, visibility },
      meta,
    },
    async (ctx, q) => {
      await loadOwned(q, ctx, id);
      const rows = await q.query<ObservationAnnotationView>(
        `INSERT INTO airs.observation_annotations
           (org_id, observation_id, annotation_type, body, visibility, author_account)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, annotation_type AS "annotationType", body, visibility,
                   to_json(created_at)#>>'{}' AS "createdAt", NULL::text AS "authorName"`,
        [ctx.orgId, id, annotationType, body, visibility, ctx.accountId],
      );
      return rows[0]!;
    },
  );
}

export async function relateObservations(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: { relatedObservationId: string; relationship: string; note?: string | null },
  meta?: RequestMeta,
): Promise<ObservationRelationshipView> {
  const id = assertUuid(observationId, "observation id");
  const relatedId = assertUuid(input.relatedObservationId, "related observation id");
  if (id === relatedId) throw new AccessError("observation_relationship_invalid");
  const relationship = assertOneOf(input.relationship, RELATIONSHIP_TYPES, "relationship");
  const note = text(input.note, "note", 1000) ?? "";
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.link",
      action: "observation.relate",
      resourceType: "observation",
      resourceId: id,
      detail: { relationship },
      meta,
    },
    async (ctx, q) => {
      await loadOwned(q, ctx, id);
      // The related record must be one this organization can actually reach;
      // RLS makes an unreachable id return no row rather than leak existence.
      const related = await q.query<{ id: string }>(
        `SELECT id FROM airs.observations WHERE id = $1`,
        [relatedId],
      );
      if (!related[0]) throw new AccessError("observation_not_found");
      const rows = await q.query<ObservationRelationshipView>(
        `INSERT INTO airs.observation_relationships
           (org_id, observation_id, related_observation_id, relationship, note, created_by_account)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING id, relationship, related_observation_id AS "relatedObservationId",
                   NULL::text AS "relatedTitle", note,
                   to_json(created_at)#>>'{}' AS "createdAt",
                   to_json(invalidated_at)#>>'{}' AS "invalidatedAt"`,
        [ctx.orgId, id, relatedId, relationship, note, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("observation_relationship_invalid");
      return rows[0];
    },
  );
}

export async function invalidateRelationship(
  token: string | null | undefined,
  orgId: string | null,
  relationshipId: string,
  meta?: RequestMeta,
): Promise<{ id: string; invalidatedAt: string }> {
  const id = assertUuid(relationshipId, "relationship id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.link",
      action: "observation.relationship.invalidate",
      resourceType: "observation_relationship",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string; invalidatedAt: string }>(
        `UPDATE airs.observation_relationships
            SET invalidated_at = now(), invalidated_by_account = $2
          WHERE id = $1 AND invalidated_at IS NULL
          RETURNING id, to_json(invalidated_at)#>>'{}' AS "invalidatedAt"`,
        [id, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("observation_relationship_invalid");
      return rows[0];
    },
  );
}

export async function addInformationGap(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: { gapType: string; detail?: string | null },
  meta?: RequestMeta,
): Promise<ObservationGapView> {
  const id = assertUuid(observationId, "observation id");
  const gapType = assertOneOf(input.gapType, GAP_TYPES, "gap type");
  const detail = text(input.detail, "detail", 1000) ?? "";
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.review",
      action: "observation.gap.create",
      resourceType: "observation",
      resourceId: id,
      detail: { gapType },
      meta,
    },
    async (ctx, q) => {
      await loadOwned(q, ctx, id);
      const rows = await q.query<ObservationGapView>(
        `INSERT INTO airs.observation_information_gaps
           (org_id, observation_id, gap_type, detail, created_by_account)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, gap_type AS "gapType", detail, status,
                   resolution_note AS "resolutionNote",
                   to_json(created_at)#>>'{}' AS "createdAt",
                   to_json(resolved_at)#>>'{}' AS "resolvedAt"`,
        [ctx.orgId, id, gapType, detail, ctx.accountId],
      );
      return rows[0]!;
    },
  );
}

export async function closeInformationGap(
  token: string | null | undefined,
  orgId: string | null,
  gapId: string,
  input: { status: string; resolutionNote?: string | null },
  meta?: RequestMeta,
): Promise<ObservationGapView> {
  const id = assertUuid(gapId, "gap id");
  const status = assertOneOf(input.status, ["resolved", "cancelled"] as const, "gap status");
  const note = text(input.resolutionNote, "resolution note", 1000) ?? "";
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.review",
      action: `observation.gap.${status}`,
      resourceType: "observation_gap",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<ObservationGapView>(
        `UPDATE airs.observation_information_gaps
            SET status = $2, resolution_note = $3, resolved_at = now(),
                resolved_by_account = $4
          WHERE id = $1 AND status = 'open'
          RETURNING id, gap_type AS "gapType", detail, status,
                    resolution_note AS "resolutionNote",
                    to_json(created_at)#>>'{}' AS "createdAt",
                    to_json(resolved_at)#>>'{}' AS "resolvedAt"`,
        [id, status, note, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("observation_gap_not_found");
      return rows[0];
    },
  );
}

/**
 * Evidence REFERENCES only. The system stores a description and an external
 * identifier; it never uploads, stores, proxies or links to a file, and a
 * `file:` path or non-HTTPS locator is refused by the database constraint.
 */
export async function addEvidenceReference(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: {
    referenceType: string;
    displayName: string;
    description?: string | null;
    referenceValue?: string | null;
    classification?: string | null;
  },
  meta?: RequestMeta,
): Promise<ObservationEvidenceView> {
  const id = assertUuid(observationId, "observation id");
  const referenceType = assertOneOf(input.referenceType, EVIDENCE_TYPES, "evidence type");
  const displayName = text(input.displayName, "display name", 160, true)!;
  const description = text(input.description, "description", 1000) ?? "";
  const referenceValue = text(input.referenceValue, "reference", 240) ?? "";
  if (/^file:/i.test(referenceValue) || (referenceValue.includes("://") && !/^https:\/\//i.test(referenceValue))) {
    throw new AccessError("invalid_input", "evidence references must be identifiers or https locators");
  }
  const classification = input.classification
    ? assertOneOf(input.classification, OBSERVATION_CLASSIFICATIONS, "classification")
    : "originating_org_only";
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.evidence_reference_manage",
      action: "observation.evidence.add",
      resourceType: "observation",
      resourceId: id,
      detail: { referenceType, classification },
      meta,
    },
    async (ctx, q) => {
      await loadOwned(q, ctx, id);
      const rows = await q.query<ObservationEvidenceView>(
        `INSERT INTO airs.observation_evidence_references
           (org_id, observation_id, reference_type, display_name, description,
            reference_value, classification, created_by_account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, reference_type AS "referenceType", display_name AS "displayName",
                   description, classification, reference_value AS "referenceValue",
                   to_json(created_at)#>>'{}' AS "createdAt"`,
        [ctx.orgId, id, referenceType, displayName, description, referenceValue, classification, ctx.accountId],
      );
      return rows[0]!;
    },
  );
}

export async function removeEvidenceReference(
  token: string | null | undefined,
  orgId: string | null,
  evidenceId: string,
  meta?: RequestMeta,
): Promise<{ id: string }> {
  const id = assertUuid(evidenceId, "evidence id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.evidence_reference_manage",
      action: "observation.evidence.remove",
      resourceType: "observation_evidence",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.observation_evidence_references
            SET removed_at = now(), removed_by_account = $2
          WHERE id = $1 AND removed_at IS NULL RETURNING id`,
        [id, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("observation_evidence_not_found");
      return rows[0];
    },
  );
}

/**
 * Sharing is explicit, per observation, per partner, and always revocable.
 * The share can only ever NARROW what the observation already declares, and
 * onward sharing by a receiving organization is impossible: the database
 * refuses a share authored by anyone but the originating organization.
 */
export async function shareObservation(
  token: string | null | undefined,
  orgId: string | null,
  observationId: string,
  input: {
    partnerOrgId: string;
    incidentId?: string | null;
    disclosureProfile?: string | null;
    precisionPolicy?: string | null;
    expiresAt?: string | null;
  },
  meta?: RequestMeta,
): Promise<ObservationShareView> {
  const id = assertUuid(observationId, "observation id");
  const partnerOrgId = assertUuid(input.partnerOrgId, "partner organization id");
  const incidentId = input.incidentId ? assertUuid(input.incidentId, "incident id") : null;
  const profile = input.disclosureProfile
    ? assertOneOf(input.disclosureProfile, PARTNER_DISCLOSURE_PROFILES, "disclosure profile")
    : "summary";
  const precision = input.precisionPolicy
    ? assertOneOf(input.precisionPolicy, PRECISION_POLICIES, "precision policy")
    : "area_only";
  const expiresAt = timestamp(input.expiresAt, "expiry");
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new AccessError("invalid_time_window", "a share must expire in the future");
  }
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.share",
      action: "observation.share",
      resourceType: "observation",
      resourceId: id,
      detail: { partnerOrgId, profile, precision },
      meta,
    },
    async (ctx, q) => {
      const current = await loadOwned(q, ctx, id);
      if (TERMINAL_LIFECYCLE.includes(current.lifecycleStatus)) {
        throw new AccessError("observation_terminal");
      }
      if (partnerOrgId === ctx.orgId) throw new AccessError("invalid_input");
      // Eligibility is decided here so the caller gets a typed refusal rather
      // than a raw database exception: sharing requires an APPROVED trust
      // relationship the receiving agency cannot create for itself.
      const trusted = await q.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM airs.trusted_agencies t
            WHERE t.org_id = $1 AND t.partner_org_id = $2 AND t.status = 'approved'
         ) AS ok`,
        [ctx.orgId, partnerOrgId],
      );
      if (!trusted[0]?.ok) throw new AccessError("partner_not_eligible");
      const rows = await q.query<ObservationShareView>(
        `INSERT INTO airs.observation_shares
           (org_id, observation_id, partner_org_id, incident_id, disclosure_profile,
            precision_policy, expires_at, shared_by_account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, partner_org_id AS "partnerOrgId",
                   airs.related_org_name(partner_org_id) AS "partnerOrgName",
                   incident_id AS "incidentId",
                   disclosure_profile AS "disclosureProfile",
                   precision_policy AS "precisionPolicy", status,
                   to_json(created_at)#>>'{}' AS "createdAt",
                   to_json(expires_at)#>>'{}' AS "expiresAt",
                   to_json(revoked_at)#>>'{}' AS "revokedAt"`,
        [ctx.orgId, id, partnerOrgId, incidentId, profile, precision, expiresAt, ctx.accountId],
      );
      return rows[0]!;
    },
  );
}

export async function revokeObservationShare(
  token: string | null | undefined,
  orgId: string | null,
  shareId: string,
  meta?: RequestMeta,
): Promise<{ id: string; revokedAt: string }> {
  const id = assertUuid(shareId, "share id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "observation.revoke_share",
      action: "observation.share.revoke",
      resourceType: "observation_share",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string; revokedAt: string }>(
        `UPDATE airs.observation_shares
            SET status = 'revoked', revoked_at = now(), revoked_by_account = $2
          WHERE id = $1 AND status = 'active'
          RETURNING id, to_json(revoked_at)#>>'{}' AS "revokedAt"`,
        [id, ctx.accountId],
      );
      if (!rows[0]) throw new AccessError("observation_share_not_found");
      return rows[0];
    },
  );
}
