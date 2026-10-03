import { z } from "zod";
import { withIncidentAction } from "./incidents.server";
import { AccessError } from "@/lib/auth/errors";
import { listIncidentAssignments } from "@/lib/resources/assignments.server";

export const orderInput = z
  .object({
    id: z.string().uuid(),
    incidentId: z.string().uuid(),
    assignmentId: z.string().uuid(),
    previousOrderId: z.string().uuid().nullable(),
    destination: z.string().trim().min(1).max(300),
    mission: z.string().trim().min(1).max(1500),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .refine((v) => (v.latitude === null) === (v.longitude === null), "Both coordinates required");
export const orderReportInput = z.object({
  incidentId: z.string().uuid(),
  orderId: z.string().uuid(),
  status: z.enum(["acknowledged", "en_route", "arrived", "unable"]),
  message: z.string().trim().min(1).max(1000),
});
export interface ResourceOrder {
  id: string;
  assignmentId: string;
  recipientOrgId: string;
  destination: string;
  mission: string;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  status: string;
  reportedAt: string | null;
  message: string | null;
}
const columns = `o.id,o.assignment_id AS "assignmentId",o.recipient_org_id AS "recipientOrgId",
 o.destination,o.mission,o.latitude,o.longitude,o.created_at::text AS "createdAt",
 COALESCE(p.status,'ordered') AS status,p.created_at::text AS "reportedAt",p.message`;
const latestReport = `LEFT JOIN LATERAL (SELECT * FROM airs.resource_order_reports WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true`;
export async function readResourceOrders(
  token: string | null,
  orgId: string | null,
  incidentId: string,
) {
  const assignments = (await listIncidentAssignments(token, orgId, incidentId)).filter(
    (a) =>
      a.assignmentType === "resource" && ["assigned", "deploying", "active"].includes(a.status),
  );
  const board = await withIncidentAction(
    { token, orgId, incidentId, meta: {}, action: "read", audit: false },
    async (ctx, q, access) => ({
      orders: await q.query<ResourceOrder>(
        `SELECT ${columns} FROM airs.resource_orders o ${latestReport}
      WHERE o.incident_id=$1 AND NOT EXISTS(SELECT 1 FROM airs.resource_orders n WHERE n.assignment_id=o.assignment_id AND n.sequence>o.sequence)`,
        [incidentId],
      ),
      canDirect:
        access.relationship === "origin_admin" &&
        ctx.permissions.has("incident.update") &&
        access.incident.status === "active",
      canReport:
        ["origin_admin", "operational", "incident_command"].includes(access.relationship) &&
        ctx.permissions.has("resource.assign_incident"),
      orgId: ctx.orgId,
    }),
  );
  return { ...board, assignments };
}
export async function issueResourceOrder(
  token: string | null,
  orgId: string | null,
  raw: z.infer<typeof orderInput>,
) {
  const input = orderInput.parse(raw);
  const available = await listIncidentAssignments(token, orgId, input.incidentId);
  if (
    !available.some(
      (a) =>
        a.id === input.assignmentId &&
        a.assignmentType === "resource" &&
        ["assigned", "deploying", "active"].includes(a.status),
    )
  )
    throw new AccessError("forbidden");
  return withIncidentAction(
    {
      token,
      orgId,
      incidentId: input.incidentId,
      meta: {},
      action: "update",
      detail: { assignmentId: input.assignmentId, destination: input.destination },
    },
    async (ctx, q) => {
      if (
        !(await q.query("SELECT * FROM airs.lock_framework_incident($1)", [input.incidentId]))
          .length
      )
        throw new AccessError("incident_state_invalid");
      const existing = await q.query<{ id: string }>(
        "SELECT id FROM airs.resource_orders WHERE id=$1 AND incident_id=$2",
        [input.id, input.incidentId],
      );
      if (existing.length) return existing[0];
      const current = await q.query<{ id: string }>(
        "SELECT id FROM airs.resource_orders WHERE assignment_id=$1 ORDER BY sequence DESC LIMIT 1",
        [input.assignmentId],
      );
      if ((current[0]?.id ?? null) !== input.previousOrderId)
        throw new AccessError(
          "invalid_input",
          "Assignment changed; refresh before issuing another order",
        );
      const result = await q.query<{ id: string }>(
        `INSERT INTO airs.resource_orders(id,incident_id,assignment_id,issuer_org_id,recipient_org_id,issued_by,destination,mission,latitude,longitude)
      SELECT $1,$2,a.id,$3,a.org_id,$4,$5,$6,$7,$8 FROM airs.incident_assignments a
      WHERE a.id=$9 AND a.incident_id=$2 AND a.assignment_type='resource' AND a.status IN ('assigned','deploying','active') RETURNING id`,
        [
          input.id,
          input.incidentId,
          ctx.orgId,
          ctx.accountId,
          input.destination,
          input.mission,
          input.latitude,
          input.longitude,
          input.assignmentId,
        ],
      );
      if (!result.length) throw new AccessError("assignment_terminated");
      return result[0];
    },
  );
}
export async function reportResourceOrder(
  token: string | null,
  orgId: string | null,
  raw: z.infer<typeof orderReportInput>,
) {
  const input = orderReportInput.parse(raw);
  return withIncidentAction(
    {
      token,
      orgId,
      incidentId: input.incidentId,
      meta: {},
      action: "read",
      detail: { orderId: input.orderId, status: input.status },
    },
    async (ctx, q, access) => {
      if (
        !["origin_admin", "operational", "incident_command"].includes(access.relationship) ||
        !ctx.permissions.has("resource.assign_incident")
      )
        throw new AccessError("forbidden");
      if (
        !(await q.query("SELECT * FROM airs.lock_framework_incident($1)", [input.incidentId]))
          .length
      )
        throw new AccessError("incident_state_invalid");
      const rows = await q.query<ResourceOrder>(
        `SELECT ${columns} FROM airs.resource_orders o ${latestReport}
      JOIN airs.incident_assignments a ON a.id=o.assignment_id
      WHERE o.id=$1 AND o.incident_id=$2 AND o.recipient_org_id=$3 AND a.status IN ('assigned','deploying','active')
      AND NOT EXISTS(SELECT 1 FROM airs.resource_orders n WHERE n.assignment_id=o.assignment_id AND n.sequence>o.sequence)`,
        [input.orderId, input.incidentId, ctx.orgId],
      );
      const order = rows[0];
      if (!order) throw new AccessError("forbidden");
      if (order.status === input.status) return;
      const next: Record<string, string[]> = {
        ordered: ["acknowledged", "unable"],
        acknowledged: ["en_route", "unable"],
        en_route: ["arrived", "unable"],
      };
      if (!next[order.status]?.includes(input.status)) throw new AccessError("invalid_input");
      await q.query(
        `INSERT INTO airs.resource_order_reports(order_id,status,message,reported_by) VALUES($1,$2,$3,$4)`,
        [input.orderId, input.status, input.message, ctx.accountId],
      );
    },
  );
}
