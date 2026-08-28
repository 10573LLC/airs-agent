import { recordAudit } from "@/lib/audit.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { withIncidentAction } from "./incidents.server";

export const ICS_COMMAND_MODES = ["single", "unified"] as const;
export const ICS_POSITION_TYPES = [
  "incident_command", "command_staff", "operations", "planning", "logistics", "finance_admin",
  "branch", "division", "group", "unit", "staging_area", "other",
] as const;
export const ICS_OBJECTIVE_STATUSES = ["active", "completed", "cancelled"] as const;
export const RESOURCE_REQUEST_KINDS = [
  "personnel", "law_enforcement", "fire_ems", "aviation", "uas", "counter_uas",
  "communications", "public_works", "medical", "logistics", "specialty_team", "other",
] as const;
export const RESOURCE_REQUEST_PRIORITIES = ["immediate", "high", "routine"] as const;
export const RESOURCE_REQUEST_STATUSES = [
  "draft", "requested", "acknowledged", "partially_filled", "filled", "denied", "cancelled",
] as const;

export interface IcsProfile {
  incidentId: string; commandMode: string; incidentCommander: string; commandPostName: string;
  commandPostDescription: string; operationalPeriodStart: string | null; operationalPeriodEnd: string | null;
  situationSummary: string; safetyMessage: string; version: number; updatedAt: string;
}
export interface IcsObjective {
  id: string; incidentId: string; sequenceNo: number; objective: string; status: string;
  operationalPeriodLabel: string | null; createdAt: string; updatedAt: string;
}
export interface IcsPosition {
  id: string; incidentId: string; parentId: string | null; positionType: string; label: string;
  leaderName: string; agencyName: string; status: string; createdAt: string; updatedAt: string;
}
export interface IncidentResourceRequest {
  id: string; incidentId: string; requestNumber: string; requestedBy: string; requestedFrom: string;
  resourceKind: string; quantity: number; description: string; priority: string; status: string;
  neededAt: string | null; stagingLocation: string; notes: string; createdAt: string; updatedAt: string;
}
export interface IcsBoard {
  profile: IcsProfile | null;
  objectives: IcsObjective[];
  positions: IcsPosition[];
  requests: IncidentResourceRequest[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, label: string, max: number, required = false) => {
  if (value == null || value === "") { if (required) throw new AccessError("invalid_input", `${label} is required`); return ""; }
  if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
  const v = value.trim();
  if (required && !v) throw new AccessError("invalid_input", `${label} is required`);
  if (v.length > max) throw new AccessError("invalid_input", `${label} is too long`);
  return v;
};
const oneOf = <T extends string>(value: string, allowed: readonly T[], label: string): T => {
  if (!(allowed as readonly string[]).includes(value)) throw new AccessError("invalid_input", `invalid ${label}`);
  return value as T;
};
const maybeTime = (value: string | null | undefined, label: string) => {
  if (!value) return null;
  if (Number.isNaN(Date.parse(value))) throw new AccessError("invalid_input", `invalid ${label}`);
  return new Date(value).toISOString();
};
const assertUuid = (value: string, label: string) => {
  if (!UUID.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
  return value;
};

async function audit(q: any, ctx: any, incidentId: string, action: string, detail: Record<string, unknown>) {
  await recordAudit(q, {
    orgId: ctx.orgId, actorUserId: ctx.userId, action, resourceType: "incident_room",
    resourceId: incidentId, outcome: "allow", detail,
    ipAddress: ctx.meta.ipAddress ?? null, correlationId: ctx.meta.correlationId ?? null,
  });
}

export async function readIcsBoard(token: string | null, orgId: string | null, incidentId: string, meta: RequestMeta): Promise<IcsBoard> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "read", meta, audit: false },
    async (_ctx, q) => {
      const profile = await q.query<IcsProfile>(`SELECT incident_id AS "incidentId", command_mode AS "commandMode",
        incident_commander AS "incidentCommander", command_post_name AS "commandPostName",
        command_post_description AS "commandPostDescription", to_json(operational_period_start)#>>'{}' AS "operationalPeriodStart",
        to_json(operational_period_end)#>>'{}' AS "operationalPeriodEnd", situation_summary AS "situationSummary",
        safety_message AS "safetyMessage", version, to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_ics_profiles WHERE incident_id=$1`, [incidentId]);
      const objectives = await q.query<IcsObjective>(`SELECT id, incident_id AS "incidentId", sequence_no AS "sequenceNo",
        objective, status, operational_period_label AS "operationalPeriodLabel",
        to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_ics_objectives WHERE incident_id=$1 ORDER BY sequence_no, created_at`, [incidentId]);
      const positions = await q.query<IcsPosition>(`SELECT id, incident_id AS "incidentId", parent_id AS "parentId",
        position_type AS "positionType", label, leader_name AS "leaderName", agency_name AS "agencyName", status,
        to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_ics_positions WHERE incident_id=$1 ORDER BY created_at`, [incidentId]);
      const requests = await q.query<IncidentResourceRequest>(`SELECT id, incident_id AS "incidentId", request_number AS "requestNumber",
        requested_by AS "requestedBy", requested_from AS "requestedFrom", resource_kind AS "resourceKind", quantity,
        description, priority, status, to_json(needed_at)#>>'{}' AS "neededAt", staging_location AS "stagingLocation",
        notes, to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_resource_requests WHERE incident_id=$1 ORDER BY created_at DESC`, [incidentId]);
      return { profile: profile[0] ?? null, objectives, positions, requests };
    },
  );
}

