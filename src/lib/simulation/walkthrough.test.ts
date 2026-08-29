import { describe, expect, it } from "vitest";
import { assessAirs } from "./model";
import type { SimOperationalProjection } from "./operational";
import { applyWalkthroughEntries, walkthroughEvents, type SimWalkthroughEntry } from "./walkthrough";

const base: SimOperationalProjection = {
  incidentName: "Exercise",
  incidentStatus: "Incoming report",
  commandLead: "Not established",
  priority: "Awaiting classification",
  agencies: [], resources: [], mapItems: [], actions: [],
};

describe("agency walkthrough exercise input", () => {
  it("marks agency input as exercise provenance", () => {
    const entries: SimWalkthroughEntry[] = [{ id: "obs-1", atSeconds: 120, role: "dispatch_rtcc", kind: "observation", source: "911/CAD", title: "Caller reports UAS", detail: "Multiple callers report a low UAS near the port.", confidence: "reported" }];
    const events = walkthroughEvents(entries);
    expect(events[0]).toMatchObject({ atSeconds: 120, source: "911/CAD", provenance: "agency_entry", confidence: "reported" });
    const awareness = assessAirs(events)[0];
    expect(awareness.summary).toMatch(/exercise inputs/);
    expect(awareness.items[0]).toContain("1 agency entry");
  });

  it("projects command, resource, coordination, and COP entries without inventing access", () => {
    const entries: SimWalkthroughEntry[] = [
      { id: "cmd", atSeconds: 60, role: "incident_command", kind: "command_update", situation: "Perimeter established.", commandLead: "Unified Command forming", priority: "Protect airspace" },
      { id: "res", atSeconds: 60, role: "incident_command", kind: "resource_request", resourceName: "Bomb team", quantity: 1, requestedFrom: "New York State Police" },
      { id: "org", atSeconds: 60, role: "agency_admin", kind: "coordination", organizationName: "FAA", operationalRole: "Airspace coordination", informationPath: "command_post_liaison" },
      { id: "map", atSeconds: 60, role: "airspace_operator", kind: "map_report", label: "Reported UAS", detail: "Visual report only.", latitude: 42.65, longitude: -73.75 },
    ];
    const projection = applyWalkthroughEntries(base, entries, 60);
    expect(projection.commandLead).toBe("Unified Command forming");
    expect(projection.priority).toBe("Protect airspace");
    expect(projection.resources[0]).toMatchObject({ name: "1 × Bomb team", status: "requested", location: "Location not reported" });
    expect(projection.agencies[0]).toMatchObject({ name: "FAA", informationPath: "command_post_liaison", status: "active" });
    expect(projection.agencies[0].coordination).toMatch(/Workspace access and technical integration remain separate/);
    expect(projection.mapItems[0].geometry).toEqual({ type: "Point", coordinates: [-73.75, 42.65] });
    expect(projection.actions).toHaveLength(4);
  });

  it("does not release future agency entries before their exercise time", () => {
    const entries: SimWalkthroughEntry[] = [{ id: "later", atSeconds: 300, role: "agency_admin", kind: "coordination", organizationName: "Partner", operationalRole: "Support", informationPath: "command_post_liaison" }];
    expect(applyWalkthroughEntries(base, entries, 299).agencies).toHaveLength(0);
    expect(applyWalkthroughEntries(base, entries, 300).agencies).toHaveLength(1);
  });
});
