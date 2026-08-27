import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScenario } from "./model";
import { buildOperationalProjection } from "./operational";

const source = readFileSync(resolve(process.cwd(), "tests/fixtures/port-of-albany-scenario.md"), "utf8");
const scenario = compileScenario(source);

describe("operational simulation projection", () => {
  it("shows an incoming threat before the local command post exists", () => {
    const view = buildOperationalProjection(scenario, 0);
    expect(view.incidentStatus).toBe("Incoming report / not yet organized");
    expect(view.commandLead).toBe("Not yet established");
    expect(view.mapItems.some((item) => item.id === "uas-east-vector")).toBe(true);
    expect(view.agencies.some((item) => item.id === "afd")).toBe(false);
  });

  it("spins up the room and local participants as facts arrive", () => {
    const view = buildOperationalProjection(scenario, 8 * 60);
    expect(view.incidentStatus).toMatch(/initial command/i);
    expect(view.actions.some((item) => item.id === "room-create")).toBe(true);
    expect(view.agencies.find((item) => item.id === "afd")?.connection).toBe("airs_room");
    expect(view.agencies.find((item) => item.id === "apd")?.status).toBe("active");
  });
  it("represents non-AIRS agencies through external coordination paths", () => {
    const view = buildOperationalProjection(scenario, 18 * 60);
    expect(view.agencies.find((item) => item.id === "uscg")?.connection).toBe("external_liaison");
    expect(view.agencies.find((item) => item.id === "ncis")?.connection).toBe("external_liaison");
    expect(view.agencies.find((item) => item.id === "faa")?.connection).toBe("external_liaison");
    expect(view.actions.some((item) => item.id === "uscg-liaison")).toBe(true);
  });

  it("turns airspace requests into visible resources and COP changes", () => {
    const view = buildOperationalProjection(scenario, 20 * 60);
    expect(view.resources.some((item) => item.id === "cuas-element" && item.status === "requested")).toBe(true);
    expect(view.resources.some((item) => item.id === "nysp-aviation")).toBe(true);
    expect(view.mapItems.some((item) => item.id === "tfr")).toBe(true);
    expect(view.mapItems.some((item) => item.id === "civilian-uas-launch")).toBe(true);
    expect(view.actions.some((item) => item.id === "airspace-classification")).toBe(true);
  });

  it("builds Unified Command and later specialized requests without inventing exact positions", () => {
    const view = buildOperationalProjection(scenario, 35 * 60);
    expect(view.incidentStatus).toBe("Active Unified Command");
    expect(view.agencies.some((item) => item.id === "acso")).toBe(true);
    expect(view.resources.find((item) => item.id === "wmd-cst-team")?.location).toMatch(/not reported/i);
    expect(view.mapItems.some((item) => item.id === "unified-command")).toBe(true);
  });
});