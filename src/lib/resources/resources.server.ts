// Operational Resource Registry — server-side services.
//
// Every exported function runs through withAuthorized(), which enforces:
//   session -> account -> active membership -> organization role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
//
// On top of that this module enforces the registry plane:
//   resource existence -> ownership (or live incident share) -> classification
//   -> category/status validation -> lifecycle rule -> action.
//
// Nothing here trusts a browser-supplied organization id, owner id, category,
// status, classification or version.
import type { QueryRunner } from "@/lib/adapters/types";
import { recordAudit } from "@/lib/audit.server";
import { withAuthorized, type AuthorizedContext } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";

import {
  READINESS_STATUSES,
  RESOURCE_CATEGORIES,
  SENSOR_CATEGORIES,
  SHARING_CLASSIFICATIONS,
  OPERATIONAL_STATUSES,
  detailKindFor,
  statusAllowedForCategory,
  type ReadinessStatus,
  type ResourceCategory,
  type SharingClassification,
} from "./model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return value;
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return value as T;
}

export function text(value: unknown, label: string, max: number, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new AccessError("invalid_input", `${label} is required`);
    return null;
  }
  if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new AccessError("invalid_input", `${label} is required`);
  if (trimmed.length > max) throw new AccessError("invalid_input", `${label} is too long`);
  return trimmed;
}

export function timestamp(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return new Date(value).toISOString();
}

/** Category detail rows only ever carry JSON-safe scalars or string arrays. */
export type DetailValue = string | number | boolean | string[] | null;
export type DetailRecord = Record<string, DetailValue>;

export interface ResourceRow {
  id: string;
  orgId: string;
  category: ResourceCategory;
  displayName: string;
  callsign: string | null;
  description: string;
  readinessStatus: ReadinessStatus;
  operationalStatus: string;
  sharingClassification: SharingClassification;
  lifecycleStatus: "active" | "retired";
  restrictedNotes: string | null;
  retiredAt: string | null;
  restoredAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceView extends ResourceRow {
  /** "owner" when the active organization originated the record. */
  relationship: "owner" | "partner";
  ownerOrgName?: string | null;
  detail?: DetailRecord | null;
}

const COLUMNS = `
  r.id, r.org_id AS "orgId", r.category, r.display_name AS "displayName", r.callsign,
  r.description, r.readiness_status AS "readinessStatus",
  r.operational_status AS "operationalStatus",
  r.sharing_classification AS "sharingClassification",
  r.lifecycle_status AS "lifecycleStatus", r.restricted_notes AS "restrictedNotes",
  to_json(r.retired_at)#>>'{}' AS "retiredAt", to_json(r.restored_at)#>>'{}' AS "restoredAt",
  r.version, to_json(r.created_at)#>>'{}' AS "createdAt",
  to_json(r.updated_at)#>>'{}' AS "updatedAt"
`;

/** Strips owner-only fields from a record the active organization does not own. */
function redactForPartner(row: ResourceRow): ResourceRow {
  return { ...row, restrictedNotes: null };
}

const DETAIL_TABLES = {
  aircraft: "resource_aircraft",
  vehicle: "resource_vehicles",
  dock: "resource_docks",
  launch_site: "resource_launch_sites",
  sensor: "resource_sensors",
} as const;

/** Owner-only detail columns removed from a partner view (e.g. serial numbers). */
const PARTNER_HIDDEN_DETAIL = new Set([
  "serial_number",
  "restricted_notes",
  "faa_registration",
  "agency_identifier",
]);

async function loadDetail(
  q: QueryRunner,
  resource: ResourceRow,
  owner: boolean,
): Promise<DetailRecord | null> {
  const table = DETAIL_TABLES[detailKindFor(resource.category)];
  const rows = await q.query<DetailRecord>(
    `SELECT * FROM airs.${table} WHERE resource_id = $1`,
    [resource.id],
  );
  const row = rows[0];
  if (!row) return null;
  if (owner) return row;
  const out: DetailRecord = {};
  for (const [k, v] of Object.entries(row)) if (!PARTNER_HIDDEN_DETAIL.has(k)) out[k] = v;
  return out;
}

async function fetchResource(q: QueryRunner, id: string): Promise<ResourceRow> {
  const rows = await q.query<ResourceRow>(
    `SELECT ${COLUMNS} FROM airs.resources r WHERE r.id = $1`,
    [assertUuid(id, "resource id")],
  );
  const row = rows[0];
  // RLS already hides other tenants' unshared rows; an explicit throw makes the
  // denial auditable instead of an empty result.
  if (!row) throw new AccessError("resource_not_found");
  return row;
}

/** Ownership is the only path to any write. Never inferred from the request. */
function assertOwner(ctx: AuthorizedContext, row: ResourceRow) {
  if (row.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
}

// --- reads --------------------------------------------------------------------

export async function listResources(
  token: string | null | undefined,
  orgId: string | null,
  filter: { category?: string | null; includeRetired?: boolean } = {},
  meta?: RequestMeta,
): Promise<ResourceView[]> {
  const category = filter.category
    ? assertOneOf(filter.category, RESOURCE_CATEGORIES, "category")
    : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "resource.list",
      resourceType: "resource",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<ResourceRow>(
        `SELECT ${COLUMNS} FROM airs.resources r
          WHERE r.org_id = $1
            AND ($2::text IS NULL OR r.category = $2)
            AND ($3::boolean OR r.lifecycle_status = 'active')
          ORDER BY r.category, r.display_name`,
        [ctx.orgId, category, filter.includeRetired === true],
      );
      return rows.map((row) => ({ ...row, relationship: "owner" as const }));
    },
  );
}

