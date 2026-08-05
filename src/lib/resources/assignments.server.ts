// Incident resource and personnel assignments.
//
// An organization may assign ONLY records it owns, only into a room it can
// currently reach, and only while that room is open. Assignment never transfers
// ownership, custody, editing authority or the right to share onward.
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";

import {
  ACTIVE_ASSIGNMENT_STATUSES,
  ASSIGNMENT_STATUSES,
  OPERATIONAL_ROLES,
  SHARING_CLASSIFICATIONS,
} from "./model";
import { DISCLOSURE_PROFILES, resolveDisclosedFields, type DisclosureProfile } from "./disclosure";
import {
  assertCustomFieldKeys,
  assertDisclosureProfile,
  assertOneOf,
  assertUuid,
  text,
  timestamp,
} from "./resources.server";

export interface AssignmentRow {
  id: string;
  incidentId: string;
  orgId: string;
  assignmentType: "resource" | "person";
  resourceId: string | null;
  personId: string | null;
  label: string | null;
  assignedRole: string | null;
  status: string;
  startsAt?: string;
  endsAt: string | null;
  visibilityClassification: string;
  releaseReason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerOrgName?: string | null;
  disclosureProfile?: DisclosureProfile;
  disclosedFields?: string[];
  /** Currently valid qualification types. Aviation profile and above only. */
  currentQualifications?: string[];
}

const COLUMNS = `
  a.id, a.incident_id AS "incidentId", a.org_id AS "orgId",
  a.assignment_type AS "assignmentType", a.resource_id AS "resourceId",
  a.person_id AS "personId", a.assigned_role AS "assignedRole", a.status,
  to_json(a.starts_at)#>>'{}' AS "startsAt", to_json(a.ends_at)#>>'{}' AS "endsAt",
  a.visibility_classification AS "visibilityClassification",
  a.release_reason AS "releaseReason", to_json(a.released_at)#>>'{}' AS "releasedAt",
  to_json(a.created_at)#>>'{}' AS "createdAt", to_json(a.updated_at)#>>'{}' AS "updatedAt",
  a.disclosure_profile AS "disclosureProfile", a.custom_field_keys AS "customFieldKeys"
`;

/**
 * Field-level disclosure for an assignment owned by ANOTHER organization.
 * A partner sees the record exists (RLS already allowed the row) but only the
 * fields the originating organization's profile releases. Withheld properties
 * are deleted from the payload, never blanked.
 */
function discloseAssignment(
  row: AssignmentRow & {
    customFieldKeys?: string[] | null;
    currentQualifications?: string[] | null;
  },
): AssignmentRow {
  const profile = (DISCLOSURE_PROFILES as readonly string[]).includes(String(row.disclosureProfile))
    ? (row.disclosureProfile as DisclosureProfile)
    : "summary";
  const keys = new Set(
    resolveDisclosedFields({
      profile,
      customFieldKeys: row.customFieldKeys ?? [],
      owner: false,
    }),
  );
  const out: AssignmentRow = {
    id: row.id,
    incidentId: row.incidentId,
    orgId: row.orgId,
    assignmentType: row.assignmentType,
    resourceId: row.resourceId,
    personId: row.personId,
    label: keys.has("personDisplayName") || keys.has("displayName") ? row.label : null,
    assignedRole: keys.has("currentIncidentRole") ? row.assignedRole : null,
    status: keys.has("assignmentStatus") ? row.status : "shared",
    endsAt: keys.has("assignmentWindow") ? row.endsAt : null,
    visibilityClassification: row.visibilityClassification,
    releaseReason: null,
    releasedAt: row.releasedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ownerOrgName: row.ownerOrgName ?? null,
    disclosureProfile: profile,
    disclosedFields: [...keys],
  };
  if (keys.has("assignmentWindow")) out.startsAt = row.startsAt;
  // Aviation profile and above: which qualifications are CURRENT, nothing else.
  if (keys.has("qualificationType") && row.assignmentType === "person") {
    out.currentQualifications = row.currentQualifications ?? [];
  }
  return out;
}

