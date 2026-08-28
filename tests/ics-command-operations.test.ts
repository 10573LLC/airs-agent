import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_FILES, REPO_ROOT } from "../scripts/lib/migrate-plan.mjs";

const migration = readFileSync(`${REPO_ROOT}/db/migrations/0014_ics_command_operations.sql`, "utf8");
const service = readFileSync(`${REPO_ROOT}/src/lib/incidents/ics.server.ts`, "utf8");
const route = readFileSync(`${REPO_ROOT}/src/routes/incidents.$incidentId.command.tsx`, "utf8");

describe("ICS command operations", () => {
  it("keeps the ICS command plane after agency systems and before authority/jurisdiction", () => {
    expect(MIGRATION_FILES).toContain("db/migrations/0014_ics_command_operations.sql");
    expect(MIGRATION_FILES.indexOf("db/migrations/0013_agency_system_profiles.sql")).toBeLessThan(MIGRATION_FILES.indexOf("db/migrations/0014_ics_command_operations.sql"));
    expect(MIGRATION_FILES.indexOf("db/migrations/0014_ics_command_operations.sql")).toBeLessThan(MIGRATION_FILES.indexOf("db/migrations/0015_authority_jurisdiction_threats.sql"));
    for (const table of ["incident_ics_profiles", "incident_ics_objectives", "incident_ics_positions", "incident_resource_requests"]) expect(migration).toContain(`CREATE TABLE airs.${table}`);
  });

  it("lets active incident participants read but keeps writes with the originating agency", () => {
    expect(migration).toContain("airs.has_incident_access(incident_id)");
    expect(migration).toContain("USING (org_id = airs.current_org_id()) WITH CHECK (org_id = airs.current_org_id())");
    expect(migration).not.toContain("platform_admin");
  });

  it("routes ICS reads and writes through existing incident authorization", () => {
    expect(service).toContain('action: "read"');
    expect(service).toContain('action: "update"');
    expect(service).toContain("withIncidentAction");
  });

  it("renders a live manual command console rather than simulation state", () => {
    expect(route).toContain("LIVE INCIDENT");
    expect(route).toContain("MANUAL + AIRS DATA");
    expect(route).toContain("ICS Command");
    expect(route).toContain("Common Operating Picture");
    expect(route).toContain("Resource Requests");
    expect(route).toContain("Outside agencies can still be represented through ICS and requests");
    expect(route).not.toContain("SIMULATION MODE");
  });

  it("models the core ICS constructs needed for command-post operations", () => {
    for (const value of ["single", "unified", "operations", "planning", "logistics", "finance_admin", "branch", "division", "group", "staging_area"]) expect(migration).toContain(`'${value}'`);
    expect(migration).toContain("operational_period_start");
    expect(migration).toContain("situation_summary");
    expect(migration).toContain("safety_message");
  });
});
