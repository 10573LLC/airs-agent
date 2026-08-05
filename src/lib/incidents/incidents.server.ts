// Incident Room Lifecycle — server-side services.
//
// Every exported function runs through withAuthorized(), which enforces:
//   session -> account -> active membership -> organization role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
//
// This module adds the incident plane on top of that chain:
//   incident existence -> originating/participating relationship
//   -> live incident-level access -> lifecycle-state validation -> action.
//
// Nothing here trusts a client-supplied organization id, owner id, access
// level, participation status or lifecycle status.
import { recordAudit } from "@/lib/audit.server";
import { withAuthorized, type AuthorizedContext } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import type { QueryRunner } from "@/lib/adapters/types";

import {
  ACTION_PERMISSION,
  CLASSIFICATIONS,
  EDITABLE_STATUSES,
  INCIDENT_TYPES,
  OWNER_ONLY_ACTIONS,
  SHARE_RULES,
  canTransition,
  incidentLevelAllows,
  type AccessLevel,
  type Classification,
  type IncidentAction,
  type IncidentRelationship,
  type IncidentStatus,
  type IncidentType,
  type ShareRule,
} from "./lifecycle";

export interface IncidentRoom {
  id: string;
  orgId: string;
  orgName?: string | null;
  name: string;
  incidentType: IncidentType;
  description: string;
  externalNumber: string | null;
  geographicDescription: string | null;
  status: IncidentStatus;
  classification: Classification;
  defaultShareRule: ShareRule;
  tempDataRetentionHours: number;
  scheduledStartAt: string | null;
  scheduledExpiresAt: string | null;
  activatedAt: string | null;
  closingStartedAt: string | null;
  closedAt: string | null;
  closureReason: string | null;
  archivedAt: string | null;
  tempDataExpiresAt: string | null;
  dataExpiredAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const ROOM_COLUMNS = `
  r.id, r.org_id AS "orgId", r.name, r.incident_type AS "incidentType", r.description,
  r.external_number AS "externalNumber", r.geographic_description AS "geographicDescription",
  r.status, r.classification, r.default_share_rule AS "defaultShareRule",
  r.temp_data_retention_hours AS "tempDataRetentionHours",
  to_json(r.scheduled_start_at)#>>'{}' AS "scheduledStartAt",
  to_json(r.scheduled_expires_at)#>>'{}' AS "scheduledExpiresAt",
  to_json(r.activated_at)#>>'{}' AS "activatedAt",
  to_json(r.closing_started_at)#>>'{}' AS "closingStartedAt",
  to_json(r.closed_at)#>>'{}' AS "closedAt",
  r.closure_reason AS "closureReason",
  to_json(r.archived_at)#>>'{}' AS "archivedAt",
  to_json(r.temp_data_expires_at)#>>'{}' AS "tempDataExpiresAt",
  to_json(r.data_expired_at)#>>'{}' AS "dataExpiredAt",
  r.version, to_json(r.created_at)#>>'{}' AS "createdAt", to_json(r.updated_at)#>>'{}' AS "updatedAt"
`;

// --- input guards ------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
  return value;
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return value as T;
}

function text(value: unknown, label: string, max: number, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new AccessError("invalid_input", `${label} is required`);
    return null;
  }
  if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    throw new AccessError("invalid_input", `${label} is required`);
  }
  if (trimmed.length > max) throw new AccessError("invalid_input", `${label} is too long`);
  return trimmed;
}

function timestamp(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AccessError("invalid_input", `invalid ${label}`);
  }
  return new Date(value).toISOString();
}

// --- incident access resolution ----------------------------------------------

export interface IncidentAccess {
  incident: IncidentRoom;
  relationship: IncidentRelationship;
  participantId: string | null;
}

/**
 * Resolves the acting organization's relationship to an incident room.
 * RLS already hides rooms the organization may not see; this adds the explicit
 * relationship + liveness check so a denial is auditable rather than an empty
 * result, and so a restricted participant is demoted to view-only.
 */