/** Reads the room and refuses any write against a closed or archived one. */
async function assertOpenRoom(
  q: { query: <R>(sql: string, params?: unknown[]) => Promise<R[]> },
  incidentId: string,
): Promise<void> {
  const rows = await q.query<{ status: string }>(
    `SELECT status FROM airs.incident_rooms WHERE id = $1`,
    [incidentId],
  );
  if (!rows[0]) throw new AccessError("incident_not_found");
  if (["closed", "archived"].includes(rows[0].status)) throw new AccessError("incident_closed");
}

export async function listIncidentAssignments(
  token: string | null | undefined,
  orgId: string | null,
  incidentId: string,
  meta?: RequestMeta,
): Promise<AssignmentRow[]> {
  const inc = assertUuid(incidentId, "incident id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "assignment.list",
      resourceType: "assignment",
      resourceId: inc,
      audit: false,
      meta,
    },
    async (ctx, q) =>
      (
        await q.query<AssignmentRow & { customFieldKeys?: string[] | null }>(
          `SELECT ${COLUMNS},
                COALESCE(r.display_name, p.display_name) AS label,
                CASE WHEN a.assignment_type = 'person'
                     THEN airs.assignment_current_qualifications(a.id) END
                  AS "currentQualifications",
                CASE WHEN a.org_id = $2 THEN NULL ELSE airs.related_org_name(a.org_id) END
                  AS "ownerOrgName"
           FROM airs.incident_assignments a
           LEFT JOIN airs.resources r ON r.id = a.resource_id AND r.org_id = a.org_id
           LEFT JOIN airs.personnel_profiles p ON p.id = a.person_id AND p.org_id = a.org_id
          WHERE a.incident_id = $1
          ORDER BY a.created_at DESC`,
          [inc, ctx.orgId],
        )
      ).map((row) => (row.orgId === ctx.orgId ? row : discloseAssignment(row))),
  );
}

export async function assignToIncident(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    incidentId: string;
    assignmentType: string;
    resourceId?: string | null;
    personId?: string | null;
    assignedRole?: string | null;
    visibilityClassification?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    disclosureProfile?: string | null;
    customFieldKeys?: string[] | null;
  },
  meta?: RequestMeta,
): Promise<AssignmentRow> {
  const incidentId = assertUuid(input.incidentId, "incident id");
  const type = assertOneOf(
    input.assignmentType,
    ["resource", "person"] as const,
    "assignment type",
  );
  const resourceId =
    type === "resource" ? assertUuid(String(input.resourceId), "resource id") : null;
  const personId = type === "person" ? assertUuid(String(input.personId), "person id") : null;
  const role = input.assignedRole
    ? assertOneOf(input.assignedRole, OPERATIONAL_ROLES, "assigned role")
    : null;
  const visibility = input.visibilityClassification
    ? assertOneOf(input.visibilityClassification, SHARING_CLASSIFICATIONS, "visibility")
    : "participating_orgs";
  const profile = input.disclosureProfile
    ? assertDisclosureProfile(input.disclosureProfile)
    : ("summary" as DisclosureProfile);
  const customKeys = profile === "custom" ? assertCustomFieldKeys(input.customFieldKeys) : [];
  if (profile === "full") {
    throw new AccessError("invalid_input", "assignments cannot disclose the full record");
  }

  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.assign_incident",
      action: type === "resource" ? "assignment.resource_assigned" : "assignment.person_assigned",
      resourceType: "assignment",
      resourceId: resourceId ?? personId,
      detail: { incidentId, type, disclosureProfile: profile },
      meta,
    },
    async (ctx, q) => {
      await assertOpenRoom(q, incidentId);

      // Ownership is re-checked here even though RLS and a trigger both enforce
      // it, so an attempt to assign another agency's record is auditable.
      if (resourceId) {
        const owned = await q.query<{ lifecycleStatus: string }>(
          `SELECT lifecycle_status AS "lifecycleStatus" FROM airs.resources
            WHERE id = $1 AND org_id = $2`,
          [resourceId, ctx.orgId],
        );
        if (!owned[0]) throw new AccessError("tenant_mismatch");
        if (owned[0].lifecycleStatus === "retired") throw new AccessError("resource_retired");
      } else {
        const owned = await q.query<{ id: string }>(
          `SELECT id FROM airs.personnel_profiles WHERE id = $1 AND org_id = $2`,
          [personId, ctx.orgId],
        );
        if (!owned[0]) throw new AccessError("tenant_mismatch");
      }

      const rows = await q.query<AssignmentRow>(
        `INSERT INTO airs.incident_assignments
           (incident_id, org_id, assignment_type, resource_id, person_id, assigned_role,
            status, starts_at, ends_at, visibility_classification, assigned_by_account,
            disclosure_profile, custom_field_keys)
         VALUES ($1,$2,$3,$4,$5,$6,'assigned',COALESCE($7::timestamptz, now()),$8::timestamptz,
                 $9,$10,$11,$12)
         RETURNING ${COLUMNS.replaceAll("a.", "")}`,
        [
          incidentId,
          ctx.orgId,
          type,
          resourceId,
          personId,
          role,
          timestamp(input.startsAt, "start time"),
          timestamp(input.endsAt, "end time"),
          visibility,
          ctx.accountId,
          profile,
          customKeys,
        ],
      );
      return rows[0];
    },
  );
}

