import { recordAudit } from "@/lib/audit.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { withIncidentAction } from "./incidents.server";

export const ICS_COMMAND_MODES = ["single", "unified"] as const;
export const ICS_OPERATIONAL_CONDITIONS = ["nominal", "elevated", "emergency", "recovery"] as const;
export const COORDINATION_CONNECTION_MODES = ["airs", "external_liaison", "emergency_communications", "radio", "phone", "email", "other"] as const;
export const COORDINATION_PARTNER_STATES = ["planned", "invited", "confirmed", "on_scene", "active", "released", "cancelled"] as const;
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
  situationSummary: string; safetyMessage: string; operationalCondition: string; version: number; updatedAt: string;
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
export interface IncidentCoordinationPartner {
  id: string; incidentId: string; partnerOrgId: string | null; organizationName: string; operationalRole: string;
  commandPostRole: string; connectionMode: string; participationState: string; primaryContact: string; notes: string;
  plannedFrom: string | null; plannedTo: string | null; createdAt: string; updatedAt: string;
}
export interface IncidentAuthority {
  id: string; incidentId: string; domain: string; authorityHolder: string; authorityType: string;
  geographicScope: string; functionalScope: string; basisType: string; basisReference: string; sourceReference: string;
  status: string; limitations: string; confidence: string; effectiveFrom: string; effectiveTo: string | null; updatedAt: string;
}
export interface IncidentThreatHypothesis {
  id: string; incidentId: string; hypothesisType: string; title: string; status: string; confidence: string;
  rationale: string; indicators: string[]; protectiveImplications: string; sourceBasis: string; lastAssessedAt: string; updatedAt: string;
}
export interface IcsBoard {
  profile: IcsProfile | null; objectives: IcsObjective[]; positions: IcsPosition[]; requests: IncidentResourceRequest[];
  coordinationPartners: IncidentCoordinationPartner[]; authorities: IncidentAuthority[]; threatHypotheses: IncidentThreatHypothesis[];
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
        safety_message AS "safetyMessage", operational_condition AS "operationalCondition", version, to_json(updated_at)#>>'{}' AS "updatedAt"
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
      const coordinationPartners = await q.query<IncidentCoordinationPartner>(`SELECT id, incident_id AS "incidentId", partner_org_id AS "partnerOrgId",
        organization_name AS "organizationName", operational_role AS "operationalRole", command_post_role AS "commandPostRole",
        connection_mode AS "connectionMode", participation_state AS "participationState", primary_contact AS "primaryContact", notes,
        to_json(planned_from)#>>'{}' AS "plannedFrom", to_json(planned_to)#>>'{}' AS "plannedTo",
        to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_coordination_partners WHERE incident_id=$1 ORDER BY participation_state, organization_name`, [incidentId]);
      const authorities = await q.query<IncidentAuthority>(`SELECT id, incident_id AS "incidentId", domain, authority_holder AS "authorityHolder",
        authority_type AS "authorityType", geographic_scope AS "geographicScope", functional_scope AS "functionalScope", basis_type AS "basisType",
        basis_reference AS "basisReference", source_reference AS "sourceReference", status, limitations, confidence,
        to_json(effective_from)#>>'{}' AS "effectiveFrom", to_json(effective_to)#>>'{}' AS "effectiveTo", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_authorities WHERE incident_id=$1 ORDER BY status, domain, created_at`, [incidentId]);
      const threatHypotheses = await q.query<IncidentThreatHypothesis>(`SELECT id, incident_id AS "incidentId", hypothesis_type AS "hypothesisType",
        title, status, confidence, rationale, indicators, protective_implications AS "protectiveImplications", source_basis AS "sourceBasis",
        to_json(last_assessed_at)#>>'{}' AS "lastAssessedAt", to_json(updated_at)#>>'{}' AS "updatedAt"
        FROM airs.incident_threat_hypotheses WHERE incident_id=$1 ORDER BY status, updated_at DESC`, [incidentId]);
      return { profile: profile[0] ?? null, objectives, positions, requests, coordinationPartners, authorities, threatHypotheses };
    },
  );
}

export interface SaveIcsProfileInput {
  commandMode: string; incidentCommander?: string; commandPostName?: string; commandPostDescription?: string;
  operationalPeriodStart?: string | null; operationalPeriodEnd?: string | null;
  situationSummary?: string; safetyMessage?: string; operationalCondition?: string;
}

