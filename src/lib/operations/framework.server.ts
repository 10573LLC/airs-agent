import { z } from "zod";
import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import { isAgencyOperationalRole } from "@/lib/rbac/module-access";
import type { QueryRunner } from "@/lib/adapters/types";
import {
  entityProfileSchema,
  sourceSchema,
  envelopeSchema,
  grantSchema,
  observationSchema,
  supplementalSchema,
  authorizeAcquisition,
  type Source,
  type Observation,
} from "./framework";

const uuid = z.string().uuid();
export const frameworkCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profile"), value: entityProfileSchema }),
  z.object({ action: z.literal("source"), value: sourceSchema }),
  z.object({
    action: z.literal("readiness"),
    value: z.object({
      id: uuid,
      health: z.enum(["identified", "configured", "verified", "unavailable"]),
      receipt: z.string().trim().min(1).max(2000),
    }),
  }),
  z.object({
    action: z.literal("preserve_evidence"),
    value: z.object({ id: uuid, policy: z.string().trim().min(1).max(2000) }),
  }),
  z.object({ action: z.literal("envelope"), value: envelopeSchema }),
  z.object({ action: z.literal("grant"), value: grantSchema }),
  z.object({ action: z.literal("report"), value: observationSchema }),
  z.object({ action: z.literal("supplemental"), value: supplementalSchema }),
  z.object({
    action: z.literal("revoke"),
    value: z.object({ id: uuid, kind: z.enum(["envelope", "grant"]) }),
  }),
  z.object({
    action: z.literal("revocation_receipt"),
    value: z.object({
      id: uuid,
      confirmed: z.boolean(),
      receipt: z.string().trim().min(1).max(2000),
    }),
  }),
  z.object({
    action: z.literal("correlate"),
    value: z.object({
      incidentId: uuid,
      observationIds: z.array(uuid).min(2).max(50),
      reason: z.string().trim().min(10).max(2000),
    }),
  }),
]);
export type FrameworkCommand = z.infer<typeof frameworkCommandSchema>;
type Room = { incidentType: string; status: string; retention: number };
async function activeRoom(q: QueryRunner, id: string): Promise<Room> {
  const rows = await q.query<Room>(
    `SELECT incident_type AS "incidentType",status,temp_data_retention_hours AS retention
    FROM airs.lock_framework_incident($1)`,
    [id],
  );
  if (!rows[0]) throw new AccessError("incident_state_invalid");
  return rows[0];
}
async function sourceFor(q: QueryRunner, id: string, orgId: string): Promise<Source> {
  const rows = await q.query<{
    id: string;
    orgId: string;
    profile: z.infer<typeof sourceSchema>;
    health: string;
  }>(
    `SELECT id,org_id AS "orgId",profile,health FROM airs.source_systems WHERE id=$1 AND org_id=$2 FOR SHARE`,
    [id, orgId],
  );
  if (!rows[0]) throw new AccessError("forbidden");
  return { ...rows[0].profile, id: rows[0].id, orgId, health: rows[0].health };
}
async function assertContribution(q: QueryRunner, incidentId: string, orgId: string) {
  const rows = await q.query(
    `SELECT id FROM airs.incident_rooms r WHERE r.id=$1 AND
    (r.org_id=$2 OR EXISTS(SELECT 1 FROM airs.incident_participants p WHERE p.incident_id=r.id AND p.partner_org_id=$2
      AND p.invitation_status='accepted' AND p.participation_status='active' AND p.access_level IN ('operational','incident_command')
      AND p.revoked_at IS NULL AND p.removed_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())))`,
    [incidentId, orgId],
  );
  if (!rows.length) throw new AccessError("forbidden");
}
function validUntil(value: string) {
  if (!(Date.parse(value) > Date.now())) throw new AccessError("invalid_input");
}
async function recipientInRoom(q: QueryRunner, incidentId: string, recipient: string) {
  const rows = await q.query<{ eligible: boolean }>(
    `SELECT EXISTS(
    SELECT 1 FROM airs.incident_rooms WHERE id=$1 AND org_id=$2
    UNION ALL SELECT 1 FROM airs.incident_participants WHERE incident_id=$1 AND partner_org_id=$2
      AND invitation_status='accepted' AND participation_status='active' AND revoked_at IS NULL AND removed_at IS NULL
      AND (expires_at IS NULL OR expires_at>now())) AS eligible`,
    [incidentId, recipient],
  );
  if (!rows[0]?.eligible) throw new AccessError("participation_inactive");
}

