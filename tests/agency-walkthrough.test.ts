import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const component = readFileSync(resolve(root, "src/components/simulation/agency-walkthrough.tsx"), "utf8");
const route = readFileSync(resolve(root, "src/routes/simulation.tsx"), "utf8");
const model = readFileSync(resolve(root, "src/lib/simulation/walkthrough.ts"), "utf8");

describe("agency walkthrough isolation", () => {
  it("is explicitly exercise-only and does not import live write APIs", () => {
    expect(component).toContain("No real agency authorization, records, connectors, or evidence are touched");
    expect(component).not.toMatch(/incidents\.functions|awareness\.functions|resources\.functions|map\.functions/);
    expect(component).not.toMatch(/useServerFn|useMutation/);
  });

  it("keeps the walkthrough inside Simulation Lab authorization", () => {
    expect(route).toContain("canRunSimulation(roleKey)");
    expect(route).toContain("AgencyWalkthrough");
    expect(route).not.toContain("addIncidentResourceRequestFn");
    expect(route).not.toContain("createMapFeatureFn");
  });
  it("uses information paths rather than agency connectivity semantics", () => {
    expect(model).toContain("informationPath");
    expect(model).toContain("Workspace access and technical integration remain separate");
    expect(model).not.toContain("airs_room");
    expect(model).not.toContain("connectionMode");
  });
});
