// Regression coverage for the AIRS Agency Systems Profile pure helpers.
//
// Pins the safety invariants:
//  - write-path normalization: stable catalog order, exact-duplicate collapse,
//    unknown IDs rejected, conflicting duplicate statuses rejected, only
//    agency usage statuses accepted
//  - client-supplied org IDs, confirmers, sources and connection/authorization
//    flags on declarations are ignored by construction
//  - read-path shaping: unknown persisted IDs and invalid statuses are omitted
//    (default deny) and hostile persisted extras never leak
//  - every confirmed component derives createDefaultIntegrationState():
//    disconnected, unauthorized, uncredentialed, no data access

import { describe, expect, it } from "vitest";

import {
  isUsageStatus,
  normalizeComponentSelections,
  normalizeEcosystemSelections,
  shapeAgencySystemProfile,
} from "./agency-system-profile";
import { createDefaultIntegrationState } from "./technology-ecosystem-catalog";

describe("usage status guard", () => {
  it("accepts only agency usage statuses", () => {
    expect(isUsageStatus("in_use")).toBe(true);
    expect(isUsageStatus("planned")).toBe(true);
    // Connection, mode and authorization vocabulary must never pass as usage.
    expect(isUsageStatus("connected_to_airs")).toBe(false);
    expect(isUsageStatus("read_only")).toBe(false);
    expect(isUsageStatus("authorized")).toBe(false);
    expect(isUsageStatus("")).toBe(false);
    expect(isUsageStatus(null)).toBe(false);
  });
});