export async function readFramework(token: string | null, incidentId?: string) {
  return withAuthorized(
    {
      token,
      permission: "incident.read",
      action: "framework.read",
      resourceType: "framework",
      audit: false,
    },
    async (ctx, q) => {
      if (!isAgencyOperationalRole(ctx.roleKey)) throw new AccessError("forbidden");
      if (incidentId) {
        // Closed rooms may still be managed by their owners, but never project observations.
        const room = await q.query<{ status: string }>(
          `SELECT status FROM airs.incident_rooms WHERE id=$1`,
          [incidentId],
        );
        if (!room[0]) throw new AccessError("incident_not_found");
      }
      const [profiles, sources, envelopes, grants, observations, supplemental] = await Promise.all([
        q.query<{ profile: z.infer<typeof entityProfileSchema> }>(
          `SELECT profile FROM airs.entity_profiles WHERE org_id=$1`,
          [ctx.orgId],
        ),
        q.query<{ id: string; profile: z.infer<typeof sourceSchema>; health: string }>(
          `SELECT id,profile,health FROM airs.source_systems WHERE org_id=$1 ORDER BY updated_at DESC`,
          [ctx.orgId],
        ),
        q.query<{
          id: string;
          orgId: string;
          policy: z.infer<typeof envelopeSchema>;
          revokedAt: string | null;
        }>(
          `SELECT id,org_id AS "orgId",policy,revoked_at::text AS "revokedAt" FROM airs.partner_envelopes ORDER BY created_at DESC LIMIT 200`,
        ),
        incidentId
          ? q.query<{
              id: string;
              sourceId: string;
              recipientOrgId: string;
              relationship: string;
              dataClasses: string[];
              expiresAt: string;
              revokedAt: string | null;
            }>(
              `SELECT id,source_id AS "sourceId",recipient_org_id AS "recipientOrgId",relationship,data_classes AS "dataClasses",expires_at::text AS "expiresAt",revoked_at::text AS "revokedAt" FROM airs.incident_source_grants WHERE incident_id=$1`,
              [incidentId],
            )
          : [],
        incidentId
          ? q.query<{
              id: string;
              orgId: string;
              observation: z.infer<typeof observationSchema>;
              receivedTimestamp: string;
              operationalEntityId: string | null;
            }>(
              `SELECT o.id,o.org_id AS "orgId",o.observation,o.received_at::text AS "receivedTimestamp",c.operational_entity_id AS "operationalEntityId"
        FROM airs.operational_observations o LEFT JOIN airs.observation_correlations c ON c.observation_id=o.id AND c.incident_id=o.incident_id
        WHERE o.incident_id=$1 AND o.expires_at>now() AND airs.framework_incident_active(o.incident_id)
          AND (o.grant_id IS NULL OR airs.framework_grant_valid(o.grant_id)) ORDER BY o.received_at DESC LIMIT 501`,
              [incidentId],
            )
          : [],
        incidentId
          ? q.query<{
              id: string;
              profile: z.infer<typeof supplementalSchema>;
              revocationStatus: string;
            }>(
              `SELECT id,profile,revocation_status AS "revocationStatus" FROM airs.supplemental_source_access WHERE incident_id=$1`,
              [incidentId],
            )
          : [],
      ]);
      const directory = await q.query<{ id: string; name: string; entity_type: string }>(
        `SELECT * FROM airs.framework_entity_directory() ORDER BY name`,
      );
      return {
        orgId: ctx.orgId,
        directory,
        canManage: ctx.permissions.has("org.manage"),
        canReport: ctx.permissions.has("observation.create"),
        canCorrelate: ctx.permissions.has("observation.link"),
        profile: profiles[0]?.profile ?? null,
        sources: sources.map((s) => ({
          ...s.profile,
          id: s.id,
          orgId: ctx.orgId,
          health: s.health,
        })),
        envelopes,
        grants,
        observationsTruncated: observations.length > 500,
        observations: observations.slice(0, 500).map((o) => ({
          ...o.observation,
          id: o.id,
          orgId: o.orgId,
          receivedTimestamp: o.receivedTimestamp,
          operationalEntityId: o.operationalEntityId,
        })) as Observation[],
        supplemental,
      };
    },
  );
}

