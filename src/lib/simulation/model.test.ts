import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessAirs,
  buildSimulationState,
  compileScenario,
  injectFriction,
  nextEventTime,
  visibleEvents,
} from "./model";

const portScenario = readFileSync(
  resolve(process.cwd(), "tests/fixtures/port-of-albany-scenario.md"),
  "utf8",
);
const plainPortScenario = portScenario
  .replaceAll("**", "")
  .replace(/^##\s+/gm, "")
  .replace(/^---$/gm, "")
  .replace(/\n/g, "\r\n");

describe("timeline-aware simulation model", () => {
  it("parses the controller timeline instead of inventing synthetic events", () => {
    const scenario = compileScenario(portScenario);
    expect(scenario.events).toHaveLength(16);
    expect(scenario.events[0]?.timeLabel).toBe("T+0:00");
    expect(scenario.events.some((event) => event.headline.includes("Weather"))).toBe(false);
    expect(scenario.events.every((event) => event.provenance === "scenario_fact")).toBe(true);
  });
  it("parses plain-text browser paste without collapsing the exercise into T+0", () => {
    const scenario = compileScenario(plainPortScenario);
    expect(scenario.events).toHaveLength(16);
    expect(nextEventTime(scenario, 0)).toBe(60);
    expect(visibleEvents(scenario, 0)).toHaveLength(1);
    expect(JSON.stringify(visibleEvents(scenario, 0))).not.toMatch(/Temporary Flight Restriction|Unified Command|Corning Preserve/i);
    expect(visibleEvents(scenario, 18 * 60).some((event) => /Temporary Flight Restriction/i.test(event.detail))).toBe(true);
  });

  it("treats exercise timestamps as hours and minutes and withholds future facts", () => {
    const scenario = compileScenario(portScenario);
    expect(scenario.events.find((event) => event.timeLabel === "T+0:18")?.atSeconds).toBe(18 * 60);
    expect(scenario.events.find((event) => event.timeLabel === "T+1:00–2:00")?.atSeconds).toBe(60 * 60);
    expect(visibleEvents(scenario, 17 * 60).some((event) => /Temporary Flight Restriction/i.test(event.detail))).toBe(false);
    expect(visibleEvents(scenario, 18 * 60).some((event) => /Temporary Flight Restriction/i.test(event.detail))).toBe(true);
  });

  it("recognizes the initiating UAS threat at T+0 without seeing later outcomes", () => {
    const scenario = compileScenario(portScenario);
    const state = buildSimulationState(scenario, 0);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.source).toBe("Airspace/C-UAS");
    expect(state.airspaceStatus).toMatch(/coordinated UAS threat/i);
    expect(JSON.stringify(state)).not.toMatch(/TFR|Unified Command|civilian UAS|fuel or oil/i);
  });

  it("evolves airspace state when the attack and later civilian clutter are released", () => {
    const scenario = compileScenario(portScenario);
    expect(buildSimulationState(scenario, 4 * 60).airspaceStatus).toMatch(/hostile UAS attack confirmed/i);
    expect(buildSimulationState(scenario, 20 * 60).airspaceStatus).toMatch(/contested restricted airspace/i);
  });
  it("separates reported functional authority from incident-established authority", () => {
    const scenario = compileScenario(portScenario);
    const early = buildSimulationState(scenario, 9 * 60).authorities;
    expect(early.some((item) => item.domain === "Hostile threat / criminal enforcement" && item.status === "reported")).toBe(true);
    expect(early.some((item) => item.domain === "Fire / rescue / EMS function" && item.status === "reported")).toBe(true);
    expect(early.some((item) => item.domain === "Waterway / marine security")).toBe(false);
    expect(early.some((item) => item.domain === "National airspace restriction" && item.owner === "FAA" && item.status === "established")).toBe(true);
    expect(buildSimulationState(scenario, 10 * 60).authorities.some((item) => item.domain === "Waterway / marine security")).toBe(true);
    expect(buildSimulationState(scenario, 17 * 60).authorities.some((item) => item.domain === "National airspace restriction")).toBe(true);
    expect(buildSimulationState(scenario, 18 * 60).authorities.some((item) => item.owner === "FAA")).toBe(true);
    expect(buildSimulationState(scenario, 30 * 60).authorities.some((item) => item.owner === "Unified Command")).toBe(true);
  });

  it("keeps controller injects distinct from scenario facts", () => {
    const scenario = compileScenario(portScenario);
    const injected = injectFriction(scenario, 20 * 60);
    const controller = injected.events.find((event) => event.provenance === "controller_inject");
    expect(controller?.source).toBe("Exercise Control");
    expect(controller?.confidence).toBe("conflicting");
    expect(controller?.atSeconds).toBeGreaterThan(20 * 60);
  });

  it("advances to the next authored event rather than an arbitrary clock tick", () => {
    const scenario = compileScenario(portScenario);
    expect(nextEventTime(scenario, 0)).toBe(60);
    expect(nextEventTime(scenario, 18 * 60)).toBe(20 * 60);
    expect(assessAirs(visibleEvents(scenario, 0), buildSimulationState(scenario, 0))[0]?.items.join(" ")).not.toMatch(/No airspace status/i);
  });
});