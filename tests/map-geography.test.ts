// Stage 7 (Common Operating Picture) verification suite.
//
// Two layers:
//   1. Parity — the TypeScript domain model in src/lib/map/model.ts must mirror
//      db/migrations/0009_common_operating_picture.sql exactly. No database.
//   2. Enforcement — the real service chain against a real PostgreSQL/PostGIS
//      server as the unprivileged `airs_app` role (FORCE ROW LEVEL SECURITY),
//      proving what a browser can and cannot receive.
//
// Required environment for layer 2 (otherwise it skips):
//   TEST_DATABASE_URL        connection string for the airs_app role
//   TEST_ADMIN_DATABASE_URL  connection string used ONLY to create fixtures
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FRESHNESS_STATES,
  LOCATION_KINDS,
  MAP_FEATURE_TYPES,
  OPERATING_AREA_STATUSES,
  POSITION_SOURCES,
  PRECISION_GRID,
  PRECISION_POLICIES,
  PRECISION_RANK,
  PROFILE_PRECISION,
  bounds,
  freshnessFor,
  parseGeometry,
  resolvePrecision,
} from "@/lib/map/model";

const MIGRATION = readFileSync("db/migrations/0009_common_operating_picture.sql", "utf8");

// --- layer 1: model <-> migration parity --------------------------------------

describe("map model mirrors migration 0009", () => {
  it("declares the same precision policies, grids and ranks", () => {
    for (const policy of PRECISION_POLICIES) {
      const row = new RegExp(
        `\\('${policy}',\\s*(NULL|[0-9.]+),\\s*(\\d+),`,
        "i",
      ).exec(MIGRATION);
      expect(row, `precision ${policy} missing from migration`).toBeTruthy();
      const grid = row![1] === "NULL" ? null : Number(row![1]);
      expect(PRECISION_GRID[policy]).toBe(grid);
      expect(PRECISION_RANK[policy]).toBe(Number(row![2]));
    }
  });

  it("maps every disclosure profile to the same ceiling", () => {
    for (const [profile, policy] of Object.entries(PROFILE_PRECISION)) {
      expect(MIGRATION).toContain(`('${profile}',`);
      const row = new RegExp(`\\('${profile}',\\s*'(\\w+)'\\)`).exec(MIGRATION);
      expect(row?.[1], `profile ${profile}`).toBe(policy);
    }
  });

  it("declares the same feature types, area statuses, kinds and sources", () => {
    for (const t of MAP_FEATURE_TYPES) expect(MIGRATION).toContain(`'${t}'`);
    for (const s of OPERATING_AREA_STATUSES) expect(MIGRATION).toContain(`'${s}'`);
    for (const k of LOCATION_KINDS) expect(MIGRATION).toContain(`'${k}'`);
    for (const s of POSITION_SOURCES) expect(MIGRATION).toContain(`'${s}'`);
    for (const f of FRESHNESS_STATES) expect(MIGRATION).toContain(`'${f}'`);
  });
});

describe("precision resolution is default-deny", () => {
  it("gives the owner exact geography", () => {
    expect(resolvePrecision("withheld", "summary", true)).toBe("exact");
  });
  it("takes the narrower of declared policy and profile ceiling", () => {
    expect(resolvePrecision("exact", "operational", false)).toBe("area_only");
    expect(resolvePrecision("generalized", "incident_command", false)).toBe("generalized");
    expect(resolvePrecision("exact", "aviation", false)).toBe("approximate");
  });
  it("collapses unknown inputs to withheld, never exact", () => {
    expect(resolvePrecision("bogus", "full", false)).toBe("withheld");
    expect(resolvePrecision("exact", null, false)).toBe("withheld");
    expect(resolvePrecision(undefined, undefined, false)).toBe("withheld");
  });
});

describe("geometry parsing rejects untrusted input", () => {
  it("accepts well-formed WGS 84 geometry", () => {
    expect(parseGeometry({ type: "Point", coordinates: [-73.75, 42.65] })).toBeTruthy();
  });
  it("rejects out-of-range, unclosed, infinite and unknown geometry", () => {
    expect(parseGeometry({ type: "Point", coordinates: [-200, 42] })).toBeNull();
    expect(parseGeometry({ type: "Point", coordinates: [NaN, 42] })).toBeNull();
    expect(
      parseGeometry({
        type: "Polygon",
        coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]],
      }),
    ).toBeNull();
    expect(parseGeometry({ type: "GeometryCollection", geometries: [] })).toBeNull();
    expect(parseGeometry(null)).toBeNull();
  });
  it("computes bounds without a map SDK", () => {
    expect(bounds([{ type: "Point", coordinates: [-73.8, 42.6] }, null])).toEqual([
      -73.8, 42.6, -73.8, 42.6,
    ]);
    expect(bounds([])).toBeNull();
  });
});

