import { describe, expect, it } from "vitest";

import { activeIncidentResourceIds, buildIncidentResourceRoster } from "./incident-resources";

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: "assignment-1",
  assignmentType: "resource",
  resourceId: "resource-1",
  label: "Drone 1",
  status: "assigned",
  ownerOrgName: null,
  ...overrides,
});

describe("incident resource roster", () => {
  it("keeps only active resource assignments", () => {
    const ids = activeIncidentResourceIds([
      assignment(),
      assignment({ id: "released", resourceId: "resource-2", status: "released" }),
      assignment({ id: "person", assignmentType: "person", resourceId: null }),
    ]);
    expect([...ids]).toEqual(["resource-1"]);
  });

  it("reports a visible current position", () => {
    const roster = buildIncidentResourceRoster(
      [assignment()],
      [{ resourceId: "resource-1", geometry: { type: "Point" }, freshness: "fresh" }],
    );
    expect(roster[0]?.locationState).toBe("reported");
    expect(roster[0]?.freshness).toBe("fresh");
  });

  it("distinguishes withheld geography from no location report", () => {
    const withheld = buildIncidentResourceRoster(
      [assignment()],
      [{ resourceId: "resource-1", freshness: "recent" }],
    );
    const missing = buildIncidentResourceRoster([assignment()], []);

    expect(withheld[0]?.locationState).toBe("withheld");
    expect(missing[0]?.locationState).toBe("not_reported");
  });

  it("does not retain a released assignment in the COP roster", () => {
    const roster = buildIncidentResourceRoster(
      [assignment({ status: "released" })],
      [{ resourceId: "resource-1", geometry: { type: "Point" } }],
    );
    expect(roster).toEqual([]);
  });
});