export async function saveIcsProfile(token: string | null, orgId: string | null, incidentId: string, input: SaveIcsProfileInput, meta: RequestMeta): Promise<IcsProfile> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const mode = oneOf(input.commandMode, ICS_COMMAND_MODES, "command mode");
      const operationalCondition = oneOf(input.operationalCondition ?? "nominal", ICS_OPERATIONAL_CONDITIONS, "operational condition");
      const start = maybeTime(input.operationalPeriodStart, "operational period start");
      const end = maybeTime(input.operationalPeriodEnd, "operational period end");
      if (start && end && Date.parse(end) <= Date.parse(start)) throw new AccessError("invalid_input", "operational period end must follow start");
      const rows = await q.query<IcsProfile>(`INSERT INTO airs.incident_ics_profiles
        (incident_id, org_id, command_mode, incident_commander, command_post_name, command_post_description,
         operational_period_start, operational_period_end, situation_summary, safety_message, operational_condition, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        ON CONFLICT (incident_id) DO UPDATE SET command_mode=EXCLUDED.command_mode,
          incident_commander=EXCLUDED.incident_commander, command_post_name=EXCLUDED.command_post_name,
          command_post_description=EXCLUDED.command_post_description, operational_period_start=EXCLUDED.operational_period_start,
          operational_period_end=EXCLUDED.operational_period_end, situation_summary=EXCLUDED.situation_summary,
          safety_message=EXCLUDED.safety_message, operational_condition=EXCLUDED.operational_condition, updated_by_account=EXCLUDED.updated_by_account,
          version=airs.incident_ics_profiles.version+1
        RETURNING incident_id AS "incidentId", command_mode AS "commandMode", incident_commander AS "incidentCommander",
          command_post_name AS "commandPostName", command_post_description AS "commandPostDescription",
          to_json(operational_period_start)#>>'{}' AS "operationalPeriodStart", to_json(operational_period_end)#>>'{}' AS "operationalPeriodEnd",
          situation_summary AS "situationSummary", safety_message AS "safetyMessage", operational_condition AS "operationalCondition", version, to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, mode, text(input.incidentCommander, "incident commander", 200),
         text(input.commandPostName, "command post name", 200), text(input.commandPostDescription, "command post description", 500),
         start, end, text(input.situationSummary, "situation summary", 4000), text(input.safetyMessage, "safety message", 2000), operationalCondition, ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.ics.profile.update", { command_mode: mode, operational_condition: operationalCondition });
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


export async function addCoordinationPartner(
  token: string | null, orgId: string | null, incidentId: string,
  input: { partnerOrgId?: string | null; organizationName: string; operationalRole?: string; commandPostRole?: string;
    connectionMode?: string; participationState?: string; primaryContact?: string; notes?: string;
    plannedFrom?: string | null; plannedTo?: string | null }, meta: RequestMeta,
): Promise<IncidentCoordinationPartner> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const connectionMode = oneOf(input.connectionMode ?? "external_liaison", COORDINATION_CONNECTION_MODES, "coordination connection mode");
      const participationState = oneOf(input.participationState ?? "planned", COORDINATION_PARTNER_STATES, "coordination partner state");
      const plannedFrom = maybeTime(input.plannedFrom, "planned from");
      const plannedTo = maybeTime(input.plannedTo, "planned to");
      if (plannedFrom && plannedTo && Date.parse(plannedTo) <= Date.parse(plannedFrom)) throw new AccessError("invalid_input", "planned end must follow planned start");
      const rows = await q.query<IncidentCoordinationPartner>(`INSERT INTO airs.incident_coordination_partners
        (incident_id, org_id, partner_org_id, organization_name, operational_role, command_post_role,
         connection_mode, participation_state, primary_contact, notes, planned_from, planned_to,
         created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING id, incident_id AS "incidentId", partner_org_id AS "partnerOrgId", organization_name AS "organizationName",
          operational_role AS "operationalRole", command_post_role AS "commandPostRole", connection_mode AS "connectionMode",
          participation_state AS "participationState", primary_contact AS "primaryContact", notes,
          to_json(planned_from)#>>'{}' AS "plannedFrom", to_json(planned_to)#>>'{}' AS "plannedTo",
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, input.partnerOrgId ? assertUuid(input.partnerOrgId, "partner org id") : null,
         text(input.organizationName, "organization name", 240, true), text(input.operationalRole, "operational role", 500),
         text(input.commandPostRole, "command post role", 300), connectionMode, participationState,
         text(input.primaryContact, "primary contact", 240), text(input.notes, "coordination notes", 2000),
         plannedFrom, plannedTo, ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.coordination_partner.create", { coordination_partner_id: rows[0].id, organization_name: rows[0].organizationName, connection_mode: connectionMode, participation_state: participationState });
      return rows[0];
    },
  );
}