describe("freshness is computed from the clock, not the client", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60000).toISOString();
  it("grades age and expiry", () => {
    expect(freshnessFor(at(1), null, now)).toBe("fresh");
    expect(freshnessFor(at(10), null, now)).toBe("recent");
    expect(freshnessFor(at(30), null, now)).toBe("aging");
    expect(freshnessFor(at(120), null, now)).toBe("stale");
    expect(freshnessFor(at(1), at(0), now)).toBe("expired");
    expect(freshnessFor(null, null, now)).toBe("unknown");
  });
});

// --- layer 2: enforcement against a real database -----------------------------

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const enabled = Boolean(APP_URL && ADMIN_URL);
if (APP_URL) process.env.DATABASE_URL = APP_URL;

const ORG_A = "11111111-1111-4111-8111-111111111111"; // Albany Police Department
const ORG_B = "22222222-2222-4222-8222-222222222222"; // Albany County
const RUN = Math.random().toString(36).slice(2, 10);
const meta = { ipAddress: "127.0.0.1", userAgent: "vitest", correlationId: `map-${RUN}` };
const PASSWORD = "Correct-Horse-Battery-Staple-9";
const email = (n: string) => `map.${n}.${RUN}@example.test`;

// Albany, NY. Exact to five decimals so every reduction is measurable.
const EXACT: [number, number] = [-73.75623, 42.65187];
const ring = (lng: number, lat: number, d = 0.01): [number, number][] => [
  [lng - d, lat - d],
  [lng + d, lat - d],
  [lng + d, lat + d],
  [lng - d, lat + d],
  [lng - d, lat - d],
];

let admin: Client;
let auth: typeof import("@/lib/auth/index.server");
let map: typeof import("@/lib/map/map.server");
let incidents: typeof import("@/lib/incidents/incidents.server");
let participation: typeof import("@/lib/incidents/participation.server");
let resources: typeof import("@/lib/resources/resources.server");

let ORG_C = "";
let tokenAdminA = "";
let tokenIcA = "";
let tokenPartnerB = "";
let tokenOutsiderC = "";
let incidentId = "";
let sharedFeatureId = "";
let withheldFeatureId = "";
let unsharedFeatureId = "";
let areaId = "";
let participantId = "";
let resourceId = "";

