// AIRS Agency Systems Profile — server-side service.
//
// Runs through withAuthorized(), which enforces the full chain:
//   session -> account -> active membership -> organization role permission
//   -> pooling-safe airs.* GUCs -> forced RLS as airs_app -> audit event.
//
// Reads require the same registry read permission the Resources route already
// uses ("resource.read"). Saves require "org.manage" — declaring what systems
// an agency runs is organization administration, not routine registry work.
//
// The profile records agency-declared usage ONLY. Nothing here persists or
// infers credentials, authorization, connection state or data access; every
// mutation predicate is scoped to the caller's own org_id and forced RLS
// covers the rest.

import { withAuthorized } from "@/lib/auth/authorize.server";
import { AccessError } from "@/lib/auth/errors";
import type { RequestMeta } from "@/lib/auth/types";
import { isAgencyOperationalRole } from "@/lib/rbac/module-access";

function assertAgencyProfileRole(roleKey: Parameters<typeof isAgencyOperationalRole>[0]) {
  if (!isAgencyOperationalRole(roleKey)) throw new AccessError("forbidden");
}

import {
  normalizeComponentSelections,
  normalizeEcosystemSelections,
  shapeAgencySystemProfile,
  type AgencySystemProfile,
} from "./agency-system-profile";

export async function readAgencySystemProfile(
  token: string | null | undefined,
  orgId: string | null,
  meta?: RequestMeta,
): Promise<AgencySystemProfile> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "resource.read",
      action: "agency_system_profile.read",
      resourceType: "agency_system_profile",
      audit: false,
      meta,
    },
    async (ctx, q) => {
      assertAgencyProfileRole(ctx.roleKey);
      // Every query is scoped to the resolved membership's org; forced RLS on
      // all three airs.agency_system_* tables backs this up server-side.
      const [profiles, ecosystems, components] = await Promise.all([
        q.query<{ version: number; updatedAt: string | null }>(
          `SELECT version, to_json(updated_at)#>>'{}' AS "updatedAt"
             FROM airs.agency_system_profiles
            WHERE org_id = $1`,
          [ctx.orgId],
        ),
        q.query<{ ecosystemId: string; usageStatus: string }>(
          `SELECT ecosystem_id AS "ecosystemId", usage_status AS "usageStatus"
             FROM airs.agency_system_ecosystems
            WHERE org_id = $1
            ORDER BY ecosystem_id`,
          [ctx.orgId],
        ),
        q.query<{ componentId: string; usageStatus: string }>(
          `SELECT component_id AS "componentId", usage_status AS "usageStatus"
             FROM airs.agency_system_components
            WHERE org_id = $1
            ORDER BY component_id`,
          [ctx.orgId],
        ),
      ]);
      // Shaping re-validates every persisted ID against the catalog: unknown
      // or stale IDs are omitted and can never widen the returned profile.
      return shapeAgencySystemProfile({
        version: profiles[0]?.version ?? 0,
        updatedAt: profiles[0]?.updatedAt ?? null,
        ecosystems,
        components,
      });
    },
  );
}

export interface SaveAgencySystemProfileInput {
  ecosystems?: readonly { id: string; usageStatus: string }[] | null;
  components?: readonly { id: string; usageStatus: string }[] | null;
}

/**
 * Replaces the caller organization's declared systems atomically.
 *
 * withAuthorized() runs its callback inside a single database transaction
 * (the pooling-safe airs.* GUCs are transaction-local), so the upsert,
 * deletes and inserts below commit or roll back together. Every statement is
 * predicated on the resolved org_id — no truncate, no cross-tenant touch,
 * no RLS bypass.
 */
export async function saveAgencySystemProfile(
  token: string | null | undefined,
  orgId: string | null,
  input: SaveAgencySystemProfileInput,
  meta?: RequestMeta,
): Promise<AgencySystemProfile> {
  return withAuthorized(
    {
      token,
      orgId,
      permission: "org.manage",
      action: "agency_system_profile.saved",
      resourceType: "agency_system_profile",
      detail: { ecosystems: input.ecosystems?.length ?? 0, components: input.components?.length ?? 0 },
      meta,
    },
    async (ctx, q) => {
      assertAgencyProfileRole(ctx.roleKey);
      // Authorize first, then validate before any mutation. This prevents
      // unauthorized callers from probing catalog/status validation behavior.
      const eco = normalizeEcosystemSelections(input.ecosystems ?? []);
      if (!eco.ok) throw new AccessError("invalid_input", eco.reason);
      const comp = normalizeComponentSelections(input.components ?? []);
      if (!comp.ok) throw new AccessError("invalid_input", comp.reason);

      // Deterministic version: initialize at 1, increment on every save.
      // org_id and the confirming user come from the resolved membership,
      // never from the request body.
      const profileRows = await q.query<{ version: number; updatedAt: string }>(
        `INSERT INTO airs.agency_system_profiles (org_id, version, updated_by_user)
         VALUES ($1, 1, $2)
         ON CONFLICT (org_id) DO UPDATE
           SET version = airs.agency_system_profiles.version + 1,
               updated_by_user = EXCLUDED.updated_by_user,
               updated_at = now()
         RETURNING version, to_json(updated_at)#>>'{}' AS "updatedAt"`,
        [ctx.orgId, ctx.userId],
      );
      const profile = profileRows[0];
      if (!profile) {
        // An INSERT ... ON CONFLICT DO UPDATE with RETURNING always yields a
        // row; this is a plain invariant failure (not an access decision), so
        // it surfaces as an internal error via the transport guard and rolls
        // back the transaction.
        throw new Error("agency system profile upsert returned no row");
      }

      // Replace this org's declarations only. Predicates always include org_id.
      await q.query(`DELETE FROM airs.agency_system_ecosystems WHERE org_id = $1`, [ctx.orgId]);
      await q.query(`DELETE FROM airs.agency_system_components WHERE org_id = $1`, [ctx.orgId]);

      if (eco.selections.length > 0) {
        await q.query(
          `INSERT INTO airs.agency_system_ecosystems
             (org_id, ecosystem_id, usage_status, confirmed_by_user)
           SELECT $1, d.id, d.status, $2
             FROM unnest($3::text[], $4::text[]) AS d(id, status)`,
          [
            ctx.orgId,
            ctx.userId,
            eco.selections.map((s) => s.id),
            eco.selections.map((s) => s.usageStatus),
          ],
        );
      }
      if (comp.selections.length > 0) {
        // source is the fixed literal 'agency_confirmed' — never client input.
        await q.query(
          `INSERT INTO airs.agency_system_components
             (org_id, component_id, usage_status, source, confirmed_by_user)
           SELECT $1, d.id, d.status, 'agency_confirmed', $2
             FROM unnest($3::text[], $4::text[]) AS d(id, status)`,
          [
            ctx.orgId,
            ctx.userId,
            comp.selections.map((s) => s.id),
            comp.selections.map((s) => s.usageStatus),
          ],
        );
      }

      return shapeAgencySystemProfile({
        version: profile.version,
        updatedAt: profile.updatedAt,
        ecosystems: eco.selections.map((s) => ({
          ecosystemId: s.id,
          usageStatus: s.usageStatus,
        })),
        components: comp.selections.map((s) => ({
          componentId: s.id,
          usageStatus: s.usageStatus,
        })),
      });
    },
  );
}
