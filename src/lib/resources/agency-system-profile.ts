// AIRS Agency Systems Profile — pure normalization and shaping helpers.
//
// Pure and deterministic: no I/O, no persistence, no credentials, no
// connectors. This module sits between the technology ecosystem catalog and
// the profile persistence layer:
//
//  - Writes: agency-declared selections are validated against the catalog.
//    Unknown IDs, invalid usage statuses and conflicting duplicate
//    declarations are REJECTED. Exact duplicates collapse to one entry and
//    output order is the stable catalog declaration order.
//  - Reads: persisted rows are re-validated against the catalog. Unknown IDs
//    and invalid statuses are silently OMITTED (default deny — a stale row
//    can never widen the profile).
//
// Only agency-declared usage is ever represented. Every confirmed component
// derives createDefaultIntegrationState(): NOT connected, NOT authorized,
// NOT credentialed, NOT data-access-capable. Nothing in this module can set
// or infer credentials, authorization, connection state or data access.

import {
  CATALOG_COMPONENTS,
  ECOSYSTEMS,
  USAGE_STATUSES,
  createDefaultIntegrationState,
  findCatalogComponent,
  isEcosystemId,
  type AirsCapability,
  type EcosystemId,
  type IntegrationState,
  type UsageStatus,
} from "./technology-ecosystem-catalog";

// Stable catalog declaration order — the single source of output ordering.
const ECOSYSTEM_ORDER = new Map<string, number>(ECOSYSTEMS.map((e, i) => [e.id, i]));
const COMPONENT_ORDER = new Map<string, number>(CATALOG_COMPONENTS.map((c, i) => [c.id, i]));
const VENDOR_NAME_BY_ID = new Map<string, string>(ECOSYSTEMS.map((e) => [e.id, e.vendorName]));

export function isUsageStatus(value: unknown): value is UsageStatus {
  return typeof value === "string" && (USAGE_STATUSES as readonly string[]).includes(value);
}

/** A single agency-declared selection: an ID plus a usage status, nothing else. */
export interface UsageDeclaration {
  id: string;
  usageStatus: UsageStatus;
}

export type NormalizeResult =
  | { ok: true; selections: UsageDeclaration[] }
  | { ok: false; reason: string };

/**
 * Shared write-path normalizer. Only `id` and `usageStatus` are ever read
 * from an input entry — org IDs, confirmers, sources, connection flags or any
 * other client-supplied property are ignored by construction and can never
 * reach persistence through this path.
 */
function normalizeSelections(
  input: readonly unknown[] | null | undefined,
  isKnownId: (id: string) => boolean,
  orderOf: (id: string) => number,
  label: string,
): NormalizeResult {
  const byId = new Map<string, UsageStatus>();
  for (const raw of input ?? []) {
    if (raw == null || typeof raw !== "object") {
      return { ok: false, reason: `invalid ${label} declaration` };
    }
    const id = (raw as { id?: unknown }).id;
    const status = (raw as { usageStatus?: unknown }).usageStatus;
    if (typeof id !== "string" || !isKnownId(id)) {
      return { ok: false, reason: `unknown ${label} id` };
    }
    if (!isUsageStatus(status)) {
      return { ok: false, reason: `invalid ${label} usage status` };
    }
    const existing = byId.get(id);
    if (existing !== undefined && existing !== status) {
      return { ok: false, reason: `conflicting duplicate ${label} declarations` };
    }
    byId.set(id, status);
  }
  const selections = [...byId.entries()]
    .map(([id, usageStatus]) => ({ id, usageStatus }))
    .sort((a, b) => orderOf(a.id) - orderOf(b.id) || a.id.localeCompare(b.id));
  return { ok: true, selections };
}

/** Normalizes ecosystem declarations for a save. Unknown IDs are rejected. */
export function normalizeEcosystemSelections(
  input: readonly unknown[] | null | undefined,
): NormalizeResult {
  return normalizeSelections(
    input,
    (id) => isEcosystemId(id),
    (id) => ECOSYSTEM_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER,
    "ecosystem",
  );
}

/** Normalizes component declarations for a save. Unknown IDs are rejected. */
export function normalizeComponentSelections(
  input: readonly unknown[] | null | undefined,
): NormalizeResult {
  return normalizeSelections(
    input,
    (id) => COMPONENT_ORDER.has(id),
    (id) => COMPONENT_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER,
    "component",
  );
}

