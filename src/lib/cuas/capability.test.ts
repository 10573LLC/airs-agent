import { describe, expect, it } from "vitest";

import { assessCuasCapability } from "./capability";

describe("C-UAS optional capability gauntlet", () => {
  it("keeps C-UAS dormant when the agency does not participate", () => {
    expect(
      assessCuasCapability({
        participationStatus: "not_participating",
        mutualAidAuthorized: false,
        activeDetectionPersonnel: 0,
        activeMitigationPersonnel: 0,
        availableDetectionSystems: 0,
        availableMitigationSystems: 0,
      }).state,
    ).toBe("dormant");
  });

  it("supports mutual-aid-only agencies without implying local authority", () => {
    const result = assessCuasCapability({
      participationStatus: "not_participating",
      mutualAidAuthorized: true,
      activeDetectionPersonnel: 0,
      activeMitigationPersonnel: 0,
      availableDetectionSystems: 0,
      availableMitigationSystems: 0,
    });
    expect(result.state).toBe("mutual_aid_only");
    expect(result.locallyUsable).toBe(false);
    expect(result.mutualAidAvailable).toBe(true);
  });

  it("does not treat equipment without personnel as deployable capability", () => {
    expect(
      assessCuasCapability({
        participationStatus: "detection_warning",
        mutualAidAuthorized: false,
        activeDetectionPersonnel: 0,
        activeMitigationPersonnel: 0,
        availableDetectionSystems: 2,
        availableMitigationSystems: 0,
      }).state,
    ).toBe("temporarily_unavailable");
  });

  it("does not treat personnel without equipment as deployable capability", () => {
    expect(
      assessCuasCapability({
        participationStatus: "detection_warning",
        mutualAidAuthorized: false,
        activeDetectionPersonnel: 3,
        activeMitigationPersonnel: 0,
        availableDetectionSystems: 0,
        availableMitigationSystems: 0,
      }).state,
    ).toBe("temporarily_unavailable");
  });

  it("marks a complete detection capability ready", () => {
    const result = assessCuasCapability({
      participationStatus: "detection_warning",
      mutualAidAuthorized: false,
      activeDetectionPersonnel: 2,
      activeMitigationPersonnel: 0,
      availableDetectionSystems: 1,
      availableMitigationSystems: 0,
    });
    expect(result.state).toBe("detection_ready");
    expect(result.detectionUsable).toBe(true);
    expect(result.mitigationUsable).toBe(false);
  });

  it("requires both mitigation personnel and an available mitigation system", () => {
    expect(
      assessCuasCapability({
        participationStatus: "mitigation",
        mutualAidAuthorized: false,
        activeDetectionPersonnel: 0,
        activeMitigationPersonnel: 1,
        availableDetectionSystems: 0,
        availableMitigationSystems: 1,
      }).state,
    ).toBe("mitigation_ready");
  });

  it("falls back to detection when mitigation resources are unavailable", () => {
    const result = assessCuasCapability({
      participationStatus: "mitigation",
      mutualAidAuthorized: true,
      activeDetectionPersonnel: 2,
      activeMitigationPersonnel: 0,
      availableDetectionSystems: 1,
      availableMitigationSystems: 1,
    });
    expect(result.state).toBe("detection_ready");
    expect(result.mitigationUsable).toBe(false);
  });

  it("treats a suspended program as locally unavailable", () => {
    const result = assessCuasCapability({
      participationStatus: "suspended",
      mutualAidAuthorized: true,
      activeDetectionPersonnel: 5,
      activeMitigationPersonnel: 2,
      availableDetectionSystems: 3,
      availableMitigationSystems: 2,
    });
    expect(result.state).toBe("mutual_aid_only");
    expect(result.locallyUsable).toBe(false);
  });
});
