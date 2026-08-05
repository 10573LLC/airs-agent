// Personnel operational profiles, qualifications and shifts.
//
// These are OPERATIONAL readiness records, not HR records: no payroll, no home
// address, no identifiers of record, no medical, disciplinary or benefits data.
// Only an optional duty contact is stored, and it is owner-only on read.
//
// Same enforcement chain as every other protected service:
//   session -> account -> active membership -> role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";

import {
  AVAILABILITY_STATUSES,
  OPERATIONAL_ROLES,
  PERSONNEL_STATUSES,
  QUALIFICATION_TYPES,
  SHARING_CLASSIFICATIONS,
  SHIFT_STATUSES,
} from "./model";
import { assertOneOf, assertUuid, text, timestamp } from "./resources.server";

export interface PersonnelRow {
  id: string;
  orgId: string;
  userId: string | null;
  displayName: string;
  callsign: string | null;
  employeeIdentifier: string | null;
  operationalRoles: string[];
  availabilityStatus: string;
  qualificationSummary: string | null;
  operationalStatus: string;
  dutyContact: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const PERSON_COLUMNS = `
  p.id, p.org_id AS "orgId", p.user_id AS "userId", p.display_name AS "displayName",
  p.callsign, p.employee_identifier AS "employeeIdentifier",
  p.operational_roles AS "operationalRoles", p.availability_status AS "availabilityStatus",
  p.qualification_summary AS "qualificationSummary",
  p.operational_status AS "operationalStatus", p.duty_contact AS "dutyContact",
  p.version, to_json(p.created_at)#>>'{}' AS "createdAt",
  to_json(p.updated_at)#>>'{}' AS "updatedAt"
`;

// --- personnel ----------------------------------------------------------------

export async function listPersonnel(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<PersonnelRow[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "personnel.list",
      resourceType: "personnel",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<PersonnelRow>(
        `SELECT ${PERSON_COLUMNS} FROM airs.personnel_profiles p
          WHERE p.org_id = $1 ORDER BY p.display_name`,
        [ctx.orgId],
      ),
  );
}

/** Personnel currently on an uncancelled shift covering "now". */
export async function listWorkingPersonnel(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<(PersonnelRow & { shiftRole: string; shiftEndsAt: string })[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "personnel.list_working",
      resourceType: "personnel",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query(
        `SELECT ${PERSON_COLUMNS}, s.operational_role AS "shiftRole",
                to_json(s.ends_at)#>>'{}' AS "shiftEndsAt"
           FROM airs.personnel_profiles p
           JOIN airs.shifts s ON s.person_id = p.id
          WHERE p.org_id = $1 AND s.availability_status <> 'cancelled'
            AND s.starts_at <= now() AND s.ends_at > now()
          ORDER BY p.display_name`,
        [ctx.orgId],
      ),
  );
}

export async function upsertPersonnel(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    personId?: string | null;
    userId?: string | null;
    displayName: string;
    callsign?: string | null;
    employeeIdentifier?: string | null;
    operationalRoles?: string[] | null;
    availabilityStatus?: string | null;
    operationalStatus?: string | null;
    qualificationSummary?: string | null;
    dutyContact?: string | null;
  },
  meta?: RequestMeta,
): Promise<PersonnelRow> {
  const personId = input.personId ? assertUuid(input.personId, "person id") : null;
  const displayName = text(input.displayName, "display name", 160, true)!;
  const roles = (input.operationalRoles ?? []).map((r) =>
    assertOneOf(r, OPERATIONAL_ROLES, "operational role"),
  );
  const availability = input.availabilityStatus
    ? assertOneOf(input.availabilityStatus, AVAILABILITY_STATUSES, "availability")
    : "off_duty";
  const opStatus = input.operationalStatus
    ? assertOneOf(input.operationalStatus, PERSONNEL_STATUSES, "operational status")
    : "active";

  return withAuthorized(
    {
      token,
      orgId,
      permission: "personnel.readiness_manage",
      action: personId ? "personnel.updated" : "personnel.created",
      resourceType: "personnel",
      resourceId: personId,
      meta,
    },
    async (ctx, q) => {
      const params = [
        ctx.orgId,
        input.userId ? assertUuid(input.userId, "user id") : null,
        displayName,
        text(input.callsign, "callsign", 60),
        text(input.employeeIdentifier, "identifier", 60),
        roles,
        availability,
        opStatus,
        text(input.qualificationSummary, "summary", 500),
        text(input.dutyContact, "duty contact", 160),
        ctx.accountId,
      ];
      if (!personId) {
        const rows = await q.query<PersonnelRow>(
          `INSERT INTO airs.personnel_profiles
             (org_id, user_id, display_name, callsign, employee_identifier, operational_roles,
              availability_status, operational_status, qualification_summary, duty_contact,
              created_by_account, updated_by_account)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
           RETURNING ${PERSON_COLUMNS.replaceAll("p.", "")}`,
          params,
        );
        return rows[0];
      }
      const rows = await q.query<PersonnelRow>(
        `UPDATE airs.personnel_profiles SET
           display_name = $3, callsign = $4, employee_identifier = $5, operational_roles = $6,
           availability_status = $7, operational_status = $8, qualification_summary = $9,
           duty_contact = $10, updated_by_account = $11, updated_at = now(), version = version + 1
         WHERE id = $12 AND org_id = $1
         RETURNING ${PERSON_COLUMNS.replaceAll("p.", "")}`,
        [...params, personId],
      );
      if (!rows[0]) throw new AccessError("person_not_found");
      return rows[0];
    },
  );
}