async function resolveIncidentAccess(
  q: QueryRunner,
  ctx: AuthorizedContext,
  incidentId: string,
): Promise<IncidentAccess> {
  assertUuid(incidentId, "incident id");
  const rows = await q.query<IncidentRoom>(
    `SELECT ${ROOM_COLUMNS} FROM airs.incident_rooms r WHERE r.id = $1`,
    [incidentId],
  );
  const incident = rows[0];
  if (!incident) throw new AccessError("incident_not_found");

  if (incident.orgId === ctx.orgId) {
    return { incident, relationship: "origin_admin", participantId: null };
  }

  const part = await q.query<{
    id: string;
    accessLevel: AccessLevel;
    invitationStatus: string;
    participationStatus: string;
    expired: boolean;
  }>(
    `SELECT p.id, p.access_level AS "accessLevel", p.invitation_status AS "invitationStatus",
            p.participation_status AS "participationStatus",
            (p.expires_at IS NOT NULL AND p.expires_at <= now()) AS expired
       FROM airs.incident_participants p
      WHERE p.incident_id = $1 AND p.partner_org_id = $2`,
    [incidentId, ctx.orgId],
  );
  const row = part[0];
  if (!row) throw new AccessError("forbidden");
  if (incident.status === "closed" || incident.status === "archived") {
    throw new AccessError("participation_inactive");
  }
  if (row.invitationStatus !== "accepted" || row.expired) {
    throw new AccessError("participation_inactive");
  }
  if (row.participationStatus !== "active" && row.participationStatus !== "restricted") {
    throw new AccessError("participation_inactive");
  }
  // A restricted participant keeps presence but drops to view-only.
  const relationship: IncidentRelationship =
    row.participationStatus === "restricted" ? "view_only" : row.accessLevel;
  return { incident, relationship, participantId: row.id };
}

interface IncidentActionOptions {
  token: string | null;
  orgId: string | null;
  incidentId: string;
  action: IncidentAction;
  meta: RequestMeta;
  detail?: Record<string, unknown>;
  /** Set false when the service writes its own richer lifecycle audit event. */
  audit?: boolean;
}

/** The full protected chain for one incident action. */
export async function withIncidentAction<T>(
  opts: IncidentActionOptions,
  fn: (ctx: AuthorizedContext, q: QueryRunner, access: IncidentAccess) => Promise<T>,
): Promise<T> {
  return withAuthorized(
    {
      token: opts.token,
      orgId: opts.orgId,
      permission: ACTION_PERMISSION[opts.action],
      action: `incident.${opts.action}`,
      resourceType: "incident_room",
      resourceId: opts.incidentId,
      detail: opts.detail,
      audit: opts.audit,
      meta: opts.meta,
    },
    async (ctx, q) => {
      const access = await resolveIncidentAccess(q, ctx, opts.incidentId);
      if (
        access.relationship !== "origin_admin" &&
        OWNER_ONLY_ACTIONS.includes(opts.action)
      ) {
        throw new AccessError("forbidden");
      }
      if (!incidentLevelAllows(access.relationship, opts.action)) {
        throw new AccessError("forbidden");
      }
      return fn(ctx, q, access);
    },
  );
}

/** Lifecycle audit event carrying prior/new state and the affected target. */
async function auditLifecycle(
  q: QueryRunner,
  ctx: AuthorizedContext,
  input: {
    action: string;
    incidentId: string;
    priorState?: string | null;
    newState?: string | null;
    targetOrgId?: string | null;
    participantId?: string | null;
    extra?: Record<string, unknown>;
  },
) {
  await recordAudit(q, {
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    action: input.action,
    resourceType: "incident_room",
    resourceId: input.incidentId,
    outcome: "allow",
    detail: {
      actor_org_id: ctx.orgId,
      incident_id: input.incidentId,
      prior_state: input.priorState ?? null,
      new_state: input.newState ?? null,
      target_org_id: input.targetOrgId ?? null,
      participant_id: input.participantId ?? null,
      ...(input.extra ?? {}),
    },
    ipAddress: ctx.meta.ipAddress ?? null,
    correlationId: ctx.meta.correlationId ?? null,
  });
}

// --- creation, read, list -----------------------------------------------------

export interface CreateIncidentInput {
  name: string;
  incidentType: string;
  description?: string | null;
  externalNumber?: string | null;
  geographicDescription?: string | null;
  classification?: string | null;
  defaultShareRule?: string | null;
  scheduledStartAt?: string | null;
  scheduledExpiresAt?: string | null;
  tempDataRetentionHours?: number | null;
}