/** Resources other agencies have shared into an incident this organization is in. */
export async function listSharedResources(
  token: string | null | undefined,
  orgId: string | null,
  incidentId?: string | null,
  meta?: RequestMeta,
): Promise<(ResourceView & { incidentId: string; classification: string })[]> {
  const inc = incidentId ? assertUuid(incidentId, "incident id") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "resource.list_shared",
      resourceType: "resource",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<
        ResourceRow & { incidentId: string; classification: string; ownerOrgName: string | null }
      >(
        `SELECT ${COLUMNS}, s.incident_id AS "incidentId", s.classification,
                airs.related_org_name(r.org_id) AS "ownerOrgName"
           FROM airs.resources r
           JOIN airs.resource_shares s ON s.resource_id = r.id
          WHERE r.org_id <> $1
            AND ($2::uuid IS NULL OR s.incident_id = $2)
            AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
          ORDER BY r.display_name`,
        [ctx.orgId, inc],
      );
      return rows.map((row) => ({
        ...redactForPartner(row),
        incidentId: row.incidentId,
        classification: row.classification,
        ownerOrgName: row.ownerOrgName,
        relationship: "partner" as const,
      }));
    },
  );
}

export async function readResource(
  token: string | null | undefined,
  orgId: string | null,
  resourceId: string,
  meta?: RequestMeta,
): Promise<ResourceView> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "resource.read",
      resourceType: "resource",
      resourceId,
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const row = await fetchResource(q, resourceId);
      const owner = row.orgId === ctx.orgId;
      const detail = await loadDetail(q, row, owner);
      return {
        ...(owner ? row : redactForPartner(row)),
        relationship: owner ? ("owner" as const) : ("partner" as const),
        detail,
      };
    },
  );
}

// --- writes -------------------------------------------------------------------

export interface CreateResourceInput {
  category: string;
  displayName: string;
  callsign?: string | null;
  description?: string | null;
  readinessStatus?: string | null;
  operationalStatus?: string | null;
  sharingClassification?: string | null;
  restrictedNotes?: string | null;
}