export async function setPersonnelAvailability(
  token: string | null | undefined,
  orgId: string | null,
  input: { personId: string; availabilityStatus: string },
  meta?: RequestMeta,
): Promise<PersonnelRow> {
  const personId = assertUuid(input.personId, "person id");
  const availability = assertOneOf(input.availabilityStatus, AVAILABILITY_STATUSES, "availability");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "personnel.readiness_manage",
      action: "personnel.availability_changed",
      resourceType: "personnel",
      resourceId: personId,
      detail: { availability },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<PersonnelRow>(
        `UPDATE airs.personnel_profiles
            SET availability_status = $2, updated_by_account = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND org_id = $4
          RETURNING ${PERSON_COLUMNS.replaceAll("p.", "")}`,
        [personId, availability, ctx.accountId, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("person_not_found");
      return rows[0];
    },
  );
}

// --- qualifications -----------------------------------------------------------

export interface QualificationRow {
  id: string;
  orgId: string;
  personId: string;
  personName?: string;
  qualificationType: string;
  issuingOrganization: string | null;
  effectiveDate: string;
  expiresOn: string | null;
  verificationStatus: string;
  verifiedAt: string | null;
  restrictions: string | null;
  sharingClassification: string;
  status: string;
  revokedAt: string | null;
  isCurrent: boolean;
}

const QUAL_COLUMNS = `
  q.id, q.org_id AS "orgId", q.person_id AS "personId",
  q.qualification_type AS "qualificationType", q.issuing_organization AS "issuingOrganization",
  to_char(q.effective_date,'YYYY-MM-DD') AS "effectiveDate",
  to_char(q.expires_on,'YYYY-MM-DD') AS "expiresOn",
  q.verification_status AS "verificationStatus",
  to_json(q.verified_at)#>>'{}' AS "verifiedAt", q.restrictions,
  q.sharing_classification AS "sharingClassification", q.status,
  to_json(q.revoked_at)#>>'{}' AS "revokedAt",
  airs.qualification_is_current(q.*) AS "isCurrent"
`;

export async function listQualifications(
  token: string | null | undefined,
  orgId: string | null,
  personId?: string | null,
  meta?: RequestMeta,
): Promise<QualificationRow[]> {
  const person = personId ? assertUuid(personId, "person id") : null;
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "qualification.list",
      resourceType: "qualification",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<QualificationRow>(
        `SELECT ${QUAL_COLUMNS}, p.display_name AS "personName"
           FROM airs.qualifications q
           JOIN airs.personnel_profiles p ON p.id = q.person_id
          WHERE q.org_id = $1 AND ($2::uuid IS NULL OR q.person_id = $2)
          ORDER BY p.display_name, q.qualification_type`,
        [ctx.orgId, person],
      ),
  );
}

