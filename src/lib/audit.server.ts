// Audit writer. Runs inside the caller's transaction so an audited action and
// its evidence commit or roll back together. Never stores credentials, tokens
// or secrets: token hashes and passwords are excluded by construction.
import type { QueryRunner } from "@/lib/adapters/types";

export interface AuditInput {
  orgId: string;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: "allow" | "deny" | "error";
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
  correlationId?: string | null;
}

const FORBIDDEN_DETAIL_KEYS = /pass|secret|token|credential|authorization|cookie/i;

export function sanitizeDetail(detail: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.test(key)) continue;
    out[key] = typeof value === "string" && value.length > 512 ? value.slice(0, 512) : value;
  }
  return out;
}

export async function recordAudit(q: QueryRunner, event: AuditInput): Promise<void> {
  const detail = sanitizeDetail(event.detail);
  if (event.correlationId) detail.correlation_id = event.correlationId;
  await q.query(
    `INSERT INTO airs.audit_events
       (org_id, actor_user_id, action, resource_type, resource_id, outcome, detail, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      event.orgId,
      event.actorUserId ?? null,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      event.outcome,
      JSON.stringify(detail),
      event.ipAddress ?? null,
    ],
  );
}
