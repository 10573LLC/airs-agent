import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { INCIDENT_TYPES, canTransition } from "../src/lib/incidents/lifecycle";
import { MIGRATION_FILES } from "../scripts/lib/migrate-plan.mjs";
import { compileScenario, buildSimulationState } from "../src/lib/simulation/model";
import { buildOperationalProjection } from "../src/lib/simulation/operational";

const ROOT = process.cwd();
const migration = readFileSync(`${ROOT}/db/migrations/0016_planned_operations.sql`, "utf8");
const server = readFileSync(`${ROOT}/src/lib/incidents/ics.server.ts`, "utf8");
const route = readFileSync(`${ROOT}/src/routes/incidents.$incidentId.command.tsx`, "utf8");
const scenarioText = readFileSync(`${ROOT}/tests/fixtures/port-of-albany-scenario.md`, "utf8");

describe("preplanned operations", () => {
  it("uses the existing planned-event lifecycle before an emergency", () => {
    expect(INCIDENT_TYPES).toContain("planned_event");
    expect(canTransition("draft", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "active")).toBe(true);
  });

  it("adds operational condition and a non-authorizing coordination roster", () => {
    expect(MIGRATION_FILES.at(-1)).toBe("db/migrations/0016_planned_operations.sql");
    expect(migration).toMatch(/operational_condition.*nominal/s);
    expect(migration).toMatch(/incident_coordination_partners/);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/does NOT create incident access/i);
  });
  it("keeps external coordination separate from AIRS authorization", () => {
    expect(server).toMatch(/incident_coordination_partners/);
    expect(server).toMatch(/addCoordinationPartner/);
    expect(route).toMatch(/Roster presence is operational context only/);
    expect(route).toMatch(/never grants AIRS access/);
    expect(route).toMatch(/AIRS-authorized agency participation/);
  });

  it("lets a planned event run nominally before emergency escalation", () => {
    expect(route).toMatch(/PRE-EVENT READY/);
    expect(route).toMatch(/EVENT OPERATIONS LIVE/);
    expect(route).toMatch(/EVENT \+ INCIDENT RESPONSE/);
    expect(route).toMatch(/operationalCondition/);
  });

  it("starts the naval scenario with protected airspace and C-UAS already active", () => {
    const scenario = compileScenario(scenarioText);
    const state = buildSimulationState(scenario, 0);
    const view = buildOperationalProjection(scenario, 0);
    expect(state.authorities.some((row) => row.domain === "National airspace restriction" && row.owner === "FAA")).toBe(true);
    expect(state.airspaceStatus).toMatch(/pre-existing protected naval airspace/i);
    expect(view.mapItems.some((row) => row.id === "naval-security-airspace")).toBe(true);
    expect(view.resources.some((row) => row.id === "cuas-baseline" && row.status === "active")).toBe(true);
  });
});
