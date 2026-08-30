import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { previewHasPermission, previewRoleSummary, previewWalkthroughRole } from "../src/lib/simulation/agency-preview";

const root = process.cwd();
const component = readFileSync(resolve(root, "src/components/simulation/agency-preview-session.tsx"), "utf8");
const route = readFileSync(resolve(root, "src/routes/simulation.tsx"), "utf8");

describe("exercise agency preview", () => {
  it("uses production role permissions rather than granting preview authority", () => {
    expect(previewHasPermission("incident_commander", "incident.update")).toBe(true);
    expect(previewHasPermission("incident_commander", "resource.assign_incident")).toBe(true);
    expect(previewHasPermission("rpic", "observation.create")).toBe(true);
    expect(previewHasPermission("rpic", "incident.update")).toBe(false);
    expect(previewHasPermission("partner_agency_user", "observation.create")).toBe(false);
    expect(previewRoleSummary("partner_agency_user").canReadMap).toBe(true);
  });

  it("maps preview identities only to exercise actor labels", () => {
    expect(previewWalkthroughRole("incident_commander")).toBe("incident_command");
    expect(previewWalkthroughRole("dispatcher")).toBe("dispatch_rtcc");
    expect(previewWalkthroughRole("rpic")).toBe("airspace_operator");
  });

  it("is simulation-only and cannot call live agency write functions", () => {
    expect(component).toContain("EXERCISE AGENCY SESSION");
    expect(component).not.toContain("ROLE_PERMISSIONS");
    expect(component).not.toMatch(/@\/lib\/api\/|useServerFn|useMutation/);
    expect(component).not.toMatch(/createIncident|createObservationFn|createMapFeatureFn|setResourceStatusFn/);
    expect(route).toContain("AgencyPreviewSession");
    expect(route).toContain("canRunSimulation(roleKey)");
  });

  it("reuses live AIRS domain vocabularies for agency-facing forms", () => {
    expect(component).toContain("OBSERVATION_TYPES");
    expect(component).toContain("OBSERVATION_SOURCES");
    expect(component).toContain("RESOURCE_CATEGORIES");
    expect(component).toContain("CATEGORY_STATUSES");
    expect(component).toContain("MAP_FEATURE_TYPES");
    expect(component).toContain("system_integration");
    expect(component).toContain("manual_entry");
  });
});