/** Release / complete / cancel. Takes effect immediately for every reader. */
export async function endAssignment(
  token: string | null | undefined,
  orgId: string | null,
  input: { assignmentId: string; status: string; reason?: string | null },
  meta?: RequestMeta,
): Promise<AssignmentRow> {
  const assignmentId = assertUuid(input.assignmentId, "assignment id");
  const status = assertOneOf(
    input.status,
    ["released", "completed", "cancelled"] as const,
    "status",
  );
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.release_incident",
      action: `assignment.${status}`,
      resourceType: "assignment",
      resourceId: assignmentId,
      detail: { reason: text(input.reason, "reason", 500) },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<AssignmentRow>(
        `UPDATE airs.incident_assignments
            SET status = $2, released_by_account = $3, released_at = now(),
                release_reason = COALESCE($4, release_reason)
          WHERE id = $1 AND org_id = $5 AND status NOT IN ('released','cancelled','completed')
          RETURNING ${COLUMNS.replaceAll("a.", "")}`,
        [assignmentId, status, ctx.accountId, text(input.reason, "reason", 500), ctx.orgId],
      );
      if (!rows[0]) {
        const exists = await q.query<{ status: string }>(
          `SELECT status FROM airs.incident_assignments WHERE id = $1 AND org_id = $2`,
          [assignmentId, ctx.orgId],
        );
        throw new AccessError(exists[0] ? "assignment_terminated" : "assignment_not_found");
      }
      return rows[0];
    },
  );
}

/** Progress an assignment through its active states (assigned -> deploying -> active). */
export async function setAssignmentStatus(
  token: string | null | undefined,
  orgId: string | null,
  input: { assignmentId: string; status: string },
  meta?: RequestMeta,
): Promise<AssignmentRow> {
  const assignmentId = assertUuid(input.assignmentId, "assignment id");
  const status = assertOneOf(input.status, ASSIGNMENT_STATUSES, "status");
  if (!ACTIVE_ASSIGNMENT_STATUSES.includes(status)) {
    throw new AccessError("invalid_input", "use endAssignment for terminal states");
  }
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.assign_incident",
      action: "assignment.status_changed",
      resourceType: "assignment",
      resourceId: assignmentId,
      detail: { status },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<AssignmentRow>(
        `UPDATE airs.incident_assignments SET status = $2
          WHERE id = $1 AND org_id = $3 AND status NOT IN ('released','cancelled','completed')
          RETURNING ${COLUMNS.replaceAll("a.", "")}`,
        [assignmentId, status, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("assignment_terminated");
      return rows[0];
    },
  );
}
