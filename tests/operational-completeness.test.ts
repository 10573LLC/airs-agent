import { describe, expect, it } from "vitest";
import {
  buildOperationalPicture,
  AIRS_COMPLETENESS_PILLARS,
  ICS_COMPLETENESS_CONCERNS,
} from "../src/lib/operational/completeness";

const base = {
  incidentName: "Search response",
  incidentStatus: "Active response",
  commandLead: "Incident coordination established",
  priority: "Locate and reach the victim",
  agencies: [],
  resources: [],
  mapItems: [],
  actions: [],
};

describe("AIRS + ICS operational completeness", () => {
  it("uses AIRS and ICS as completeness frameworks without requiring an ICS-shaped presentation", () => {
    expect(AIRS_COMPLETENESS_PILLARS).toEqual([
      "Awareness",
      "Intelligence",
      "Response",
      "Security",
    ]);
    expect(ICS_COMPLETENESS_CONCERNS).toContain("resource accountability");
    expect(ICS_COMPLETENESS_CONCERNS).toContain("location and geography");
    expect(ICS_COMPLETENESS_CONCERNS).toContain("time and change");
  });

  it("flags a victim mentioned in source information when no victim location reaches the COP", () => {
    const picture = buildOperationalPicture({
      ...base,
      sourceText: "Caller reports an injured victim behind the warehouse. Officers are responding.",
    });
    expect(picture.peopleAndAssets.join(" ")).toMatch(/victim\/person involvement/i);
    expect(picture.gaps).toContain(
      "Victim/person location is not represented in the common operating picture.",
    );
    expect(picture.locations[0]).toMatch(/location picture incomplete/i);
  });

  it("flags operational resources whose current location is unknown", () => {
    const picture = buildOperationalPicture({
      ...base,
      resources: [
        {
          id: "unit-1",
          name: "Team Alpha",
          owner: "Agency",
          category: "Ground team",
          status: "en_route" as const,
          sinceSeconds: 120,
          location: "Exact unit position not reported",
        },
      ],
    });
    expect(picture.gaps.join(" ")).toMatch(
      /1 operational resource.*lack a current usable location/i,
    );
  });

  it("produces a concise operational picture when location and action information are available", () => {
    const picture = buildOperationalPicture({
      ...base,
      mapItems: [
        {
          id: "victim",
          label: "Victim location",
          geometry: { type: "Point", coordinates: [-73.75, 42.65] },
          tone: "position" as const,
          detail: "Confirmed victim position.",
        },
      ],
      resources: [
        {
          id: "team-a",
          name: "Team Alpha",
          owner: "Agency",
          category: "Ground team",
          status: "on_scene" as const,
          sinceSeconds: 120,
          location: "180 feet east of victim",
        },
      ],
      actions: [
        {
          id: "reach-victim",
          atSeconds: 180,
          actor: "Team Alpha",
          action: "Approach victim from east",
          target: "Victim",
          channel: "Incident workspace" as const,
          status: "active" as const,
        },
      ],
      sourceText: "Victim is located and Team Alpha is moving to the victim.",
    });
    expect(picture.locations.join(" ")).toContain("Victim location");
    expect(picture.nextActions.join(" ")).toContain("Approach victim from east");
    expect(picture.timing).toContain("T+0:03");
    expect(picture.gaps).not.toContain(
      "Victim/person location is not represented in the common operating picture.",
    );
  });
});