export interface SaveIcsProfileInput {
  commandMode: string; incidentCommander?: string; commandPostName?: string; commandPostDescription?: string;
  operationalPeriodStart?: string | null; operationalPeriodEnd?: string | null;
  situationSummary?: string; safetyMessage?: string;
}

export async function saveIcsProfile(token: string | null, orgId: string | null, incidentId: string, input: SaveIcsProfileInput, meta: RequestMeta): Promise<IcsProfile> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const mode = oneOf(input.commandMode, ICS_COMMAND_MODES, "command mode");
      const start = maybeTime(input.operationalPeriodStart, "operational period start");
      const end = maybeTime(input.operationalPeriodEnd, "operational period end");
      if (start && end && Date.parse(end) <= Date.parse(start)) throw new AccessError("invalid_input", "operational period end must follow start");
      const rows = await q.query<IcsProfile>(`INSERT INTO airs.incident_ics_profiles
        (incident_id, org_id, command_mode, incident_commander, command_post_name, command_post_description,
         operational_period_start, operational_period_end, situation_summary, safety_message, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
        ON CONFLICT (incident_id) DO UPDATE SET command_mode=EXCLUDED.command_mode,
          incident_commander=EXCLUDED.incident_commander, command_post_name=EXCLUDED.command_post_name,
          command_post_description=EXCLUDED.command_post_description, operational_period_start=EXCLUDED.operational_period_start,
          operational_period_end=EXCLUDED.operational_period_end, situation_summary=EXCLUDED.situation_summary,
          safety_message=EXCLUDED.safety_message, updated_by_account=EXCLUDED.updated_by_account,
          version=airs.incident_ics_profiles.version+1
        RETURNING incident_id AS "incidentId", command_mode AS "commandMode", incident_commander AS "incidentCommander",
          command_post_name AS "commandPostName", command_post_description AS "commandPostDescription",
          to_json(operational_period_start)#>>'{}' AS "operationalPeriodStart", to_json(operational_period_end)#>>'{}' AS "operationalPeriodEnd",
          situation_summary AS "situationSummary", safety_message AS "safetyMessage", version, to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, mode, text(input.incidentCommander, "incident commander", 200),
         text(input.commandPostName, "command post name", 200), text(input.commandPostDescription, "command post description", 500),
         start, end, text(input.situationSummary, "situation summary", 4000), text(input.safetyMessage, "safety message", 2000), ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.ics.profile.update", { command_mode: mode });
      return rows[0];
    },
  );
}
export async function addIcsObjective(token: string | null, orgId: string | null, incidentId: string, input: { sequenceNo?: number; objective: string; operationalPeriodLabel?: string | null }, meta: RequestMeta): Promise<IcsObjective> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const sequence = Math.max(1, Math.min(999, Math.trunc(input.sequenceNo ?? 1)));
      const rows = await q.query<IcsObjective>(`INSERT INTO airs.incident_ics_objectives
        (incident_id, org_id, sequence_no, objective, operational_period_label, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$6)
        RETURNING id, incident_id AS "incidentId", sequence_no AS "sequenceNo", objective, status,
          operational_period_label AS "operationalPeriodLabel", to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, sequence, text(input.objective, "objective", 1000, true),
         text(input.operationalPeriodLabel, "operational period label", 120) || null, ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.ics.objective.create", { objective_id: rows[0].id, sequence_no: sequence });
      return rows[0];
    },
  );
}