export async function setCoordinationPartnerState(
  token: string | null, orgId: string | null, incidentId: string,
  input: { coordinationPartnerId: string; participationState: string }, meta: RequestMeta,
): Promise<IncidentCoordinationPartner> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const participationState = oneOf(input.participationState, COORDINATION_PARTNER_STATES, "coordination partner state");
      const rows = await q.query<IncidentCoordinationPartner>(`UPDATE airs.incident_coordination_partners
        SET participation_state=$3, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2
        RETURNING id, incident_id AS "incidentId", partner_org_id AS "partnerOrgId", organization_name AS "organizationName",
          operational_role AS "operationalRole", command_post_role AS "commandPostRole", connection_mode AS "connectionMode",
          participation_state AS "participationState", primary_contact AS "primaryContact", notes,
          to_json(planned_from)#>>'{}' AS "plannedFrom", to_json(planned_to)#>>'{}' AS "plannedTo",
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.coordinationPartnerId, "coordination partner id"), incidentId, participationState, ctx.accountId]);
      if (!rows[0]) throw new AccessError("invalid_input", "coordination partner not found");
      await audit(q, ctx, incidentId, "incident.coordination_partner.status", { coordination_partner_id: input.coordinationPartnerId, participation_state: participationState });
      return rows[0];
    },
  );
}

export const AUTHORITY_TYPES = [
  "jurisdictional","regulatory","functional","command","investigative","protective","delegated","supporting",
] as const;
export const AUTHORITY_BASIS_TYPES = ["baseline","incident_confirmed","claimed","delegated","unresolved"] as const;
export const AUTHORITY_STATUSES = ["active","disputed","superseded","ended"] as const;
export const AUTHORITY_CONFIDENCE = ["confirmed","probable","reported","unresolved"] as const;
export const THREAT_HYPOTHESIS_TYPES = [
  "secondary_assault","follow_on_uas","responder_targeting","coordinated_attack","explosive_hazard","cbrne","other",
] as const;
export const THREAT_HYPOTHESIS_STATUSES = ["open","supported","reduced","ruled_out","confirmed"] as const;
export const THREAT_CONFIDENCE = ["unknown","low","medium","high"] as const;

export async function addIncidentAuthority(
  token: string | null, orgId: string | null, incidentId: string,
  input: { domain: string; authorityHolder: string; authorityType: string; geographicScope?: string; functionalScope?: string;
    basisType?: string; basisReference?: string; sourceReference?: string; limitations?: string; confidence?: string },
  meta: RequestMeta,
): Promise<IncidentAuthority> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const authorityType = oneOf(input.authorityType, AUTHORITY_TYPES, "authority type");
      const basisType = oneOf(input.basisType ?? "unresolved", AUTHORITY_BASIS_TYPES, "authority basis");
      const confidence = oneOf(input.confidence ?? "reported", AUTHORITY_CONFIDENCE, "authority confidence");
      const rows = await q.query<IncidentAuthority>(`INSERT INTO airs.incident_authorities
        (incident_id, org_id, domain, authority_holder, authority_type, geographic_scope, functional_scope,
         basis_type, basis_reference, source_reference, limitations, confidence, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING id, incident_id AS "incidentId", domain, authority_holder AS "authorityHolder",
          authority_type AS "authorityType", geographic_scope AS "geographicScope", functional_scope AS "functionalScope",
          basis_type AS "basisType", basis_reference AS "basisReference", source_reference AS "sourceReference",
          status, limitations, confidence, to_json(effective_from)#>>'{}' AS "effectiveFrom",
          to_json(effective_to)#>>'{}' AS "effectiveTo", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, text(input.domain, "authority domain", 160, true),
         text(input.authorityHolder, "authority holder", 240, true), authorityType,
         text(input.geographicScope, "geographic scope", 1000), text(input.functionalScope, "functional scope", 1000),
         basisType, text(input.basisReference, "basis reference", 1200), text(input.sourceReference, "source reference", 1200),
         text(input.limitations, "authority limitations", 2000), confidence, ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.authority.create", { authority_id: rows[0].id, domain: rows[0].domain, authority_type: authorityType, basis_type: basisType });
      return rows[0];
    },
  );
}