export async function addQualification(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    personId: string;
    qualificationType: string;
    issuingOrganization?: string | null;
    effectiveDate?: string | null;
    expiresOn?: string | null;
    restrictions?: string | null;
    sharingClassification?: string | null;
  },
  meta?: RequestMeta,
): Promise<QualificationRow> {
  const personId = assertUuid(input.personId, "person id");
  const type = assertOneOf(input.qualificationType, QUALIFICATION_TYPES, "qualification type");
  const date = (value: unknown, label: string): string | null => {
    if (value == null || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AccessError("invalid_input", `invalid ${label}`);
    }
    return value;
  };
  const effective = date(input.effectiveDate, "effective date");
  const expires = date(input.expiresOn, "expiry date");
  if (effective && expires && expires < effective) {
    throw new AccessError("invalid_input", "expiry precedes effective date");
  }
  const classification = input.sharingClassification
    ? assertOneOf(input.sharingClassification, SHARING_CLASSIFICATIONS, "classification")
    : "originating_org_only";

  return withAuthorized(
    {
      token,
      orgId,
      permission: "qualification.manage",
      action: "qualification.added",
      resourceType: "qualification",
      detail: { personId, type },
      meta,
    },
    async (ctx, q) => {
      const owner = await q.query<{ id: string }>(
        `SELECT id FROM airs.personnel_profiles WHERE id = $1 AND org_id = $2`,
        [personId, ctx.orgId],
      );
      if (!owner[0]) throw new AccessError("person_not_found");
      const rows = await q.query<QualificationRow>(
        `WITH inserted AS (
           INSERT INTO airs.qualifications
             (org_id, person_id, qualification_type, issuing_organization, effective_date,
              expires_on, restrictions, sharing_classification, status, created_by_account)
           VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6::date,$7,$8,'pending',$9)
           RETURNING *)
         SELECT ${QUAL_COLUMNS} FROM inserted q`,
        [
          ctx.orgId,
          personId,
          type,
          text(input.issuingOrganization, "issuer", 160),
          effective,
          expires,
          text(input.restrictions, "restrictions", 500),
          classification,
          ctx.accountId,
        ],
      );
      return rows[0];
    },
  );
}

export async function verifyQualification(
  token: string | null | undefined,
  orgId: string | null,
  input: { qualificationId: string },
  meta?: RequestMeta,
): Promise<QualificationRow> {
  const id = assertUuid(input.qualificationId, "qualification id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "qualification.verify",
      action: "qualification.verified",
      resourceType: "qualification",
      resourceId: id,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<QualificationRow>(
        `WITH updated AS (
           UPDATE airs.qualifications
              SET verification_status = 'verified', verified_by_account = $2, verified_at = now(),
                  status = CASE WHEN expires_on IS NOT NULL AND expires_on < current_date
                                THEN 'expired' ELSE 'active' END,
                  updated_at = now()
            WHERE id = $1 AND org_id = $3 AND revoked_at IS NULL
            RETURNING *)
         SELECT ${QUAL_COLUMNS} FROM updated q`,
        [id, ctx.accountId, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("qualification_not_found");
      return rows[0];
    },
  );
}

export async function revokeQualification(
  token: string | null | undefined,
  orgId: string | null,
  input: { qualificationId: string; reason?: string | null },
  meta?: RequestMeta,
): Promise<QualificationRow> {
  const id = assertUuid(input.qualificationId, "qualification id");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "qualification.revoke",
      action: "qualification.revoked",
      resourceType: "qualification",
      resourceId: id,
      detail: { reason: text(input.reason, "reason", 500) },
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<QualificationRow>(
        `WITH updated AS (
           UPDATE airs.qualifications
              SET status = 'revoked', revoked_at = now(), revoked_by_account = $2, updated_at = now()
            WHERE id = $1 AND org_id = $3
            RETURNING *)
         SELECT ${QUAL_COLUMNS} FROM updated q`,
        [id, ctx.accountId, ctx.orgId],
      );
      if (!rows[0]) throw new AccessError("qualification_not_found");
      return rows[0];
    },
  );
}

/** Marks every past-expiry qualification expired. Idempotent; audited per run. */
export async function processQualificationExpiry(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<{ expired: number }> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "qualification.manage",
      action: "qualification.expired",
      resourceType: "qualification",
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<{ id: string }>(
        `UPDATE airs.qualifications
            SET status = 'expired', updated_at = now()
          WHERE org_id = $1 AND status IN ('active','pending')
            AND expires_on IS NOT NULL AND expires_on < current_date
          RETURNING id`,
        [ctx.orgId],
      );
      return { expired: rows.length };
    },
  );
}

// --- shifts -------------------------------------------------------------------

export interface ShiftRow {
  id: string;
  orgId: string;
  personId: string;
  personName?: string;
  operationalRole: string;
  startsAt: string;
  endsAt: string;
  availabilityStatus: string;
  incidentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const SHIFT_COLUMNS = `
  s.id, s.org_id AS "orgId", s.person_id AS "personId",
  s.operational_role AS "operationalRole",
  to_json(s.starts_at)#>>'{}' AS "startsAt", to_json(s.ends_at)#>>'{}' AS "endsAt",
  s.availability_status AS "availabilityStatus", s.incident_id AS "incidentId",
  s.notes, to_json(s.created_at)#>>'{}' AS "createdAt",
  to_json(s.updated_at)#>>'{}' AS "updatedAt"
`;

export async function listShifts(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<ShiftRow[]> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "shift.list",
      resourceType: "shift",
      audit: false,
      meta,
    },
    async (ctx, q) =>
      q.query<ShiftRow>(
        `SELECT ${SHIFT_COLUMNS}, p.display_name AS "personName"
           FROM airs.shifts s JOIN airs.personnel_profiles p ON p.id = s.person_id
          WHERE s.org_id = $1 ORDER BY s.starts_at DESC LIMIT 200`,
        [ctx.orgId],
      ),
  );
}

