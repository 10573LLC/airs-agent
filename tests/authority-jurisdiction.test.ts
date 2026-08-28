import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_FILES, REPO_ROOT } from "../scripts/lib/migrate-plan.mjs";
import {
  LIFE_SAFETY_AUTHORITY_NOTE,
  suggestAuthorities,
  suggestThreatHypotheses,
} from "../src/lib/authority/jurisdiction";

const migration = readFileSync(`${REPO_ROOT}/db/migrations/0015_authority_jurisdiction_threats.sql`, "utf8");
const route = readFileSync(`${REPO_ROOT}/src/routes/incidents.$incidentId.command.tsx`, "utf8");
const simulation = readFileSync(`${REPO_ROOT}/src/lib/simulation/model.ts`, "utf8");

describe("authority and jurisdiction layer", () => {
  it("places the authority stage after ICS command operations and before planned operations", () => {
    const ics = MIGRATION_FILES.indexOf("db/migrations/0014_ics_command_operations.sql");
    const authority = MIGRATION_FILES.indexOf("db/migrations/0015_authority_jurisdiction_threats.sql");
    const planned = MIGRATION_FILES.indexOf("db/migrations/0016_planned_operations.sql");
    expect(ics).toBeLessThan(authority);
    expect(authority).toBeLessThan(planned);
  });

  it("keeps incident authority and hypotheses tenant-owned with partner read access", () => {
    expect(migration).toContain("CREATE TABLE airs.incident_authorities");
    expect(migration).toContain("CREATE TABLE airs.incident_threat_hypotheses");
    expect(migration).toContain("airs.has_incident_access(incident_id)");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).not.toContain("platform_admin");
  });

  it("does not equate life safety with fire jurisdiction", () => {
    expect(LIFE_SAFETY_AUTHORITY_NOTE).toContain("incident objective, not a jurisdiction");
    const rows = suggestAuthorities("Coordinated UAS attack causes fire, mass casualties, and people in the river.");
    expect(rows.some((r) => r.key === "fire-rescue")).toBe(true);
    expect(rows.some((r) => r.key === "law-enforcement-threat")).toBe(true);
    expect(rows.find((r) => r.key === "fire-rescue")?.limitations).toMatch(/does not make 'life safety' exclusively a fire jurisdiction/i);
  });

  it("separates FAA, maritime, hostile-threat, and Unified Command authority", () => {
    const rows = suggestAuthorities("Hostile drones attack a Navy ship on the Hudson River. FAA TFR and Unified Command are required.");
    for (const key of ["national-airspace", "maritime", "law-enforcement-threat", "military-asset", "unified-command"])
      expect(rows.some((r) => r.key === key)).toBe(true);
    expect(rows.find((r) => r.key === "unified-command")?.limitations).toMatch(/does not erase individual agency authority/i);
  });

  it("keeps a secondary assault as an explicit hypothesis rather than a fact", () => {
    const rows = suggestThreatHypotheses("A coordinated swarm of multiple UAS with attached payloads impacts the target and explosions occur.");
    const secondary = rows.find((r) => r.hypothesisType === "secondary_assault");
    expect(secondary).toBeTruthy();
    expect(secondary?.confidence).not.toBe("high");
    expect(secondary?.sourceBasis).toMatch(/not a factual assertion/i);
    expect(rows.some((r) => r.hypothesisType === "responder_targeting")).toBe(true);
  });

  it("makes authority and unresolved hypotheses visible in the live command console", () => {
    expect(route).toContain("Authority / Agency Coordination");
    expect(route).toContain("Life safety is an objective, not a jurisdiction");
    expect(route).toContain("AIRS hypotheses — not facts");
    expect(route).toContain("Record authority manually");
    expect(route).toContain("Record threat hypothesis manually");
  });

  it("keeps rescue and hostile-threat operations concurrent in simulation reasoning", () => {
    expect(simulation).toContain("rescue/medical life-safety operations and hostile-threat/security operations concurrently");
    expect(simulation).toContain("secondary/follow-on assault hypothesis");
    expect(simulation).not.toContain("Albany Fire retains life-safety IC role");
  });
});