// ---------------------------------------------------------------------------
// Read-side shaping
// ---------------------------------------------------------------------------

export interface ProfileEcosystem {
  ecosystemId: EcosystemId;
  vendorName: string;
  usageStatus: UsageStatus;
}

export interface ProfileComponent {
  componentId: string;
  ecosystemId: EcosystemId;
  name: string;
  capabilities: readonly AirsCapability[];
  usageStatus: UsageStatus;
  /** Always "agency_confirmed": the only source this profile ever records. */
  source: "agency_confirmed";
  /**
   * Derived from createDefaultIntegrationState() with ONLY the declared usage
   * overlaid. Always disconnected, unauthorized, uncredentialed and without
   * data access — regardless of anything in storage.
   */
  integration: IntegrationState;
}

export interface AgencySystemProfile {
  version: number;
  updatedAt: string | null;
  ecosystems: ProfileEcosystem[];
  components: ProfileComponent[];
}

/** Raw persisted rows. Anything beyond ID + usage status is never consulted. */
export interface PersistedEcosystemRow {
  ecosystemId?: unknown;
  usageStatus?: unknown;
}
export interface PersistedComponentRow {
  componentId?: unknown;
  usageStatus?: unknown;
}

/**
 * Shapes a safe, catalog-validated profile from persisted rows.
 *
 * Default deny on reads: rows whose ID is no longer in the catalog, or whose
 * usage status is not an agency usage status, are omitted. Confirmed
 * components always start from the default disconnected integration state;
 * no persisted or client-supplied field can mark a component connected,
 * authorized, credentialed or data-access-capable through this function.
 */
export function shapeAgencySystemProfile(input: {
  version?: unknown;
  updatedAt?: unknown;
  ecosystems?: readonly PersistedEcosystemRow[] | null;
  components?: readonly PersistedComponentRow[] | null;
}): AgencySystemProfile {
  const version =
    typeof input.version === "number" && Number.isInteger(input.version) && input.version >= 0
      ? input.version
      : 0;
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : null;

  const ecoById = new Map<EcosystemId, UsageStatus>();
  for (const row of input.ecosystems ?? []) {
    const id = row?.ecosystemId;
    const status = row?.usageStatus;
    if (!isEcosystemId(id) || !isUsageStatus(status)) continue;
    if (!ecoById.has(id)) ecoById.set(id, status);
  }
  const ecosystems: ProfileEcosystem[] = [...ecoById.entries()]
    .map(([ecosystemId, usageStatus]) => ({
      ecosystemId,
      vendorName: VENDOR_NAME_BY_ID.get(ecosystemId) ?? ecosystemId,
      usageStatus,
    }))
    .sort(
      (a, b) =>
        (ECOSYSTEM_ORDER.get(a.ecosystemId) ?? Number.MAX_SAFE_INTEGER) -
          (ECOSYSTEM_ORDER.get(b.ecosystemId) ?? Number.MAX_SAFE_INTEGER) ||
        a.ecosystemId.localeCompare(b.ecosystemId),
    );

  const compById = new Map<string, UsageStatus>();
  for (const row of input.components ?? []) {
    const id = row?.componentId;
    const status = row?.usageStatus;
    if (typeof id !== "string" || !COMPONENT_ORDER.has(id) || !isUsageStatus(status)) continue;
    if (!compById.has(id)) compById.set(id, status);
  }
  const components: ProfileComponent[] = [...compById.entries()]
    .map(([componentId, usageStatus]) => {
      const catalog = findCatalogComponent(componentId);
      if (!catalog) return null;
      // Always the default disconnected state; only usage is overlaid.
      const integration: IntegrationState = {
        ...createDefaultIntegrationState(),
        usage: usageStatus,
      };
      return {
        componentId: catalog.id,
        ecosystemId: catalog.ecosystemId,
        name: catalog.name,
        capabilities: catalog.capabilities,
        usageStatus,
        source: "agency_confirmed" as const,
        integration,
      };
    })
    .filter((c): c is ProfileComponent => c !== null)
    .sort(
      (a, b) =>
        (COMPONENT_ORDER.get(a.componentId) ?? Number.MAX_SAFE_INTEGER) -
          (COMPONENT_ORDER.get(b.componentId) ?? Number.MAX_SAFE_INTEGER) ||
        a.componentId.localeCompare(b.componentId),
    );

  return { version, updatedAt, ecosystems, components };
}