export async function createIncident(
  token: string | null,
  orgId: string | null,
  input: CreateIncidentInput,
  meta: RequestMeta,
): Promise<IncidentRoom> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "incident.create",
      action: "incident.create",
      resourceType: "incident_room",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      const name = text(input.name, "name", 200, true)!;
      const incidentType = assertOneOf(String(input.incidentType), INCIDENT_TYPES, "incident type");
      const classification = assertOneOf(
        String(input.classification ?? "restricted"),
        CLASSIFICATIONS,
        "classification",
      );
      const shareRule = assertOneOf(
        String(input.defaultShareRule ?? "no_sharing"),
        SHARE_RULES,
        "share rule",
      );
      const retention = Number(input.tempDataRetentionHours ?? 72);
      if (!Number.isInteger(retention) || retention < 1 || retention > 8760) {
        throw new AccessError("invalid_input", "invalid retention window");
      }
      // org_id is taken from the validated server-side context ONLY: any owner
      // id supplied by the browser is ignored by construction.
      const rows = await q.query<IncidentRoom>(
        `INSERT INTO airs.incident_rooms
           (org_id, name, incident_type, description, external_number, geographic_description,
            classification, default_share_rule, temp_data_retention_hours,
            scheduled_start_at, scheduled_expires_at, created_by_account, updated_by_account)
         VALUES ($1,$2,$3,coalesce($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING ${ROOM_COLUMNS.replace(/r\./g, "")}`,
        [
          ctx.orgId,
          name,
          incidentType,
          text(input.description, "description", 4000),
          text(input.externalNumber, "external number", 120),
          text(input.geographicDescription, "geographic description", 500),
          classification,
          shareRule,
          retention,
          timestamp(input.scheduledStartAt, "scheduled start"),
          timestamp(input.scheduledExpiresAt, "scheduled expiration"),
          ctx.accountId,
        ],
      );
      const incident = rows[0]!;
      await auditLifecycle(q, ctx, {
        action: "incident.created",
        incidentId: incident.id,
        newState: incident.status,
        extra: { incident_type: incidentType, classification },
      });
      return incident;
    },
  );
}

export interface IncidentListRow extends IncidentRoom {
  relationship: "origin" | "partner";
  accessLevel: AccessLevel | null;
}

export async function listIncidents(
  token: string | null,
  orgId: string | null,
  meta: RequestMeta,
): Promise<IncidentListRow[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "incident.read",
      action: "incident.list",
      resourceType: "incident_room",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<IncidentListRow>(
        `SELECT ${ROOM_COLUMNS},
                CASE WHEN r.org_id = $1 THEN 'origin' ELSE 'partner' END AS relationship,
                p.access_level AS "accessLevel"
           FROM airs.incident_rooms r
           LEFT JOIN airs.incident_participants p
             ON p.incident_id = r.id AND p.partner_org_id = $1
          ORDER BY r.created_at DESC`,
        [ctx.orgId],
      ),
  );
}

export async function readIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  meta: RequestMeta,
): Promise<IncidentAccess> {
  return withIncidentAction(
    { token, orgId, incidentId, action: "read", meta, audit: false },
    async (_ctx, _q, access) => access,
  );
}

// --- metadata update (explicit allow-list, never arbitrary fields) -----------

export interface UpdateIncidentInput {
  expectedVersion: number;
  name?: string | null;
  description?: string | null;
  externalNumber?: string | null;
  geographicDescription?: string | null;
  classification?: string | null;
  defaultShareRule?: string | null;
  tempDataRetentionHours?: number | null;
}

