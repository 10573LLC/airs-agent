// Field-level disclosure model tests. Pure and portable: no database, no
// platform SDK. Parity with airs.disclosure_fields / airs.disclosure_profile_fields
// is asserted here and again in db/tests/disclosure_projection.sql.
import { describe, expect, it } from "vitest";

import {
  CUSTOM_SELECTABLE_FIELDS,
  DISCLOSURE_PROFILES,
  FIELD_DEF,
  FIELD_KEYS,
  PROFILE_FIELDS,
  SENSITIVE_FIELD_KEYS,
  projectFields,
  resolveDisclosedFields,
  type FieldKey,
} from "@/lib/resources/disclosure";

const partner = (profile: (typeof DISCLOSURE_PROFILES)[number], custom?: string[]) =>
  new Set(resolveDisclosedFields({ profile, customFieldKeys: custom ?? [], owner: false }));

describe("disclosure vocabulary", () => {
  it("matches the counts the database seeds", () => {
    expect(FIELD_KEYS).toHaveLength(60);
    expect(SENSITIVE_FIELD_KEYS).toHaveLength(12);
    expect(PROFILE_FIELDS.summary).toHaveLength(9);
    expect(PROFILE_FIELDS.operational).toHaveLength(33);
    expect(PROFILE_FIELDS.aviation).toHaveLength(44);
    expect(PROFILE_FIELDS.incident_command).toHaveLength(48);
    const grid = DISCLOSURE_PROFILES.reduce((n, p) => n + PROFILE_FIELDS[p].length, 0);
    expect(grid).toBe(242);
  });

  it("keeps every profile cumulative — widening only, never narrowing", () => {
    const chain = ["summary", "operational", "aviation", "incident_command"] as const;
    for (let i = 1; i < chain.length; i += 1) {
      for (const key of PROFILE_FIELDS[chain[i - 1]]) {
        expect(PROFILE_FIELDS[chain[i]]).toContain(key);
      }
    }
  });

  it("excludes every sensitive field from every partner profile", () => {
    for (const profile of DISCLOSURE_PROFILES) {
      if (profile === "full") continue;
      for (const key of SENSITIVE_FIELD_KEYS) {
        expect(PROFILE_FIELDS[profile]).not.toContain(key);
      }
    }
    expect(CUSTOM_SELECTABLE_FIELDS.some((k) => FIELD_DEF[k].sensitive)).toBe(false);
  });
});

describe("resolveDisclosedFields", () => {
  it("gives the originating organization its whole record", () => {
    const keys = resolveDisclosedFields({ profile: "summary", owner: true });
    expect(keys).toHaveLength(FIELD_KEYS.length);
  });

  it("fails closed on an unknown profile", () => {
    const keys = new Set(
      resolveDisclosedFields({ profile: "wide_open" as never, owner: false }),
    );
    expect(keys.has("displayName")).toBe(true);
    expect(keys.has("description")).toBe(false);
  });

  it("downgrades full to incident command for a partner that is not named", () => {
    const keys = partner("full");
    expect(keys.has("locationDescription")).toBe(true);
    expect(keys.has("serialNumber")).toBe(false);
    expect(keys.has("restrictedNotes")).toBe(false);
  });

  it("gives the full authorized record only to a named recipient", () => {
    const keys = new Set(
      resolveDisclosedFields({ profile: "full", owner: false, namedRecipient: true }),
    );
    expect(keys.has("serialNumber")).toBe(true);
    expect(keys.has("faaRegistration")).toBe(true);
  });

  it("drops sensitive and unknown keys from a custom profile", () => {
    const keys = partner("custom", ["model", "serialNumber", "notAField", "restrictedNotes"]);
    expect(keys.has("model")).toBe(true);
    expect(keys.has("serialNumber")).toBe(false);
    expect(keys.has("restrictedNotes")).toBe(false);
    expect(keys.has("displayName")).toBe(true); // summary floor
    expect(keys.has("description")).toBe(false); // nothing it did not name
  });

  it("adds aviation detail only at the aviation level and above", () => {
    expect(partner("operational").has("model")).toBe(false);
    expect(partner("aviation").has("model")).toBe(true);
    expect(partner("aviation").has("qualificationCurrent")).toBe(true);
    expect(partner("aviation").has("locationDescription")).toBe(false);
    expect(partner("incident_command").has("locationDescription")).toBe(true);
  });
});

describe("projectFields", () => {
  const sources = {
    resource: { displayName: "Air-1", description: "primary DFR ship", restrictedNotes: "internal" },
    detail: { model: "X10", serial_number: "SN-SECRET", location_description: "roof pad" },
  };

  it("omits withheld keys entirely rather than blanking them", () => {
    const out = projectFields([...partner("summary")] as FieldKey[], sources, "aircraft");
    expect(out.displayName).toBe("Air-1");
    expect("description" in out).toBe(false);
    expect("serialNumber" in out).toBe(false);
    expect("restrictedNotes" in out).toBe(false);
  });

  it("never emits a field that does not apply to the record's category", () => {
    const out = projectFields([...partner("incident_command")] as FieldKey[], sources, "aircraft");
    expect(out.model).toBe("X10");
    // locationDescription belongs to launch sites, not aircraft
    expect("locationDescription" in out).toBe(false);
  });

  it("emits sensitive values only when the key was granted", () => {
    const full = resolveDisclosedFields({ profile: "full", owner: true });
    const out = projectFields(full, sources, "aircraft");
    expect(out.serialNumber).toBe("SN-SECRET");
    expect(out.restrictedNotes).toBe("internal");
  });
});
