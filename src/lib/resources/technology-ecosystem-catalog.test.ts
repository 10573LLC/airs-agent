// Regression coverage for the AIRS technology ecosystem catalog foundation.
//
// Pins the safety invariants:
//  - suggestions are advisory and never become confirmed installations
//  - confirmed components are never auto-connected/authorized/credentialed
//  - unknown ecosystem/component IDs never widen suggestions, capabilities,
//    or access (default deny)
//  - normalized capabilities are deduplicated and vendor-neutral
//  - related-product suggestions stay advisory and never imply vendor ownership

import { describe, expect, it } from "vitest";

import {
  ADVISORY_RELATIONS,
  AIRS_CAPABILITIES,
  CATALOG_COMPONENTS,
  CONNECTION_STATUSES,
  ECOSYSTEMS,
  ECOSYSTEM_IDS,
  INTEGRATION_MODES,
  USAGE_STATUSES,
  acceptSuggestion,
  confirmComponent,
  createDefaultIntegrationState,
  findCatalogComponent,
  isAirsCapability,
  isEcosystemId,
  normalizedCapabilitiesForComponents,
  suggestComponentsForEcosystems,
} from "./technology-ecosystem-catalog";

const VENDOR_TOKENS = ["axon", "fusus", "motorola", "dronesense", "skydio", "dji", "pulsiam"];

describe("capability vocabulary is vendor-neutral", () => {
  it("contains every required AIRS capability key", () => {
    for (const key of [
      "cad_incident_feed",
      "unit_locations",
      "uas_telemetry",
      "aircraft_location",
      "dock_status",
      "live_video",
      "sensor_detections",
      "remote_id",
      "adsb",
      "evidence",
      "dispatch_status",
      "personnel_availability",
      "alerts_events",
      "airspace_awareness",
      "counter_uas_detection",
      "counter_uas_tracking",
      "counter_uas_identification",
      "counter_uas_mitigation",
      "rtcc_video_aggregation",
      "program_management",
      "mapping_photogrammetry",
      "lpr",
      "gunshot_detection",
      "medical_delivery",
    ]) {
      expect(AIRS_CAPABILITIES).toContain(key);
    }
  });

  it("never embeds a vendor name in a capability key", () => {
    for (const capability of AIRS_CAPABILITIES) {
      for (const vendor of VENDOR_TOKENS) {
        expect(capability.toLowerCase()).not.toContain(vendor);
      }
    }
  });

  it("every catalog component maps only to normalized capability keys", () => {
    for (const component of CATALOG_COMPONENTS) {
      expect(component.capabilities.length).toBeGreaterThan(0);
      for (const capability of component.capabilities) {
        expect(isAirsCapability(capability)).toBe(true);
      }
    }
  });
});