export async function updateIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  input: UpdateIncidentInput,
  meta: RequestMeta,
): Promise<IncidentRoom> {
  return withIncidentAction(
    { token, orgId, incidentId, action: "update", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (!EDITABLE_STATUSES.includes(incident.status)) {
        throw new AccessError("incident_state_invalid");
      }
      if (Number(input.expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      const next = {
        name: input.name == null ? incident.name : text(input.name, "name", 200, true)!,
        description:
          input.description == null
            ? incident.description
            : (text(input.description, "description", 4000) ?? ""),
        externalNumber:
          input.externalNumber === undefined
            ? incident.externalNumber
            : text(input.externalNumber, "external number", 120),
        geographicDescription:
          input.geographicDescription === undefined
            ? incident.geographicDescription
            : text(input.geographicDescription, "geographic description", 500),
        classification:
          input.classification == null
            ? incident.classification
            : assertOneOf(String(input.classification), CLASSIFICATIONS, "classification"),
        defaultShareRule:
          input.defaultShareRule == null
            ? incident.defaultShareRule
            : assertOneOf(String(input.defaultShareRule), SHARE_RULES, "share rule"),
        tempDataRetentionHours:
          input.tempDataRetentionHours == null
            ? incident.tempDataRetentionHours
            : Number(input.tempDataRetentionHours),
      };
      if (
        !Number.isInteger(next.tempDataRetentionHours) ||
        next.tempDataRetentionHours < 1 ||
        next.tempDataRetentionHours > 8760
      ) {
        throw new AccessError("invalid_input", "invalid retention window");
      }
      const rows = await q.query<IncidentRoom>(
        `UPDATE airs.incident_rooms r
            SET name = $2, description = $3, external_number = $4, geographic_description = $5,
                classification = $6, default_share_rule = $7, temp_data_retention_hours = $8,
                updated_by_account = $9, updated_at = now(), version = version + 1
          WHERE r.id = $1 AND r.version = $10
        RETURNING ${ROOM_COLUMNS}`,
        [
          incidentId,
          next.name,
          next.description,
          next.externalNumber,
          next.geographicDescription,
          next.classification,
          next.defaultShareRule,
          next.tempDataRetentionHours,
          ctx.accountId,
          incident.version,
        ],
      );
      const updated = rows[0];
      if (!updated) throw new AccessError("incident_stale_version");
      await auditLifecycle(q, ctx, {
        action: "incident.updated",
        incidentId,
        priorState: incident.status,
        newState: updated.status,
        extra: { from_version: incident.version, to_version: updated.version },
      });
      return updated;
    },
  );
}

// --- lifecycle transitions ----------------------------------------------------

async function transition(
  ctx: AuthorizedContext,
  q: QueryRunner,
  incident: IncidentRoom,
  to: IncidentStatus,
  auditAction: string,
  extraSql = "",
  extraParams: unknown[] = [],
  extra?: Record<string, unknown>,
): Promise<IncidentRoom> {
  if (!canTransition(incident.status, to)) {
    await recordAudit(q, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: "incident.invalid_transition",
      resourceType: "incident_room",
      resourceId: incident.id,
      outcome: "deny",
      detail: { prior_state: incident.status, new_state: to, actor_org_id: ctx.orgId },
      ipAddress: ctx.meta.ipAddress ?? null,
      correlationId: ctx.meta.correlationId ?? null,
    });
    throw new AccessError("incident_state_invalid");
  }
  const rows = await q.query<IncidentRoom>(
    `UPDATE airs.incident_rooms r
        SET status = $2, updated_by_account = $3, updated_at = now(), version = version + 1
            ${extraSql}
      WHERE r.id = $1 AND r.version = $4
    RETURNING ${ROOM_COLUMNS}`,
    [incident.id, to, ctx.accountId, incident.version, ...extraParams],
  );
  const updated = rows[0];
  if (!updated) throw new AccessError("incident_stale_version");
  await auditLifecycle(q, ctx, {
    action: auditAction,
    incidentId: incident.id,
    priorState: incident.status,
    newState: to,
    extra,
  });
  return updated;
}

export async function scheduleIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  input: { startAt: string; expiresAt?: string | null; expectedVersion: number },
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "schedule", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(input.expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      const startAt = timestamp(input.startAt, "scheduled start");
      if (!startAt) throw new AccessError("invalid_input", "scheduled start is required");
      const expiresAt = timestamp(input.expiresAt, "scheduled expiration");
      if (expiresAt && Date.parse(expiresAt) <= Date.parse(startAt)) {
        throw new AccessError("invalid_input", "expiration must follow the start");
      }
      return transition(
        ctx,
        q,
        incident,
        "scheduled",
        "incident.scheduled",
        ", scheduled_start_at = $5, scheduled_expires_at = $6",
        [startAt, expiresAt],
        { scheduled_start_at: startAt, scheduled_expires_at: expiresAt },
      );
    },
  );
}

export async function activateIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  expectedVersion: number,
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "activate", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      const hours = incident.tempDataRetentionHours;
      return transition(
        ctx,
        q,
        incident,
        "active",
        "incident.activated",
        `, activated_at = coalesce(activated_at, now()),
           temp_data_expires_at = coalesce(temp_data_expires_at, now() + ($5 || ' hours')::interval)`,
        [String(hours)],
      );
    },
  );
}

export async function pauseIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  expectedVersion: number,
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "pause", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      return transition(ctx, q, incident, "paused", "incident.paused");
    },
  );
}

export async function resumeIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  expectedVersion: number,
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "resume", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      return transition(ctx, q, incident, "active", "incident.resumed");
    },
  );
}

export async function beginClosure(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  input: { reason: string; expectedVersion: number },
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "begin_closure", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(input.expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      const reason = text(input.reason, "closure reason", 1000, true)!;
      const room = await transition(
        ctx,
        q,
        incident,
        "closing",
        "incident.closure_started",
        ", closing_started_at = now(), closure_reason = $5",
        [reason],
        { closure_reason: reason },
      );
      // Step 1 of the closure workflow: pending invitations expire immediately.
      const expired = await q.query<{ id: string; partner: string }>(
        `UPDATE airs.incident_participants
            SET invitation_status = 'expired', participation_status = 'expired',
                token_hash = NULL, updated_at = now()
          WHERE incident_id = $1 AND invitation_status = 'pending'
        RETURNING id, partner_org_id AS partner`,
        [incidentId],
      );
      for (const row of expired) {
        await auditLifecycle(q, ctx, {
          action: "incident.invitation_expired",
          incidentId,
          targetOrgId: row.partner,
          participantId: row.id,
          priorState: "pending",
          newState: "expired",
        });
      }
      return room;
    },
  );
}

