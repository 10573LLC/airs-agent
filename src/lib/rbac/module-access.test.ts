import { describe, expect, it } from "vitest";
import { canAccessPrimaryModule, canRunSimulation, isAgencyOperationalRole } from "./module-access";

describe("module access", () => {
  it("keeps platform administration out of agency operational modules", () => {
    const platformPermissions = ["org.manage", "user.manage", "audit.read", "retention.manage"];
    expect(canAccessPrimaryModule("console", "platform_admin", platformPermissions)).toBe(true);
    expect(canAccessPrimaryModule("simulation", "platform_admin", platformPermissions)).toBe(true);
    expect(canAccessPrimaryModule("incidents", "platform_admin", platformPermissions)).toBe(false);
    expect(canAccessPrimaryModule("resources", "platform_admin", platformPermissions)).toBe(false);
    expect(canAccessPrimaryModule("map", "platform_admin", platformPermissions)).toBe(false);
    expect(canAccessPrimaryModule("awareness", "platform_admin", platformPermissions)).toBe(false);
  });

  it("uses agency permissions for agency module visibility", () => {
    const permissions = ["incident.read", "resource.read", "map.read", "observation.read"];
    expect(canAccessPrimaryModule("incidents", "agency_admin", permissions)).toBe(true);
    expect(canAccessPrimaryModule("resources", "agency_admin", permissions)).toBe(true);
    expect(canAccessPrimaryModule("map", "agency_admin", permissions)).toBe(true);
    expect(canAccessPrimaryModule("awareness", "agency_admin", permissions)).toBe(true);
  });

  it("keeps platform administration outside agency operational context", () => {
    expect(isAgencyOperationalRole("platform_admin")).toBe(false);
    expect(isAgencyOperationalRole("agency_admin")).toBe(true);
    expect(isAgencyOperationalRole("rpic")).toBe(true);
  });

  it("limits exercise control to platform or command roles", () => {
    expect(canRunSimulation("platform_admin")).toBe(true);
    expect(canRunSimulation("agency_admin")).toBe(true);
    expect(canRunSimulation("airspace_supervisor")).toBe(true);
    expect(canRunSimulation("dispatcher")).toBe(true);
    expect(canRunSimulation("incident_commander")).toBe(true);
    expect(canRunSimulation("rpic")).toBe(false);
    expect(canRunSimulation("visual_observer")).toBe(false);
    expect(canRunSimulation("partner_agency_user")).toBe(false);
  });
});