export async function writeFramework(token: string | null, raw: FrameworkCommand) {
  const command = frameworkCommandSchema.parse(raw);
  return withAuthorized(
    {
      token,
      permission:
        command.action === "report"
          ? "observation.create"
          : command.action === "correlate"
            ? "observation.link"
            : command.action === "preserve_evidence"
              ? "observation.evidence_reference_manage"
              : "org.manage",
      action: `framework.${command.action}`,
      resourceType: "framework",
      detail: {
        action: command.action,
        ...("id" in command.value ? { recordId: command.value.id } : {}),
        ...("incidentId" in command.value ? { incidentId: command.value.incidentId } : {}),
        ...("sourceId" in command.value ? { sourceId: command.value.sourceId } : {}),
        ...("recipientOrgId" in command.value
          ? { recipientOrgId: command.value.recipientOrgId }
          : {}),
        ...("dataClasses" in command.value ? { dataClasses: command.value.dataClasses } : {}),
        ...("observationIds" in command.value
          ? { observationIds: command.value.observationIds }
          : {}),
      },
    },
    async (ctx, q) => {
      if (!isAgencyOperationalRole(ctx.roleKey)) throw new AccessError("forbidden");
      switch (command.action) {
        case "readiness": {
          const v = command.value;
          const rows = await q.query(
            `UPDATE airs.source_systems SET health=$3,profile=profile||jsonb_build_object('readinessReceipt',$4::text,'readinessRecordedAt',now()),updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING id`,
            [v.id, ctx.orgId, v.health, v.receipt],
          );
          if (!rows.length) throw new AccessError("forbidden");
          break;
        }
        case "preserve_evidence": {
          const rows = await q.query(
            `UPDATE airs.operational_observations SET evidence_policy=$3 WHERE id=$1 AND org_id=$2 RETURNING id`,
            [command.value.id, ctx.orgId, command.value.policy],
          );
          if (!rows.length) throw new AccessError("forbidden");
          break;
        }
        case "profile":
          await q.query(
            `INSERT INTO airs.entity_profiles(org_id,profile) VALUES($1,$2) ON CONFLICT(org_id) DO UPDATE SET profile=excluded.profile,updated_at=now()`,
            [ctx.orgId, JSON.stringify(command.value)],
          );
          break;
        case "source": {
          const v = command.value;
          if (v.id) {
            const rows = await q.query(
              `UPDATE airs.source_systems SET profile=$3,health='identified',updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING id`,
              [v.id, ctx.orgId, JSON.stringify(v)],
            );
            if (!rows.length) throw new AccessError("forbidden");
            if (v.ingestionAuthorization !== "authorized")
              await q.query(
                `UPDATE airs.incident_source_grants SET revoked_at=coalesce(revoked_at,now()) WHERE source_id=$1 AND org_id=$2`,
                [v.id, ctx.orgId],
              );
          } else
            await q.query(`INSERT INTO airs.source_systems(org_id,profile) VALUES($1,$2)`, [
              ctx.orgId,
              JSON.stringify(v),
            ]);
          break;
        }
        case "envelope": {
          const v = command.value;
          validUntil(v.expiresAt);
          const source = await sourceFor(q, v.sourceId, ctx.orgId);
          if (
            v.recipientOrgId === ctx.orgId ||
            v.dataClasses.some((c) => !source.dataClasses.includes(c))
          )
            throw new AccessError("invalid_input");
          // Policy changes are new immutable envelopes. Revocation is explicit.
          await q.query(
            `INSERT INTO airs.partner_envelopes(org_id,recipient_org_id,source_id,policy,expires_at) VALUES($1,$2,$3,$4,$5)`,
            [ctx.orgId, v.recipientOrgId, v.sourceId, JSON.stringify(v), v.expiresAt],
          );
          break;
        }
        case "grant": {
          const v = command.value;
          validUntil(v.expiresAt);
          if ((v.relationship === "originating_entity") !== (v.recipientOrgId === ctx.orgId))
            throw new AccessError("invalid_input");
          const room = await activeRoom(q, v.incidentId);
          await recipientInRoom(q, v.incidentId, v.recipientOrgId);
          const source = await sourceFor(q, v.sourceId, ctx.orgId);
          const envelopes = v.envelopeId
            ? await q.query<{
                id: string;
                policy: z.infer<typeof envelopeSchema>;
                revokedAt: string | null;
              }>(
                `SELECT id,policy,revoked_at::text AS "revokedAt" FROM airs.partner_envelopes WHERE id=$1 AND org_id=$2 FOR SHARE`,
                [v.envelopeId, ctx.orgId],
              )
            : [];
          const envelope = envelopes[0]
            ? { ...envelopes[0].policy, id: envelopes[0].id, revoked: !!envelopes[0].revokedAt }
            : undefined;
          if (
            v.dataClasses.some(
              (dataClass) =>
                !authorizeAcquisition({
                  incidentStatus: room.status,
                  incidentType: room.incidentType,
                  source,
                  grant: v,
                  envelope,
                  dataClass,
                  now: Date.now(),
                }),
            )
          )
            throw new AccessError("forbidden");
          await q.query(
            `INSERT INTO airs.incident_source_grants(org_id,incident_id,recipient_org_id,source_id,relationship,envelope_id,data_classes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              ctx.orgId,
              v.incidentId,
              v.recipientOrgId,
              v.sourceId,
              v.relationship,
              v.envelopeId ?? null,
              v.dataClasses,
              v.expiresAt,
            ],
          );
          break;
        }
        case "report": {
          const v = command.value;
          const room = await activeRoom(q, v.incidentId);
          await assertContribution(q, v.incidentId, ctx.orgId);
          if (v.verification === "confirmed" && !ctx.permissions.has("observation.verify"))
            throw new AccessError("forbidden");
          if (Date.parse(v.sourceTimestamp) > Date.now() + 60000)
            throw new AccessError("invalid_input");
          if (v.sourceId) {
            const source = await sourceFor(q, v.sourceId, ctx.orgId);
            v.originatingEntity = ctx.orgName;
            v.platform = source.vendor;
            const grants = await q.query(
              `SELECT id FROM airs.incident_source_grants WHERE id=$1 AND org_id=$2 AND source_id=$3 AND incident_id=$4 AND $5=ANY(data_classes) AND airs.framework_grant_valid(id) FOR SHARE`,
              [v.grantId, ctx.orgId, v.sourceId, v.incidentId, v.dataClass],
            );
            if (!grants.length || !source.dataClasses.includes(v.dataClass))
              throw new AccessError("forbidden");
          } else if (v.grantId) throw new AccessError("invalid_input");
          await q.query(
            `INSERT INTO airs.operational_observations(org_id,incident_id,source_id,grant_id,observation,expires_at) VALUES($1,$2,$3,$4,$5,now()+make_interval(hours=>$6))`,
            [
              ctx.orgId,
              v.incidentId,
              v.sourceId ?? null,
              v.grantId ?? null,
              JSON.stringify(v),
              room.retention,
            ],
          );
          break;
        }
        case "correlate": {
          const v = command.value;
          await activeRoom(q, v.incidentId);
          await assertContribution(q, v.incidentId, ctx.orgId);
          const owners = await q.query(
            `SELECT id FROM airs.incident_rooms WHERE id=$1 AND org_id=$2`,
            [v.incidentId, ctx.orgId],
          );
          if (!owners.length) throw new AccessError("forbidden");
          const rows = await q.query<{ id: string }>(
            `SELECT id FROM airs.operational_observations WHERE id=ANY($1::uuid[]) AND incident_id=$2 AND expires_at>now() AND (grant_id IS NULL OR airs.framework_grant_valid(grant_id))`,
            [v.observationIds, v.incidentId],
          );
          if (rows.length !== new Set(v.observationIds).size) throw new AccessError("forbidden");
          const entityId = crypto.randomUUID();
          for (const id of v.observationIds)
            await q.query(
              `INSERT INTO airs.observation_correlations(org_id,incident_id,observation_id,operational_entity_id,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(incident_id,observation_id) DO UPDATE SET operational_entity_id=excluded.operational_entity_id,reason=excluded.reason,created_at=now()`,
              [ctx.orgId, v.incidentId, id, entityId, v.reason],
            );
          break;
        }
        case "supplemental": {
          const v = command.value;
          validUntil(v.expiresAt);
          await activeRoom(q, v.incidentId);
          await sourceFor(q, v.sourceId, ctx.orgId);
          await recipientInRoom(q, v.incidentId, v.recipientOrgId);
          await q.query(
            `INSERT INTO airs.supplemental_source_access(org_id,incident_id,source_id,recipient_org_id,profile,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [ctx.orgId, v.incidentId, v.sourceId, v.recipientOrgId, JSON.stringify(v), v.expiresAt],
          );
          break;
        }
        case "revocation_receipt": {
          const v = command.value;
          const rows = await q.query(
            `UPDATE airs.supplemental_source_access SET revocation_status=$3,revoked_at=CASE WHEN $4 THEN now() ELSE NULL END,profile=profile||jsonb_build_object('revocationReceipt',$5::text) WHERE id=$1 AND org_id=$2 RETURNING id`,
            [v.id, ctx.orgId, v.confirmed ? "confirmed" : "failed", v.confirmed, v.receipt],
          );
          if (!rows.length) throw new AccessError("forbidden");
          break;
        }
        case "revoke": {
          const table =
            command.value.kind === "grant" ? "incident_source_grants" : "partner_envelopes";
          const rows = await q.query(
            `UPDATE airs.${table} SET revoked_at=now() WHERE id=$1 AND org_id=$2 RETURNING id`,
            [command.value.id, ctx.orgId],
          );
          if (!rows.length) throw new AccessError("forbidden");
          break;
        }
      }
      return { saved: true };
    },
  );
}
