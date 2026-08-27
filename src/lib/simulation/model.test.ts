import { describe, expect, it } from "vitest";
import { assessAirs, compileScenario, injectFriction, visibleEvents } from "./model";

describe("simulation model", () => {
  it("compiles a scenario without inventing a live connection", () => {
    const scenario = compileScenario("Building collapse with injuries and an unknown drone nearby.");
    expect(scenario.events.some((e) => e.source === "C-UAS")).toBe(true);
    expect(scenario.events.some((e) => e.source === "EMS/Fire")).toBe(true);
    expect(JSON.stringify(scenario)).not.toMatch(/credentialed|connected.*true|authorized.*true/i);
  });

  it("reveals events only when the exercise clock reaches them", () => {
    const scenario = compileScenario("Vehicle crash");
    expect(visibleEvents(scenario, 0)).toHaveLength(1);
    expect(visibleEvents(scenario, 60).every((e) => e.atSeconds <= 60)).toBe(true);
  });

  it("preserves conflicting information as uncertainty", () => {
    const scenario = compileScenario("Mass casualty crash with injured patients");
    const assessment = assessAirs(visibleEvents(scenario, 120));
    expect(assessment.find((row) => row.pillar === "Intelligence")?.summary).toMatch(/unresolved|conflicting/i);
  });

  it("injects friction after the current exercise time", () => {
    const scenario = compileScenario("Suspicious activity");
    const injected = injectFriction(scenario, 90);
    expect(injected.events.some((e) => e.confidence === "conflicting" && e.atSeconds > 90)).toBe(true);
  });
});