export async function createShift(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    personId: string;
    operationalRole: string;
    startsAt: string;
    endsAt: string;
    availabilityStatus?: string | null;
    incidentId?: string | null;
    notes?: string | null;
  },
  meta?: RequestMeta,
): Promise<ShiftRow> {
  const personId = assertUuid(input.personId, "person id");
  const role = assertOneOf(input.operationalRole, OPERATIONAL_ROLES, "operational role");
  const startsAt = timestamp(input.startsAt, "start time");
  const endsAt = timestamp(input.endsAt, "end time");
  if (!startsAt || !endsAt) throw new AccessError("invalid_input", "shift window required");
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AccessError("invalid_input", "end time must follow start time");
  }
  const availability = input.availabilityStatus
    ? assertOneOf(input.availabilityStatus, SHIFT_STATUSES, "availability")
    : "scheduled";

  return withAuthorized(
    {
      token,
      orgId,
      permission: "personnel.schedule_manage",
      action: "shift.created",
      resourceType: "shift",
      detail: { personId, role },
      meta,
    },
    async (ctx, q) => {
      const person = await q.query<{ operationalStatus: string }>(
        `SELECT operational_status AS "operationalStatus"
           FROM airs.personnel_profiles WHERE id = $1 AND org_id = $2`,
        [personId, ctx.orgId],
      );
      if (!person[0]) throw new AccessError("person_not_found");
      if (["suspended", "inactive"].includes(person[0].operationalStatus)) {
        throw new AccessError("forbidden", "person cannot be scheduled");
      }
      try {
        const rows = await q.query<ShiftRow>(
          `INSERT INTO airs.shifts
             (org_id, person_id, operational_role, starts_at, ends_at, availability_status,
              incident_id, notes, created_by_account, updated_by_account)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           RETURNING ${SHIFT_COLUMNS.replaceAll("s.", "")}`,
          [
            ctx.orgId,
            personId,
            role,
            startsAt,
            endsAt,
            availability,
            input.incidentId ? assertUuid(input.incidentId, "incident id") : null,
            text(input.notes, "notes", 1000),
            ctx.accountId,
          ],
        );
        return rows[0];
      } catch (error) {
        if (String(error).includes("overlapping")) throw new AccessError("shift_conflict");
        throw error;
      }
    },
  );
}

export async function updateShift(
  token: string | null | undefined,
  orgId: string | null,
  input: {
    shiftId: string;
    availabilityStatus?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    notes?: string | null;
  },
  meta?: RequestMeta,
): Promise<ShiftRow> {
  const shiftId = assertUuid(input.shiftId, "shift id");
  const availability = input.availabilityStatus
    ? assertOneOf(input.availabilityStatus, SHIFT_STATUSES, "availability")
    : null;
  const startsAt = timestamp(input.startsAt, "start time");
  const endsAt = timestamp(input.endsAt, "end time");
  return withAuthorized(
    {
      token,
      orgId,
      permission: "personnel.schedule_manage",
      action: availability === "cancelled" ? "shift.cancelled" : "shift.updated",
      resourceType: "shift",
      resourceId: shiftId,
      meta,
    },
    async (ctx, q) => {
      const rows = await q.query<ShiftRow>(
        `UPDATE airs.shifts SET
           availability_status = COALESCE($2, availability_status),
           starts_at = COALESCE($3::timestamptz, starts_at),
           ends_at = COALESCE($4::timestamptz, ends_at),
           notes = COALESCE($5, notes),
           updated_by_account = $6, updated_at = now()
         WHERE id = $1 AND org_id = $7
         RETURNING ${SHIFT_COLUMNS.replaceAll("s.", "")}`,
        [
          shiftId,
          availability,
          startsAt,
          endsAt,
          text(input.notes, "notes", 1000),
          ctx.accountId,
          ctx.orgId,
        ],
      );
      if (!rows[0]) throw new AccessError("invalid_input", "shift not found");
      return rows[0];
    },
  );
}
