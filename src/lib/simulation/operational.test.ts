import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScenario } from "./model";
import { buildOperationalProjection } from "./operational";

const source = readFileSync(resolve(process.cwd(), "tests/fixtures/port-of-albany-scenario.md"), "utf8");
const scenario = compileScenario(source);
const plainScenario = compileScenario(
  source.replaceAll("**", "").replace(/^##\s+/gm, "").replace(/^---$/gm, "").replace(/\n/g, "\r\n"),
);

describe("operational simulation projection", () => {
  it("shows an incoming threat before the local command post exists", () => {
    const view = buildOperationalProjection(scenario, 0);
    expect(view.incidentStatus).toBe("Incoming report / not yet organized");
    expect(view.commandLead).toBe("Not yet established");
    expect(view.mapItems.some((item) => item.id === "uas-east-vector")).toBe(true);
    expect(view.mapItems.some((item) => item.id === "naval-security-airspace")).toBe(true);
    expect(view.resources.some((item) => item.id === "cuas-baseline" && item.status === "active")).toBe(true);
    expect(view.actions.some((item) => item.id === "naval-airspace-baseline")).toBe(true);
    expect(view.actions.some((item) => item.id === "cuas-monitoring-baseline")).toBe(true);
    expect(view.agencies.some((item) => item.id === "afd")).toBe(false);
  });

  it("does not leak future COP layers when the scenario is pasted as plain text", () => {
    const view = buildOperationalProjection(plainScenario, 0);
    expect(view.mapItems.some((item) => item.id === "tfr")).toBe(false);
    expect(view.mapItems.some((item) => item.id === "civilian-uas-launch")).toBe(false);
    expect(view.mapItems.some((item) => item.id === "unified-command")).toBe(false);
    expect(view.mapItems.some((item) => item.id === "uas-east-vector")).toBe(true);
  });

  it("spins up the room and local participants as facts arrive", () => {
    const view = buildOperationalProjection(scenario, 8 * 60);
    expect(view.incidentStatus).toMatch(/initial command/i);
    expect(view.actions.some((item) => item.id === "room-create")).toBe(true);
    expect(view.agencies.find((item) => item.id === "afd")?.informationPath).toBe("command_post");
    expect(view.agencies.find((item) => item.id === "apd")?.status).toBe("active");
  });
  it("represents organizations through information paths without implying agency connectivity", () => {
    const view = buildOperationalProjection(scenario, 18 * 60);
    expect(view.agencies.find((item) => item.id === "uscg")?.informationPath).toBe("command_post_liaison");
    expect(view.agencies.find((item) => item.id === "ncis")?.informationPath).toBe("command_post_liaison");
    expect(view.agencies.find((item) => item.id === "faa")?.informationPath).toBe("command_post_liaison");
    expect(view.actions.some((item) => item.id === "uscg-liaison")).toBe(true);
  });

  it("turns airspace requests into visible resources and COP changes", () => {
    const view = buildOperationalProjection(scenario, 20 * 60);
    expect(view.resources.some((item) => item.id === "cuas-baseline" && item.status === "active")).toBe(true);
    expect(view.resources.some((item) => item.id === "cuas-augmentation" && item.status === "active")).toBe(true);
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