async function seedMember(name: string, orgId: string, roleKey: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const addr = email(name);
  const acct = await admin.query<{ id: string }>(
    `INSERT INTO airs.accounts (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [addr, `MAP ${name}`, await hashPassword(PASSWORD)],
  );
  const accountId = acct.rows[0]!.id;
  const user = await admin.query<{ id: string }>(
    `INSERT INTO airs.users (org_id, email_address, display_name, account_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, addr, `MAP ${name}`, accountId],
  );
  await admin.query(
    `INSERT INTO airs.memberships (org_id, account_id, user_id, role_key, status, activated_at)
     VALUES ($1,$2,$3,$4,'active', now())`,
    [orgId, accountId, user.rows[0]!.id, roleKey],
  );
  await admin.query(
    `INSERT INTO airs.user_roles (org_id, user_id, role_key) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [orgId, user.rows[0]!.id, roleKey],
  );
  const signed = await auth.getAuthAdapter().signIn(addr, PASSWORD, meta);
  if (!signed.ok) throw new Error(`sign-in failed for ${name}`);
  return signed.token;
}

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  auth = await import("@/lib/auth/index.server");
  map = await import("@/lib/map/map.server");
  incidents = await import("@/lib/incidents/incidents.server");
  participation = await import("@/lib/incidents/participation.server");
  resources = await import("@/lib/resources/resources.server");

  const org = await admin.query<{ id: string }>(
    `INSERT INTO airs.organizations (slug, name, agency_type)
     VALUES ($1,$2,'other') RETURNING id`,
    [`outsider-${RUN}`, `Outsider Agency ${RUN}`],
  );
  ORG_C = org.rows[0]!.id;

  await admin.query(
    `INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status, approved_at)
     VALUES ($1,$2,'approved', now())
     ON CONFLICT (org_id, partner_org_id) DO UPDATE
       SET status = 'approved', approved_at = now()`,
    [ORG_A, ORG_B],
  );

  tokenAdminA = await seedMember("admin-a", ORG_A, "agency_admin");
  tokenIcA = await seedMember("ic-a", ORG_A, "incident_commander");
  tokenPartnerB = await seedMember("partner-b", ORG_B, "partner_agency_user");
  tokenOutsiderC = await seedMember("outsider-c", ORG_C, "agency_admin");

  const room = await incidents.createIncident(
    tokenIcA,
    ORG_A,
    { name: `COP verification ${RUN}`, incidentType: "search_and_rescue" },
    meta,
  );
  incidentId = room.id;
  const active = await incidents.activateIncident(tokenIcA, ORG_A, incidentId, room.version, meta);

  // Exact geography, declared exact, attached to the shared incident.
  const shared = await map.createMapFeature(
    tokenAdminA,
    ORG_A,
    {
      incidentId,
      featureType: "landing_zone",
      name: "LZ Alpha",
      geometry: { type: "Point", coordinates: EXACT },
      precisionPolicy: "exact",
    },
    meta,
  );
  sharedFeatureId = shared.id;

  const withheld = await map.createMapFeature(
    tokenAdminA,
    ORG_A,
    {
      incidentId,
      featureType: "hazard",
      name: "Hazard Bravo",
      geometry: { type: "Point", coordinates: [-73.7, 42.7] },
      precisionPolicy: "withheld",
    },
    meta,
  );
  withheldFeatureId = withheld.id;

  // Org-only feature: no incident, therefore no partner path to it at all.
  const unshared = await map.createMapFeature(
    tokenAdminA,
    ORG_A,
    {
      featureType: "command_post",
      name: "CP Home",
      geometry: { type: "Point", coordinates: [-73.8, 42.6] },
      precisionPolicy: "exact",
    },
    meta,
  );
  unsharedFeatureId = unshared.id;

  const area = await map.createOperatingArea(
    tokenIcA,
    ORG_A,
    {
      incidentId,
      name: "Sector 1",
      area: { type: "Polygon", coordinates: [ring(EXACT[0], EXACT[1])] },
      precisionPolicy: "exact",
    },
    meta,
  );
  areaId = area.id;

  const resource = await resources.createResource(
    tokenAdminA,
    ORG_A,
    { category: "aircraft", displayName: `UAS ${RUN}`, readinessStatus: "available" },
    meta,
  );
  resourceId = resource.id;
  await map.reportResourceLocation(
    tokenIcA,
    ORG_A,
    {
      resourceId: resource.id,
      locationKind: "temporary",
      incidentId,
      point: { type: "Point", coordinates: EXACT },
      precisionPolicy: "exact",
      positionSource: "manual",
      validForHours: 4,
    },
    meta,
  );

  const invited = await participation.invitePartner(
    tokenIcA,
    ORG_A,
    incidentId,
    {
      partnerOrgId: ORG_B,
      accessLevel: "operational",
      invitationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      requiresApproval: false,
    },
    meta,
  );
  participantId = invited.participant.id;
  await participation.partnerParticipationAction(
    tokenPartnerB,
    ORG_B,
    participantId,
    "accept",
    meta,
  );
  void active;
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await admin?.end();
});

const dbIt = enabled ? it : it.skip;

describe("Stage 7 geography enforcement", () => {
  dbIt("gives the originating organization exact geometry", async () => {
    const features = await map.listMapFeatures(tokenAdminA, ORG_A, { incidentId }, meta);
    const lz = features.find((f) => f.id === sharedFeatureId)!;
    expect(lz.relationship).toBe("owner");
    expect(lz.precision).toBe("exact");
    expect(lz.geometry).toEqual({ type: "Point", coordinates: EXACT });
  });

  dbIt("reduces an authorized partner to its profile ceiling", async () => {
    const features = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    const lz = features.find((f) => f.id === sharedFeatureId)!;
    expect(lz.relationship).toBe("partner");
    expect(lz.precision).toBe("area_only"); // 'operational' ceiling, not 'exact'
    expect(lz.geometry?.type).toBe("Polygon"); // an envelope, never the point
    const flat = JSON.stringify(lz);
    expect(flat).not.toContain(String(EXACT[0]));
    expect(flat).not.toContain(String(EXACT[1]));
  });

  dbIt("omits withheld geometry rather than nulling it", async () => {
    const features = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    const hazard = features.find((f) => f.id === withheldFeatureId)!;
    expect(hazard.precision).toBe("withheld");
    expect("geometry" in hazard).toBe(false);
  });

  dbIt("hides owner-only bookkeeping from a partner", async () => {
    const features = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    const lz = features.find((f) => f.id === sharedFeatureId)!;
    expect("classification" in lz).toBe(false);
    expect("declaredPrecision" in lz).toBe(false);
  });

  dbIt("never exposes a feature that was not shared into the incident", async () => {
    const features = await map.listMapFeatures(tokenPartnerB, ORG_B, {}, meta);
    expect(features.some((f) => f.id === unsharedFeatureId)).toBe(false);
  });

  dbIt("shows an unauthorized organization nothing at all", async () => {
    const features = await map.listMapFeatures(tokenOutsiderC, ORG_C, {}, meta);
    const areas = await map.listOperatingAreas(tokenOutsiderC, ORG_C, {}, meta);
    const locations = await map.listResourceLocations(tokenOutsiderC, ORG_C, {}, meta);
    expect(features.some((f) => f.orgId === ORG_A)).toBe(false);
    expect(areas.some((a) => a.orgId === ORG_A)).toBe(false);
    expect(locations.some((l) => l.orgId === ORG_A)).toBe(false);
  });

  dbIt("reduces partner operating areas and positions the same way", async () => {
    const areas = await map.listOperatingAreas(tokenPartnerB, ORG_B, { incidentId }, meta);
    const sector = areas.find((a) => a.id === areaId)!;
    expect(sector.precision).toBe("area_only");
    expect(JSON.stringify(sector)).not.toContain(String(EXACT[0]));

    // A position is visible to a partner only when the RESOURCE is also shared:
    // incident participation alone is not enough (two independent keys).
    expect(await map.listResourceLocations(tokenPartnerB, ORG_B, { incidentId }, meta)).toEqual([]);
    await resources.shareResource(
      tokenAdminA,
      ORG_A,
      { resourceId, incidentId, classification: "participating_orgs", disclosureProfile: "operational" },
      meta,
    );
    const locations = await map.listResourceLocations(tokenPartnerB, ORG_B, { incidentId }, meta);
    expect(locations.length).toBeGreaterThan(0);
    for (const loc of locations) {
      expect(loc.precision).toBe("area_only");
      expect(loc.positionSource).toBe("manual");
      expect(FRESHNESS_STATES).toContain(loc.freshness);
      expect(JSON.stringify(loc)).not.toContain(String(EXACT[0]));
    }
  });

  dbIt("refuses to let a partner widen precision or edit foreign geometry", async () => {
    await expect(
      map.setFeaturePrecision(tokenPartnerB, ORG_B, sharedFeatureId, "exact", meta),
    ).rejects.toThrow();
    await expect(
      map.updateMapFeature(
        tokenPartnerB,
        ORG_B,
        sharedFeatureId,
        { name: "hijacked", expectedVersion: 1 },
        meta,
      ),
    ).rejects.toThrow();
    await expect(
      map.setOperatingAreaPrecision(tokenPartnerB, ORG_B, areaId, "exact", meta),
    ).rejects.toThrow();
    // The owner's view is untouched by the attempts.
    const features = await map.listMapFeatures(tokenAdminA, ORG_A, { incidentId }, meta);
    expect(features.find((f) => f.id === sharedFeatureId)!.name).toBe("LZ Alpha");
  });

  dbIt("refuses invalid geometry", async () => {
    await expect(
      map.createMapFeature(
        tokenAdminA,
        ORG_A,
        {
          featureType: "hazard",
          name: "bad",
          geometry: { type: "Point", coordinates: [999, 999] },
        },
        meta,
      ),
    ).rejects.toThrow();
    await expect(
      map.createOperatingArea(
        tokenIcA,
        ORG_A,
        {
          incidentId,
          name: "bad",
          area: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1]]] },
        },
        meta,
      ),
    ).rejects.toThrow();
  });

  dbIt("rejects an unauthenticated caller outright", async () => {
    await expect(map.listMapFeatures(null, ORG_A, {}, meta)).rejects.toThrow();
    await expect(map.listMapFeatures("not-a-token", ORG_A, {}, meta)).rejects.toThrow();
  });

  dbIt("ends partner geography the moment the share is revoked", async () => {
    const before = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    expect(before.length).toBeGreaterThan(0);
    await participation.ownerParticipantAction(
      tokenIcA,
      ORG_A,
      incidentId,
      participantId,
      "revoke_partner",
      meta,
      "verification",
    );
    const after = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    const areas = await map.listOperatingAreas(tokenPartnerB, ORG_B, { incidentId }, meta);
    const locations = await map.listResourceLocations(tokenPartnerB, ORG_B, { incidentId }, meta);
    expect(after).toEqual([]);
    expect(areas).toEqual([]);
    expect(locations).toEqual([]);
  });

  dbIt("terminates geography when the incident closes", async () => {
    const access = await incidents.readIncident(tokenIcA, ORG_A, incidentId, meta);
    await incidents.closeIncident(
      tokenIcA,
      ORG_A,
      incidentId,
      { reason: "verification complete", expectedVersion: access.incident.version },
      meta,
    );
    const locations = await map.listResourceLocations(tokenAdminA, ORG_A, { incidentId }, meta);
    for (const loc of locations) {
      expect(["expired", "stale", "unknown"]).toContain(loc.freshness);
    }
    const partnerFeatures = await map.listMapFeatures(tokenPartnerB, ORG_B, { incidentId }, meta);
    expect(partnerFeatures).toEqual([]);
  });
});