export async function createResource(
  token: string | null | undefined,
  orgId: string | null,
  input: CreateResourceInput,
  meta?: RequestMeta,
): Promise<ResourceView> {
  const category = assertOneOf(input.category, RESOURCE_CATEGORIES, "category");
  const readiness = input.readinessStatus
    ? assertOneOf(input.readinessStatus, READINESS_STATUSES, "readiness status")
    : ("unavailable" as ReadinessStatus);
  if (!statusAllowedForCategory(category, readiness)) {
    throw new AccessError("invalid_status_for_category");
  }
  const displayName = text(input.displayName, "display name", 160, true)!;
  const callsign = text(input.callsign, "callsign", 60);
  const description = text(input.description, "description", 2000) ?? "";
  const operational = input.operationalStatus
    ? assertOneOf(input.operationalStatus, OPERATIONAL_STATUSES, "operational status")
    : "unknown";
  const classification = input.sharingClassification
    ? assertOneOf(input.sharingClassification, SHARING_CLASSIFICATIONS, "sharing classification")
    : "originating_org_only";
  const notes = text(input.restrictedNotes, "notes", 2000);

  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.create",
      action: "resource.created",
      resourceType: "resource",
      detail: { category, readiness },
      meta,
    },
    async (ctx, q) => {
      // org_id comes from the resolved membership, never from the request body.
      const rows = await q.query<ResourceRow>(
        `INSERT INTO airs.resources
           (org_id, category, display_name, callsign, description, readiness_status,
            operational_status, sharing_classification, restricted_notes,
            created_by_account, updated_by_account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         RETURNING ${COLUMNS.replaceAll("r.", "")}`,
        [
          ctx.orgId,
          category,
          displayName,
          callsign,
          description,
          readiness,
          operational,
          classification,
          notes,
          ctx.accountId,
        ],
      );
      return { ...rows[0], relationship: "owner" as const };
    },
  );
}

export interface UpdateResourceInput {
  resourceId: string;
  version: number;
  displayName?: string | null;
  callsign?: string | null;
  description?: string | null;
  operationalStatus?: string | null;
  sharingClassification?: string | null;
  restrictedNotes?: string | null;
}

/** Narrow update: only the fields listed here can ever change. */
export async function updateResource(
  token: string | null | undefined,
  orgId: string | null,
  input: UpdateResourceInput,
  meta?: RequestMeta,
): Promise<ResourceView> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.update",
      action: "resource.updated",
      resourceType: "resource",
      resourceId,
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      if (current.lifecycleStatus === "retired") throw new AccessError("resource_retired");
      if (current.version !== input.version) throw new AccessError("version_conflict");

      const rows = await q.query<ResourceRow>(
        `UPDATE airs.resources SET
           display_name = COALESCE($2, display_name),
           callsign = COALESCE($3, callsign),
           description = COALESCE($4, description),
           operational_status = COALESCE($5, operational_status),
           sharing_classification = COALESCE($6, sharing_classification),
           restricted_notes = COALESCE($7, restricted_notes),
           updated_by_account = $8, updated_at = now(), version = version + 1
         WHERE id = $1 AND org_id = $9
         RETURNING ${COLUMNS.replaceAll("r.", "")}`,
        [
          resourceId,
          text(input.displayName, "display name", 160),
          text(input.callsign, "callsign", 60),
          text(input.description, "description", 2000),
          input.operationalStatus
            ? assertOneOf(input.operationalStatus, OPERATIONAL_STATUSES, "operational status")
            : null,
          input.sharingClassification
            ? assertOneOf(
                input.sharingClassification,
                SHARING_CLASSIFICATIONS,
                "sharing classification",
              )
            : null,
          text(input.restrictedNotes, "notes", 2000),
          ctx.accountId,
          ctx.orgId,
        ],
      );
      if (!rows[0]) throw new AccessError("resource_not_found");
      return { ...rows[0], relationship: "owner" as const };
    },
  );
}