describe("catalog ownership and advisory relationships", () => {
  it("models the required vendor ecosystems and keeps Axon Fusus in the Axon family", () => {
    for (const id of [
      "axon",
      "motorola_solutions",
      "flock_safety",
      "dronesense",
      "skydio",
      "dji",
      "pulsiam",
      "brinc",
      "skysafe",
      "autel",
      "parrot",
      "teal_red_cat",
      "versaterm",
      "sifly",
      "skyfireai",
      "paladin",
      "ondas",
      "easy_aerial",
      "droneshield",
      "draganfly",
    ]) {
      expect(ECOSYSTEM_IDS).toContain(id);
    }
    expect(ECOSYSTEM_IDS).not.toContain("fusus");
    expect(new Set(ECOSYSTEMS.map((e) => e.id)).size).toBe(ECOSYSTEMS.length);
    expect(findCatalogComponent("axon_fusus_real_time_operations")?.ecosystemId).toBe("axon");
    expect(findCatalogComponent("axon_fusus_camera_registry")?.ecosystemId).toBe("axon");
    expect(findCatalogComponent("axon_prepared_911")?.ecosystemId).toBe("axon");
    expect(findCatalogComponent("axon_carbyne_911")?.ecosystemId).toBe("axon");
    expect(findCatalogComponent("axon_dedrone_airspace_security")?.ecosystemId).toBe("axon");
    expect(findCatalogComponent("motorola_dfend_enforceair")?.ecosystemId).toBe("motorola_solutions");
    expect(findCatalogComponent("motorola_cape")?.ecosystemId).toBe("motorola_solutions");
    expect(findCatalogComponent("flock_dfr")?.ecosystemId).toBe("flock_safety");
    expect(findCatalogComponent("flock_alpha")?.ecosystemId).toBe("flock_safety");
  });

  it("keeps Motorola alliances separate from Motorola-owned product families", () => {
    expect(findCatalogComponent("motorola_dfend_enforceair")?.ecosystemId).toBe("motorola_solutions");
    expect(findCatalogComponent("brinc_responder")?.ecosystemId).toBe("brinc");
    expect(findCatalogComponent("skysafe_airspace_intelligence")?.ecosystemId).toBe("skysafe");
    const motorolaSuggestions = suggestComponentsForEcosystems(["motorola_solutions"]);
    expect(motorolaSuggestions.find((x) => x.componentId === "brinc_responder")?.kind).toBe("related_product");
    expect(motorolaSuggestions.find((x) => x.componentId === "skysafe_airspace_intelligence")?.kind).toBe("related_product");
  });

  it("every component belongs to exactly one real ecosystem", () => {
    for (const component of CATALOG_COMPONENTS) {
      expect(isEcosystemId(component.ecosystemId)).toBe(true);
    }
    expect(new Set(CATALOG_COMPONENTS.map((c) => c.id)).size).toBe(CATALOG_COMPONENTS.length);
  });

  it("advisory relations never re-attribute a component to another vendor (no implied ownership)", () => {
    for (const relation of ADVISORY_RELATIONS) {
      const component = findCatalogComponent(relation.suggestedComponentId);
      expect(component).not.toBeNull();
      // The suggested component keeps its OWN ecosystem, which differs from
      // the selecting ecosystem — a "works with" relation, never ownership.
      expect(component?.ecosystemId).not.toBe(relation.fromEcosystemId);
      expect(relation.reason).toContain("advisory");
    }
  });
});

describe("suggestions are advisory only", () => {
  it("selecting ecosystems yields advisory suggestions, never confirmed installations", () => {
    const suggestions = suggestComponentsForEcosystems(["skydio", "pulsiam"]);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.advisory).toBe(true);
      // A suggestion is not a confirmed component and carries no integration state.
      expect(suggestion).not.toHaveProperty("integration");
      expect(suggestion).not.toHaveProperty("source");
      expect(suggestion).not.toHaveProperty("authorized");
      expect(suggestion).not.toHaveProperty("credentialed");
      expect(suggestion).not.toHaveProperty("dataAccessCapable");
    }
  });

  it("related-product suggestions carry the component's own vendor and an advisory reason", () => {
    const suggestions = suggestComponentsForEcosystems(["dronesense"]);
    const related = suggestions.filter((s) => s.kind === "related_product");
    expect(related.map((s) => s.componentId)).toContain("dji_uas");
    expect(related.map((s) => s.componentId)).toContain("skydio_uas");
    for (const suggestion of related) {
      expect(suggestion.advisory).toBe(true);
      expect(suggestion.ecosystemId).not.toBe("dronesense");
      expect(suggestion.reason).toContain("advisory");
      const component = findCatalogComponent(suggestion.componentId);
      expect(suggestion.ecosystemId).toBe(component?.ecosystemId);
    }
  });

  it("suggests documented interoperable DFR partners without changing ownership", () => {
    const droneSense = suggestComponentsForEcosystems(["dronesense"]);
    expect(droneSense.map((x) => x.componentId)).toEqual(expect.arrayContaining([
      "dji_uas", "skydio_uas", "autel_enterprise_uas", "parrot_anafi",
    ]));
    const versaterm = suggestComponentsForEcosystems(["versaterm"]);
    expect(versaterm.map((x) => x.componentId)).toContain("sifly_long_endurance_uas");
    expect(findCatalogComponent("sifly_long_endurance_uas")?.ecosystemId).toBe("sifly");
  });

  it("is deterministic and deduplicates overlapping selections", () => {
    const a = suggestComponentsForEcosystems(["dronesense", "dji"]);
    const b = suggestComponentsForEcosystems(["dronesense", "dji"]);
    expect(a).toEqual(b);
    const ids = a.map((s) => s.componentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("unknown ecosystem IDs add nothing (default deny)", () => {
    expect(suggestComponentsForEcosystems([])).toEqual([]);
    expect(suggestComponentsForEcosystems(["unknown_vendor", "", "AXON"])).toEqual([]);
    const withNoise = suggestComponentsForEcosystems(["pulsiam", "unknown_vendor"]);
    const clean = suggestComponentsForEcosystems(["pulsiam"]);
    expect(withNoise).toEqual(clean);
  });
});

describe("confirmation never connects, authorizes, or grants access", () => {
  it("default integration state is in use but explicitly not connected and access-incapable", () => {
    const state = createDefaultIntegrationState();
    expect(state.usage).toBe("in_use");
    expect(state.connection).toBe("available_not_connected");
    expect(state.mode).toBe("manual_only");
    expect(state.authorized).toBe(false);
    expect(state.credentialed).toBe(false);
    expect(state.dataAccessCapable).toBe(false);
  });

  it("confirming a known component yields the default disconnected state", () => {
    const confirmed = confirmComponent("motorola_cad");
    expect(confirmed).not.toBeNull();
    expect(confirmed?.source).toBe("agency_confirmed");
    expect(confirmed?.integration.connection).toBe("available_not_connected");
    expect(confirmed?.integration.authorized).toBe(false);
    expect(confirmed?.integration.credentialed).toBe(false);
    expect(confirmed?.integration.dataAccessCapable).toBe(false);
  });

  it("accepting a suggestion produces a confirmed record that is still not connected", () => {
    const suggestion = suggestComponentsForEcosystems(["skydio"]).find(
      (s) => s.componentId === "skydio_dock",
    );
    expect(suggestion).toBeDefined();
    const confirmed = acceptSuggestion(suggestion!);
    expect(confirmed).not.toBeNull();
    expect(confirmed?.componentId).toBe("skydio_dock");
    expect(confirmed?.integration.connection).toBe("available_not_connected");
    expect(confirmed?.integration.authorized).toBe(false);
    expect(confirmed?.integration.credentialed).toBe(false);
    expect(confirmed?.integration.dataAccessCapable).toBe(false);
  });

  it("unknown component IDs cannot be confirmed (default deny)", () => {
    expect(confirmComponent("not_a_component")).toBeNull();
    expect(confirmComponent("")).toBeNull();
  });

  it("each confirmation returns an independent state object", () => {
    const first = confirmComponent("axon_digital_evidence");
    const second = confirmComponent("axon_digital_evidence");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.integration).not.toBe(second?.integration);
  });
});