export async function closeIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  input: { reason?: string | null; expectedVersion: number },
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "close", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(input.expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      const reason =
        text(input.reason, "closure reason", 1000) ?? incident.closureReason ?? null;
      if (!reason) throw new AccessError("invalid_input", "closure reason is required");

      // Every live partner grant ends, and every pending invitation expires,
      // inside the same transaction as the status change.
      const revoked = await q.query<{ id: string; partner: string; prior: string }>(
        `UPDATE airs.incident_participants
            SET participation_status = 'revoked', revoked_at = now(),
                token_hash = NULL, reason = coalesce(reason, 'incident closed'),
                updated_at = now()
          WHERE incident_id = $1
            AND participation_status IN ('active','restricted','suspended','pending_approval','invited')
        RETURNING id, partner_org_id AS partner, participation_status AS prior`,
        [incidentId],
      );
      const expired = await q.query<{ id: string; partner: string }>(
        `UPDATE airs.incident_participants
            SET invitation_status = 'expired', token_hash = NULL, updated_at = now()
          WHERE incident_id = $1 AND invitation_status = 'pending'
        RETURNING id, partner_org_id AS partner`,
        [incidentId],
      );
      // Stage 7: closing a room also ends its geography. Operating areas are
      // completed, incident map features are archived and every temporary
      // position is superseded — in this same transaction, so a partner can
      // never observe a closed room that still carries live coordinates.
      const geography = await q.query<{
        areas_completed: number;
        features_archived: number;
        positions_expired: number;
      }>(`SELECT * FROM airs.terminate_incident_geography($1)`, [incidentId]);
      const geo = geography[0] ?? {
        areas_completed: 0,
        features_archived: 0,
        positions_expired: 0,
      };
      const room = await transition(
        ctx,
        q,
        incident,
        "closed",
        "incident.closed",
        `, closed_at = now(), closure_reason = $5, closed_by_account = $3,
           temp_data_expires_at = now() + (temp_data_retention_hours || ' hours')::interval`,
        [reason],
        {
          closure_reason: reason,
          revoked_participants: revoked.length,
          expired_invitations: expired.length,
        },
      );
      for (const row of revoked) {
        await auditLifecycle(q, ctx, {
          action: "incident.participant_revoked",
          incidentId,
          targetOrgId: row.partner,
          participantId: row.id,
          priorState: row.prior,
          newState: "revoked",
          extra: { cause: "incident_closed" },
        });
      }
      return room;
    },
  );
}

export async function archiveIncident(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  expectedVersion: number,
  meta: RequestMeta,
) {
  return withIncidentAction(
    { token, orgId, incidentId, action: "archive", meta, audit: false },
    async (ctx, q, { incident }) => {
      if (Number(expectedVersion) !== incident.version) {
        throw new AccessError("incident_stale_version");
      }
      return transition(
        ctx,
        q,
        incident,
        "archived",
        "incident.archived",
        ", archived_at = now()",
      );
    },
  );
}

// --- lifecycle audit history --------------------------------------------------

export interface LifecycleAuditRow {
  id: string;
  action: string;
  outcome: string;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string | null;
  /** Serialized JSON: kept as text so the RPC boundary stays plain-serializable. */
  detail: string;
}

export async function readIncidentAudit(
  token: string | null,
  orgId: string | null,
  incidentId: string,
  meta: RequestMeta,
): Promise<LifecycleAuditRow[]> {
  return withIncidentAction(
    { token, orgId, incidentId, action: "read_audit", meta, audit: false },
    async (_ctx, q) =>
      q.query<LifecycleAuditRow>(
        `SELECT a.id::text AS id, a.action, a.outcome,
                to_json(a.occurred_at)#>>'{}' AS "occurredAt",
                a.actor_user_id AS "actorUserId", u.display_name AS "actorName",
                a.detail::text AS detail
           FROM airs.audit_events a
           LEFT JOIN airs.users u ON u.id = a.actor_user_id
          WHERE a.resource_type = 'incident_room' AND a.resource_id = $1
          ORDER BY a.occurred_at DESC, a.id DESC
          LIMIT 200`,
        [incidentId],
      ),
  );
}