export async function setIcsObjectiveStatus(token: string | null, orgId: string | null, incidentId: string, input: { objectiveId: string; status: string }, meta: RequestMeta): Promise<IcsObjective> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const status = oneOf(input.status, ICS_OBJECTIVE_STATUSES, "objective status");
      const rows = await q.query<IcsObjective>(`UPDATE airs.incident_ics_objectives SET status=$3, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2 RETURNING id, incident_id AS "incidentId", sequence_no AS "sequenceNo",
        objective, status, operational_period_label AS "operationalPeriodLabel",
        to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.objectiveId, "objective id"), incidentId, status, ctx.accountId]);
      if (!rows[0]) throw new AccessError("ics_objective_not_found");
      await audit(q, ctx, incidentId, "incident.ics.objective.status", { objective_id: input.objectiveId, status });
      return rows[0];
    },
  );
}
export async function addIcsPosition(token: string | null, orgId: string | null, incidentId: string, input: { parentId?: string | null; positionType: string; label: string; leaderName?: string; agencyName?: string }, meta: RequestMeta): Promise<IcsPosition> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const positionType = oneOf(input.positionType, ICS_POSITION_TYPES, "ICS position type");
      const parentId = input.parentId ? assertUuid(input.parentId, "parent id") : null;
      if (parentId) {
        const parent = await q.query<{ id: string }>(`SELECT id FROM airs.incident_ics_positions WHERE id=$1 AND incident_id=$2`, [parentId, incidentId]);
        if (!parent[0]) throw new AccessError("invalid_input", "parent position is not in this incident");
      }
      const rows = await q.query<IcsPosition>(`INSERT INTO airs.incident_ics_positions
        (incident_id, org_id, parent_id, position_type, label, leader_name, agency_name, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        RETURNING id, incident_id AS "incidentId", parent_id AS "parentId", position_type AS "positionType",
          label, leader_name AS "leaderName", agency_name AS "agencyName", status,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, parentId, positionType, text(input.label, "ICS position label", 160, true),
         text(input.leaderName, "leader name", 200), text(input.agencyName, "agency name", 200), ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.ics.position.create", { position_id: rows[0].id, position_type: positionType });
      return rows[0];
    },
  );
}

export async function setIcsPositionStatus(token: string | null, orgId: string | null, incidentId: string, input: { positionId: string; status: string }, meta: RequestMeta): Promise<IcsPosition> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const status = oneOf(input.status, ["active", "inactive", "completed"] as const, "ICS position status");
      const rows = await q.query<IcsPosition>(`UPDATE airs.incident_ics_positions SET status=$3, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2 RETURNING id, incident_id AS "incidentId", parent_id AS "parentId", position_type AS "positionType",
          label, leader_name AS "leaderName", agency_name AS "agencyName", status,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.positionId, "position id"), incidentId, status, ctx.accountId]);
      if (!rows[0]) throw new AccessError("ics_position_not_found");
      await audit(q, ctx, incidentId, "incident.ics.position.status", { position_id: input.positionId, status });
      return rows[0];
    },
  );
}
export async function addIncidentResourceRequest(token: string | null, orgId: string | null, incidentId: string, input: { requestedBy?: string; requestedFrom?: string; resourceKind: string; quantity?: number; description: string; priority?: string; neededAt?: string | null; stagingLocation?: string; notes?: string }, meta: RequestMeta): Promise<IncidentResourceRequest> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const kind = oneOf(input.resourceKind, RESOURCE_REQUEST_KINDS, "resource request kind");
      const priority = oneOf(input.priority ?? "routine", RESOURCE_REQUEST_PRIORITIES, "resource request priority");
      const quantity = Math.max(1, Math.min(9999, Math.trunc(input.quantity ?? 1)));
      const requestNumber = `REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const rows = await q.query<IncidentResourceRequest>(`INSERT INTO airs.incident_resource_requests
        (incident_id, org_id, request_number, requested_by, requested_from, resource_kind, quantity, description,
         priority, needed_at, staging_location, notes, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING id, incident_id AS "incidentId", request_number AS "requestNumber", requested_by AS "requestedBy",
          requested_from AS "requestedFrom", resource_kind AS "resourceKind", quantity, description, priority, status,
          to_json(needed_at)#>>'{}' AS "neededAt", staging_location AS "stagingLocation", notes,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, requestNumber, text(input.requestedBy, "requested by", 200),
         text(input.requestedFrom, "requested from", 200), kind, quantity, text(input.description, "request description", 1500, true),
         priority, maybeTime(input.neededAt, "needed at"), text(input.stagingLocation, "staging location", 300),
         text(input.notes, "request notes", 1500), ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.resource_request.create", { request_id: rows[0].id, request_number: requestNumber, resource_kind: kind, quantity });
      return rows[0];
    },
  );
}

export async function setIncidentResourceRequestStatus(token: string | null, orgId: string | null, incidentId: string, input: { requestId: string; status: string }, meta: RequestMeta): Promise<IncidentResourceRequest> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const status = oneOf(input.status, RESOURCE_REQUEST_STATUSES, "resource request status");
      const rows = await q.query<IncidentResourceRequest>(`UPDATE airs.incident_resource_requests SET status=$3, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2 RETURNING id, incident_id AS "incidentId", request_number AS "requestNumber",
          requested_by AS "requestedBy", requested_from AS "requestedFrom", resource_kind AS "resourceKind", quantity,
          description, priority, status, to_json(needed_at)#>>'{}' AS "neededAt", staging_location AS "stagingLocation", notes,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.requestId, "request id"), incidentId, status, ctx.accountId]);
      if (!rows[0]) throw new AccessError("resource_request_not_found");
      await audit(q, ctx, incidentId, "incident.resource_request.status", { request_id: input.requestId, status });
      return rows[0];
    },
  );
}
