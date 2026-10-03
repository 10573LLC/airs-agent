import {describe,it,expect} from "vitest";
import {resourceColor,featureColor,ICS_RESOURCE_COLORS as colors} from "@/lib/map/ics-colors";
describe("ICS display colors",()=>{
  it("uses explicit resource type, not the draft or assignment status",()=>{
    expect(resourceColor("EXERCISE Engine and rescue crew 1 · DRAFT assignment")).toBe(colors.engine.color);
    expect(resourceColor("EXERCISE Engine and rescue crew 1 · assigned destination")).toBe(colors.engine.color);
    expect(resourceColor("Ambulance and crew 1")).toBe(colors.equipment.color);
    expect(resourceColor("Emergency coordination team 1")).toBe(colors.crew.color);
  });
  it("keeps unspecified resources generic instead of assigning agency colors",()=>{
    expect(resourceColor("Unit 4")).toBe(colors.generic.color);
    expect(resourceColor(null)).toBe(colors.generic.color);
  });
  it("uses map-display colors separately from resource-card colors",()=>{
    expect(featureColor("staging_area")).toBe("#2563eb");
    expect(featureColor("command_post")).toBe("#2563eb");
    expect(featureColor("Hazard")).toBe("#dc2626");
    expect(featureColor("Incident locations / points of interest")).toBe("#111827");
  });
});