export async function setResourceStatus(
  token: string | null | undefined,
  orgId: string | null,
  input: { resourceId: string; readinessStatus: string },
  meta?: RequestMeta,
): Promise<ResourceView> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  const status = assertOneOf(input.readinessStatus, READINESS_STATUSES, "readiness status");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.set_status",
      action: "resource.status_changed",
      resourceType: "resource",
      resourceId,
      detail: { status },
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      if (current.lifecycleStatus === "retired") {
        await recordAudit(q, {
          orgId: ctx.orgId,
          actorUserId: ctx.userId,
          action: "resource.invalid_status_transition",
          resourceType: "resource",
          resourceId,
          outcome: "deny",
          detail: { reason: "retired", requested: status },
        });
        throw new AccessError("resource_retired");
      }
      if (!statusAllowedForCategory(current.category, status)) {
        await recordAudit(q, {
          orgId: ctx.orgId,
          actorUserId: ctx.userId,
          action: "resource.invalid_status_transition",
          resourceType: "resource",
          resourceId,
          outcome: "deny",
          detail: { category: current.category, requested: status },
        });
        throw new AccessError("invalid_status_for_category");
      }
      const rows = await q.query<ResourceRow>(
        `UPDATE airs.resources
            SET readiness_status = $2, updated_by_account = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND org_id = $4
          RETURNING ${COLUMNS.replaceAll("r.", "")}`,
        [resourceId, status, ctx.accountId, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("resource_not_found");
      return { ...rows[0], relationship: "owner" as const };
    },
  );
}

