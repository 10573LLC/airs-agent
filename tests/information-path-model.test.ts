import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_FILES, REPO_ROOT } from "../scripts/lib/migrate-plan.mjs";

const migration = readFileSync(`${REPO_ROOT}/db/migrations/0017_information_path_model.sql`, "utf8");
const service = readFileSync(`${REPO_ROOT}/src/lib/incidents/ics.server.ts`, "utf8");
const route = readFileSync(`${REPO_ROOT}/src/routes/incidents.$incidentId.command.tsx`, "utf8");
const simulation = readFileSync(`${REPO_ROOT}/src/lib/simulation/operational.ts`, "utf8");
const systemCatalog = readFileSync(`${REPO_ROOT}/src/lib/resources/technology-ecosystem-catalog.ts`, "utf8");

describe("organization representation and information-path model", () => {
  it("migrates the roster away from agency connectivity semantics", () => {
    expect(MIGRATION_FILES.at(-1)).toBe("db/migrations/0017_information_path_model.sql");
    expect(migration).toContain("RENAME COLUMN connection_mode TO information_path");
    expect(migration).toContain("system_integration");
    expect(migration).toContain("command_post_liaison");
    expect(migration).toContain("mutual_aid_coordination");
  });

  it("uses information paths in current server and UI models", () => {
    expect(service).toContain("COORDINATION_INFORMATION_PATHS");
    expect(service).toContain("informationPath");
    expect(service).not.toContain("connectionMode");
    expect(route).toContain("Information path");
    expect(route).toContain("Incident workspace access");
    expect(route).toContain("does not define workspace access and does not imply a technical system integration");
  });
  it("keeps simulation organization paths separate from platform membership", () => {
    expect(simulation).toContain("SimAgencyInformationPath");
    expect(simulation).toContain("informationPath");
    expect(simulation).not.toContain("airs_room");
    expect(simulation).not.toContain("SimAgencyConnection");
  });

  it("retains connection semantics only for actual technical integrations", () => {
    expect(systemCatalog).toContain("interface IntegrationState");
    expect(systemCatalog).toContain("connection:");
    expect(systemCatalog).toContain("authorized:");
    expect(systemCatalog).toContain("credentialed:");
  });
});