describe("normalized capabilities", () => {
  it("deduplicates capabilities shared across vendors", () => {
    const capabilities = normalizedCapabilitiesForComponents([
      "motorola_cad",
      "pulsiam_cad",
      "skydio_uas",
      "dji_uas",
    ]);
    expect(new Set(capabilities).size).toBe(capabilities.length);
    expect(capabilities.filter((c) => c === "cad_incident_feed").length).toBe(1);
    expect(capabilities.filter((c) => c === "uas_telemetry").length).toBe(1);
  });

  it("returns only vendor-neutral capability keys", () => {
    const capabilities = normalizedCapabilitiesForComponents(
      CATALOG_COMPONENTS.map((c) => c.id),
    );
    for (const capability of capabilities) {
      expect(isAirsCapability(capability)).toBe(true);
      for (const vendor of VENDOR_TOKENS) {
        expect(capability.toLowerCase()).not.toContain(vendor);
      }
    }
  });

  it("unknown component IDs never widen capabilities (default deny)", () => {
    expect(normalizedCapabilitiesForComponents([])).toEqual([]);
    expect(normalizedCapabilitiesForComponents(["ghost_component"])).toEqual([]);
    const withNoise = normalizedCapabilitiesForComponents(["pulsiam_cad", "ghost_component"]);
    const clean = normalizedCapabilitiesForComponents(["pulsiam_cad"]);
    expect(withNoise).toEqual(clean);
  });
});

describe("integration-state vocabulary", () => {
  it("supports the full agency vocabulary across compatible dimensions", () => {
    expect(USAGE_STATUSES).toContain("in_use");
    expect(USAGE_STATUSES).toContain("planned");
    expect(CONNECTION_STATUSES).toContain("connected_to_airs");
    expect(CONNECTION_STATUSES).toContain("available_not_connected");
    expect(INTEGRATION_MODES).toContain("read_only");
    expect(INTEGRATION_MODES).toContain("bidirectional");
    expect(INTEGRATION_MODES).toContain("manual_only");
  });
});