export async function retireResource(
  token: string | null | undefined,
  orgId: string | null,
  input: { resourceId: string; reason?: string | null },
  meta?: RequestMeta,
): Promise<ResourceView> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.retire",
      action: "resource.retired",
      resourceType: "resource",
      resourceId,
      detail: { reason: text(input.reason, "reason", 500) },
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      const rows = await q.query<ResourceRow>(
        `UPDATE airs.resources
            SET lifecycle_status = 'retired', readiness_status = 'retired',
                retired_at = now(), retired_by_account = $2,
                updated_by_account = $2, updated_at = now(), version = version + 1
          WHERE id = $1 AND org_id = $3
          RETURNING ${COLUMNS.replaceAll("r.", "")}`,
        [resourceId, ctx.accountId, ctx.orgId],
      );
      // Retirement also ends every live share of the record.
      await q.query(
        `UPDATE airs.resource_shares
            SET revoked_at = now(), revocation_reason = COALESCE(revocation_reason,'resource_retired')
          WHERE resource_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
        [resourceId, ctx.orgId],
      );
      return { ...rows[0], relationship: "owner" as const };
    },
  );
}

/** Separately authorized restoration. A retired record never returns implicitly. */
export async function restoreResource(
  token: string | null | undefined,
  orgId: string | null,
  input: { resourceId: string; readinessStatus?: string | null },
  meta?: RequestMeta,
): Promise<ResourceView> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  const status = input.readinessStatus
    ? assertOneOf(input.readinessStatus, READINESS_STATUSES, "readiness status")
    : ("unavailable" as ReadinessStatus);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.restore",
      action: "resource.restored",
      resourceType: "resource",
      resourceId,
      detail: { status },
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      if (current.lifecycleStatus !== "retired") throw new AccessError("invalid_input");
      if (!statusAllowedForCategory(current.category, status)) {
        throw new AccessError("invalid_status_for_category");
      }
      const rows = await q.query<ResourceRow>(
        `UPDATE airs.resources
            SET lifecycle_status = 'active', readiness_status = $2, restored_at = now(),
                restored_by_account = $3, updated_by_account = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND org_id = $4
          RETURNING ${COLUMNS.replaceAll("r.", "")}`,
        [resourceId, status, ctx.accountId, ctx.orgId],
      );
      return { ...rows[0], relationship: "owner" as const };
    },
  );
}

// --- category detail ----------------------------------------------------------

const DETAIL_FIELDS: Record<string, { column: string; kind: "text" | "bool" | "int" | "array" }[]> =
  {
    aircraft: [
      { column: "manufacturer", kind: "text" },
      { column: "model", kind: "text" },
      { column: "serial_number", kind: "text" },
      { column: "faa_registration", kind: "text" },
      { column: "remote_id", kind: "text" },
      { column: "aircraft_type", kind: "text" },
      { column: "thermal_capable", kind: "bool" },
      { column: "parachute_equipped", kind: "bool" },
      { column: "dock_compatible", kind: "bool" },
      { column: "max_approved_altitude_ft", kind: "int" },
      { column: "maintenance_status", kind: "text" },
      { column: "battery_readiness", kind: "text" },
      { column: "service_status", kind: "text" },
    ],
    vehicle: [
      { column: "vehicle_identifier", kind: "text" },
      { column: "vehicle_type", kind: "text" },
      { column: "assigned_unit", kind: "text" },
      { column: "supported_equipment", kind: "array" },
      { column: "service_status", kind: "text" },
      { column: "restricted_notes", kind: "text" },
    ],
    dock: [
      { column: "dock_name", kind: "text" },
      { column: "manufacturer", kind: "text" },
      { column: "model", kind: "text" },
      { column: "supported_aircraft_type", kind: "text" },
      { column: "connectivity_status", kind: "text" },
      { column: "power_status", kind: "text" },
      { column: "service_status", kind: "text" },
      { column: "restricted_notes", kind: "text" },
    ],
    launch_site: [
      { column: "site_name", kind: "text" },
      { column: "location_description", kind: "text" },
      { column: "owning_organization", kind: "text" },
      { column: "operational_limitations", kind: "text" },
      { column: "supported_categories", kind: "array" },
      { column: "service_status", kind: "text" },
      { column: "restricted_notes", kind: "text" },
    ],
    sensor: [
      { column: "sensor_category", kind: "text" },
      { column: "manufacturer", kind: "text" },
      { column: "model", kind: "text" },
      { column: "agency_identifier", kind: "text" },
      { column: "mounting", kind: "text" },
      { column: "detection_category", kind: "text" },
      { column: "connectivity_status", kind: "text" },
      { column: "maintenance_status", kind: "text" },
      { column: "service_status", kind: "text" },
      { column: "restricted_notes", kind: "text" },
    ],
  };

/**
 * Upserts the category-specific detail row. Only the columns declared above are
 * writable — there is no generic "accept arbitrary fields" endpoint.
 */
export async function saveResourceDetail(
  token: string | null | undefined,
  orgId: string | null,
  input: { resourceId: string; detail: DetailRecord },
  meta?: RequestMeta,
): Promise<DetailRecord> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.update",
      action: "resource.detail_updated",
      resourceType: "resource",
      resourceId,
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      if (current.lifecycleStatus === "retired") throw new AccessError("resource_retired");
      const kind = detailKindFor(current.category);
      const table = DETAIL_TABLES[kind];
      const fields = DETAIL_FIELDS[kind];

      const columns: string[] = [];
      const values: unknown[] = [];
      for (const field of fields) {
        if (!(field.column in input.detail)) continue;
        const raw = input.detail[field.column];
        let value: unknown = null;
        if (raw != null && raw !== "") {
          if (field.kind === "bool") value = raw === true || raw === "true";
          else if (field.kind === "int") {
            const n = Number(raw);
            if (!Number.isInteger(n)) throw new AccessError("invalid_input", field.column);
            value = n;
          } else if (field.kind === "array") {
            const arr = Array.isArray(raw) ? raw : String(raw).split(",");
            value = arr.map((v) => String(v).trim()).filter(Boolean).slice(0, 25);
          } else {
            value = text(raw, field.column, 400);
          }
        }
        if (field.column === "sensor_category" && value != null) {
          value = assertOneOf(value, SENSOR_CATEGORIES, "sensor category");
        }
        columns.push(field.column);
        values.push(value);
      }
      if (columns.length === 0) throw new AccessError("invalid_input", "no detail fields supplied");

      const placeholders = columns.map((_, i) => `$${i + 3}`);
      const updates = columns.map((c, i) => `${c} = $${i + 3}`);
      const rows = await q.query<DetailRecord>(
        `INSERT INTO airs.${table} (resource_id, org_id, ${columns.join(", ")})
         VALUES ($1, $2, ${placeholders.join(", ")})
         ON CONFLICT (resource_id) DO UPDATE SET ${updates.join(", ")}
         RETURNING *`,
        [resourceId, ctx.orgId, ...values],
      );
      return rows[0];
    },
  );
}

// --- sharing ------------------------------------------------------------------

export interface ShareRow {
  id: string;
  resourceId: string;
  orgId: string;
  incidentId: string;
  classification: SharingClassification;
  sharedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

const SHARE_COLUMNS = `
  s.id, s.resource_id AS "resourceId", s.org_id AS "orgId", s.incident_id AS "incidentId",
  s.classification, to_json(s.shared_at)#>>'{}' AS "sharedAt",
  to_json(s.expires_at)#>>'{}' AS "expiresAt", to_json(s.revoked_at)#>>'{}' AS "revokedAt",
  s.revocation_reason AS "revocationReason"
`;

export async function shareResource(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    resourceId: string;
    incidentId: string;
    classification?: string | null;
    expiresAt?: string | null;
    namedRecipientOrgIds?: string[] | null;
  },
  meta?: RequestMeta,
): Promise<ShareRow> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  const incidentId = assertUuid(input.incidentId, "incident id");
  const classification = input.classification
    ? assertOneOf(input.classification, SHARING_CLASSIFICATIONS, "classification")
    : "participating_orgs";
  const expiresAt = timestamp(input.expiresAt, "expiry");
  const named = (input.namedRecipientOrgIds ?? []).map((v) => assertUuid(v, "recipient org id"));

  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.share",
      action: "resource.shared",
      resourceType: "resource",
      resourceId,
      detail: { incidentId, classification },
      meta,
    },
    async (ctx, q) => {
      const current = await fetchResource(q, resourceId);
      assertOwner(ctx, current);
      if (current.lifecycleStatus === "retired") throw new AccessError("resource_retired");

      // The room must exist, be owned or actively participated in, and be open.
      const room = await q.query<{ status: string }>(
        `SELECT status FROM airs.incident_rooms WHERE id = $1`,
        [incidentId],
      );
      if (!room[0]) throw new AccessError("incident_not_found");
      if (["closed", "archived", "closing"].includes(room[0].status)) {
        throw new AccessError("incident_closed");
      }

      const rows = await q.query<ShareRow>(
        `INSERT INTO airs.resource_shares
           (resource_id, org_id, incident_id, classification, named_recipient_org_ids,
            shared_by_account, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (resource_id, incident_id) DO UPDATE
           SET classification = EXCLUDED.classification,
               named_recipient_org_ids = EXCLUDED.named_recipient_org_ids,
               expires_at = EXCLUDED.expires_at,
               shared_by_account = EXCLUDED.shared_by_account,
               revoked_at = NULL, revocation_reason = NULL
           WHERE airs.resource_shares.revoked_at IS NULL
         RETURNING ${SHARE_COLUMNS.replaceAll("s.", "")}`,
        [resourceId, ctx.orgId, incidentId, classification, named, ctx.accountId, expiresAt],
      );
      if (!rows[0]) throw new AccessError("share_revoked");
      return rows[0];
    },
  );
}

export async function revokeResourceShare(
  token: string | null | undefined,
  orgId: string | null,
  input: { resourceId: string; incidentId: string; reason?: string | null },
  meta?: RequestMeta,
): Promise<ShareRow> {
  const resourceId = assertUuid(input.resourceId, "resource id");
  const incidentId = assertUuid(input.incidentId, "incident id");
  const reason = text(input.reason, "reason", 500);
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.revoke_share",
      action: "resource.share_revoked",
      resourceType: "resource",
      resourceId,
      detail: { incidentId, reason },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<ShareRow>(
        `UPDATE airs.resource_shares
            SET revoked_at = now(), revoked_by_account = $3,
                revocation_reason = COALESCE($4, 'revoked_by_owner')
          WHERE resource_id = $1 AND incident_id = $2 AND org_id = $5 AND revoked_at IS NULL
          RETURNING ${SHARE_COLUMNS.replaceAll("s.", "")}`,
        [resourceId, incidentId, ctx.accountId, reason, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("share_not_found");
      return rows[0];
    },
  );
}

export async function listResourceShares(
  token: string | null | undefined,
  orgId: string | null,
  resourceId: string,
  meta?: RequestMeta,
): Promise<ShareRow[]> {
  const id = assertUuid(resourceId, "resource id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "resource.share_list",
      resourceType: "resource",
      resourceId: id,
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<ShareRow>(
        `SELECT ${SHARE_COLUMNS} FROM airs.resource_shares s
          WHERE s.resource_id = $1 AND s.org_id = $2 ORDER BY s.shared_at DESC`,
        [id, ctx.orgId],
      ),
  );
}

/** Readiness roll-up that answers the dashboard questions in one round trip. */
export async function readinessSummary(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<{
  byStatus: { status: string; count: number }[];
  byCategory: { category: string; count: number }[];
  personnel: { availabilityStatus: string; count: number }[];
  qualifications: { current: number; expired: number };
  assignments: { status: string; count: number }[];
  sharedIn: number;
}> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "resource.dashboard",
      resourceType: "resource",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const [byStatus, byCategory, personnel, quals, assignments, shared] = await Promise.all([
        q.query<{ status: string; count: number }>(
          `SELECT readiness_status AS status, count(*)::int FROM airs.resources
            WHERE org_id = $1 GROUP BY 1 ORDER BY 1`,
          [ctx.orgId],
        ),
        q.query<{ category: string; count: number }>(
          `SELECT category, count(*)::int FROM airs.resources
            WHERE org_id = $1 AND lifecycle_status = 'active' GROUP BY 1 ORDER BY 1`,
          [ctx.orgId],
        ),
        q.query<{ availabilityStatus: string; count: number }>(
          `SELECT availability_status AS "availabilityStatus", count(*)::int
             FROM airs.personnel_profiles WHERE org_id = $1 GROUP BY 1 ORDER BY 1`,
          [ctx.orgId],
        ),
        q.query<{ current: number; expired: number }>(
          `SELECT
             count(*) FILTER (WHERE airs.qualification_is_current(q.*))::int AS current,
             count(*) FILTER (WHERE NOT airs.qualification_is_current(q.*))::int AS expired
             FROM airs.qualifications q WHERE q.org_id = $1`,
          [ctx.orgId],
        ),
        q.query<{ status: string; count: number }>(
          `SELECT status, count(*)::int FROM airs.incident_assignments
            WHERE org_id = $1 GROUP BY 1 ORDER BY 1`,
          [ctx.orgId],
        ),
        q.query<{ count: number }>(
          `SELECT count(*)::int FROM airs.resource_shares
            WHERE org_id = $1 AND revoked_at IS NULL`,
          [ctx.orgId],
        ),
      ]);
      return {
        byStatus,
        byCategory,
        personnel,
        qualifications: quals[0] ?? { current: 0, expired: 0 },
        assignments,
        sharedIn: shared[0]?.count ?? 0,
      };
    },
  );
}