export async function setIncidentAuthorityStatus(token: string | null, orgId: string | null, incidentId: string,
  input: { authorityId: string; status: string }, meta: RequestMeta): Promise<IncidentAuthority> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const status = oneOf(input.status, AUTHORITY_STATUSES, "authority status");
      const rows = await q.query<IncidentAuthority>(`UPDATE airs.incident_authorities
        SET status=$3, effective_to=CASE WHEN $3='ended' THEN now() ELSE effective_to END, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2
        RETURNING id, incident_id AS "incidentId", domain, authority_holder AS "authorityHolder",
          authority_type AS "authorityType", geographic_scope AS "geographicScope", functional_scope AS "functionalScope",
          basis_type AS "basisType", basis_reference AS "basisReference", source_reference AS "sourceReference",
          status, limitations, confidence, to_json(effective_from)#>>'{}' AS "effectiveFrom",
          to_json(effective_to)#>>'{}' AS "effectiveTo", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.authorityId, "authority id"), incidentId, status, ctx.accountId]);
      if (!rows[0]) throw new AccessError("authority_record_not_found");
      await audit(q, ctx, incidentId, "incident.authority.status", { authority_id: input.authorityId, status });
      return rows[0];
    },
  );
}

export async function addThreatHypothesis(
  token: string | null, orgId: string | null, incidentId: string,
  input: { hypothesisType: string; title: string; confidence?: string; rationale?: string; indicators?: string[];
    protectiveImplications?: string; sourceBasis?: string }, meta: RequestMeta,
): Promise<IncidentThreatHypothesis> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q, access) => {
      const hypothesisType = oneOf(input.hypothesisType, THREAT_HYPOTHESIS_TYPES, "threat hypothesis type");
      const confidence = oneOf(input.confidence ?? "unknown", THREAT_CONFIDENCE, "threat confidence");
      const indicators = (input.indicators ?? []).slice(0, 20).map((v) => text(v, "indicator", 300, true));
      const rows = await q.query<IncidentThreatHypothesis>(`INSERT INTO airs.incident_threat_hypotheses
        (incident_id, org_id, hypothesis_type, title, confidence, rationale, indicators,
         protective_implications, source_basis, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        RETURNING id, incident_id AS "incidentId", hypothesis_type AS "hypothesisType", title, status, confidence,
          rationale, indicators, protective_implications AS "protectiveImplications", source_basis AS "sourceBasis",
          to_json(last_assessed_at)#>>'{}' AS "lastAssessedAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [incidentId, access.incident.orgId, hypothesisType, text(input.title, "hypothesis title", 240, true), confidence,
         text(input.rationale, "hypothesis rationale", 3000), indicators,
         text(input.protectiveImplications, "protective implications", 3000), text(input.sourceBasis, "source basis", 1600), ctx.accountId]);
      await audit(q, ctx, incidentId, "incident.threat_hypothesis.create", { hypothesis_id: rows[0].id, hypothesis_type: hypothesisType, confidence });
      return rows[0];
    },
  );
}

export async function setThreatHypothesisStatus(token: string | null, orgId: string | null, incidentId: string,
  input: { hypothesisId: string; status: string; confidence?: string }, meta: RequestMeta): Promise<IncidentThreatHypothesis> {
  return withIncidentAction(
    { token, orgId, incidentId: assertUuid(incidentId, "incident id"), action: "update", meta, audit: false },
    async (ctx, q) => {
      const status = oneOf(input.status, THREAT_HYPOTHESIS_STATUSES, "threat hypothesis status");
      const confidence = input.confidence ? oneOf(input.confidence, THREAT_CONFIDENCE, "threat confidence") : null;
      const rows = await q.query<IncidentThreatHypothesis>(`UPDATE airs.incident_threat_hypotheses
        SET status=$3, confidence=COALESCE($4, confidence), last_assessed_at=now(), updated_by_account=$5
        WHERE id=$1 AND incident_id=$2
        RETURNING id, incident_id AS "incidentId", hypothesis_type AS "hypothesisType", title, status, confidence,
          rationale, indicators, protective_implications AS "protectiveImplications", source_basis AS "sourceBasis",
          to_json(last_assessed_at)#>>'{}' AS "lastAssessedAt", to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [assertUuid(input.hypothesisId, "hypothesis id"), incidentId, status, confidence, ctx.accountId]);
      if (!rows[0]) throw new AccessError("threat_hypothesis_not_found");
      await audit(q, ctx, incidentId, "incident.threat_hypothesis.status", { hypothesis_id: input.hypothesisId, status, confidence });
      return rows[0];
    },
  );
}