describe("write-path normalization", () => {
  it("orders ecosystems by stable catalog order regardless of input order", () => {
    const result = normalizeEcosystemSelections([
      { id: "skydio", usageStatus: "in_use" },
      { id: "axon", usageStatus: "planned" },
      { id: "dronesense", usageStatus: "in_use" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selections.map((s) => s.id)).toEqual(["axon", "dronesense", "skydio"]);
    }
  });

  it("collapses exact duplicate declarations", () => {
    const result = normalizeComponentSelections([
      { id: "motorola_cad", usageStatus: "in_use" },
      { id: "motorola_cad", usageStatus: "in_use" },
      { id: "skydio_dock", usageStatus: "planned" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selections).toEqual([
        { id: "motorola_cad", usageStatus: "in_use" },
        { id: "skydio_dock", usageStatus: "planned" },
      ]);
    }
  });

  it("is deterministic for equivalent inputs", () => {
    const a = normalizeComponentSelections([
      { id: "dji_dock", usageStatus: "planned" },
      { id: "axon_air", usageStatus: "in_use" },
    ]);
    const b = normalizeComponentSelections([
      { id: "axon_air", usageStatus: "in_use" },
      { id: "dji_dock", usageStatus: "planned" },
      { id: "dji_dock", usageStatus: "planned" },
    ]);
    expect(a).toEqual(b);
  });

  it("rejects unknown ecosystem and component IDs on writes", () => {
    expect(normalizeEcosystemSelections([{ id: "fusus", usageStatus: "in_use" }]).ok).toBe(false);
    expect(normalizeEcosystemSelections([{ id: "AXON", usageStatus: "in_use" }]).ok).toBe(false);
    expect(
      normalizeComponentSelections([{ id: "ghost_component", usageStatus: "in_use" }]).ok,
    ).toBe(false);
    expect(normalizeComponentSelections([{ id: "", usageStatus: "planned" }]).ok).toBe(false);
  });

  it("rejects conflicting duplicate declarations", () => {
    const result = normalizeEcosystemSelections([
      { id: "axon", usageStatus: "in_use" },
      { id: "axon", usageStatus: "planned" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("conflicting");
  });

  it("rejects non-usage statuses so connection state cannot be smuggled in", () => {
    expect(
      normalizeComponentSelections([{ id: "skydio_uas", usageStatus: "connected_to_airs" }]).ok,
    ).toBe(false);
    expect(normalizeComponentSelections([{ id: "skydio_uas", usageStatus: "bidirectional" }]).ok).toBe(
      false,
    );
    expect(normalizeComponentSelections([{ id: "skydio_uas" }]).ok).toBe(false);
    expect(normalizeComponentSelections(["skydio_uas"]).ok).toBe(false);
  });

  it("ignores client-supplied org, confirmer, source and access fields by construction", () => {
    const result = normalizeComponentSelections([
      {
        id: "brinc_responder",
        usageStatus: "in_use",
        orgId: "11111111-1111-4111-8111-111111111111",
        confirmedByUser: "attacker",
        source: "vendor_asserted",
        authorized: true,
        credentialed: true,
        connection: "connected_to_airs",
        dataAccessCapable: true,
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selections).toEqual([{ id: "brinc_responder", usageStatus: "in_use" }]);
      expect(Object.keys(result.selections[0]).sort()).toEqual(["id", "usageStatus"]);
    }
  });

  it("empty and nullish input normalizes to no selections", () => {
    expect(normalizeEcosystemSelections([])).toEqual({ ok: true, selections: [] });
    expect(normalizeEcosystemSelections(null)).toEqual({ ok: true, selections: [] });
    expect(normalizeComponentSelections(undefined)).toEqual({ ok: true, selections: [] });
  });
});

describe("read-path profile shaping", () => {
  it("omits persisted IDs no longer in the catalog (default deny)", () => {
    const profile = shapeAgencySystemProfile({
      version: 3,
      updatedAt: "2024-01-01T00:00:00Z",
      ecosystems: [
        { ecosystemId: "axon", usageStatus: "in_use" },
        { ecosystemId: "defunct_vendor", usageStatus: "in_use" },
      ],
      components: [
        { componentId: "axon_air", usageStatus: "planned" },
        { componentId: "removed_component", usageStatus: "in_use" },
      ],
    });
    expect(profile.version).toBe(3);
    expect(profile.updatedAt).toBe("2024-01-01T00:00:00Z");
    expect(profile.ecosystems.map((e) => e.ecosystemId)).toEqual(["axon"]);
    expect(profile.components.map((c) => c.componentId)).toEqual(["axon_air"]);
  });

  it("omits rows with invalid usage statuses instead of guessing", () => {
    const profile = shapeAgencySystemProfile({
      version: 1,
      updatedAt: null,
      ecosystems: [{ ecosystemId: "skydio", usageStatus: "connected_to_airs" }],
      components: [{ componentId: "skydio_uas", usageStatus: "authorized" }],
    });
    expect(profile.ecosystems).toEqual([]);
    expect(profile.components).toEqual([]);
  });

  it("returns ecosystems with vendor names in stable catalog order", () => {
    const profile = shapeAgencySystemProfile({
      version: 1,
      updatedAt: null,
      ecosystems: [
        { ecosystemId: "pulsiam", usageStatus: "planned" },
        { ecosystemId: "axon", usageStatus: "in_use" },
      ],
      components: [],
    });
    expect(profile.ecosystems).toEqual([
      { ecosystemId: "axon", vendorName: "Axon", usageStatus: "in_use" },
      { ecosystemId: "pulsiam", vendorName: "Pulsiam", usageStatus: "planned" },
    ]);
  });

  it("derives every confirmed component from the default disconnected state", () => {
    const profile = shapeAgencySystemProfile({
      version: 2,
      updatedAt: null,
      ecosystems: [],
      components: [
        { componentId: "motorola_cad", usageStatus: "in_use" },
        { componentId: "skydio_dock", usageStatus: "planned" },
      ],
    });
    const defaults = createDefaultIntegrationState();
    for (const component of profile.components) {
      expect(component.source).toBe("agency_confirmed");
      expect(component.integration.connection).toBe(defaults.connection);
      expect(component.integration.connection).toBe("available_not_connected");
      expect(component.integration.mode).toBe("manual_only");
      expect(component.integration.authorized).toBe(false);
      expect(component.integration.credentialed).toBe(false);
      expect(component.integration.dataAccessCapable).toBe(false);
    }
    const planned = profile.components.find((c) => c.componentId === "skydio_dock");
    expect(planned?.usageStatus).toBe("planned");
    expect(planned?.integration.usage).toBe("planned");
    const inUse = profile.components.find((c) => c.componentId === "motorola_cad");
    expect(inUse?.integration.usage).toBe("in_use");
  });

  it("never leaks hostile persisted extras into the shaped component", () => {
    const profile = shapeAgencySystemProfile({
      version: 1,
      updatedAt: null,
      ecosystems: [],
      components: [
        {
          componentId: "axon_air",
          usageStatus: "in_use",
          // Hostile / stale storage noise that must never surface.
          authorized: true,
          credentialed: true,
          connection: "connected_to_airs",
          dataAccessCapable: true,
          apiKey: "secret",
        } as never,
      ],
    });
    const component = profile.components[0];
    expect(component).toBeDefined();
    expect(component.integration.authorized).toBe(false);
    expect(component.integration.credentialed).toBe(false);
    expect(component.integration.connection).toBe("available_not_connected");
    expect(component.integration.dataAccessCapable).toBe(false);
    expect(component).not.toHaveProperty("apiKey");
    expect(Object.keys(component).sort()).toEqual([
      "capabilities",
      "componentId",
      "ecosystemId",
      "integration",
      "name",
      "source",
      "usageStatus",
    ]);
  });

  it("falls back to safe defaults for malformed version and timestamp", () => {
    const profile = shapeAgencySystemProfile({
      version: "9" as never,
      updatedAt: 42 as never,
      ecosystems: [],
      components: [],
    });
    expect(profile.version).toBe(0);
    expect(profile.updatedAt).toBeNull();
    const negative = shapeAgencySystemProfile({ version: -1, updatedAt: null });
    expect(negative.version).toBe(0);
  });

  it("attributes components to their own vendor ecosystem", () => {
    const profile = shapeAgencySystemProfile({
      version: 1,
      updatedAt: null,
      ecosystems: [],
      components: [{ componentId: "skysafe_airspace_intelligence", usageStatus: "in_use" }],
    });
    expect(profile.components[0]?.ecosystemId).toBe("skysafe");
  });
});
