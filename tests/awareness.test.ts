// Stage 8 (Manual Airspace Observations and Awareness Layer) verification.
//
// Two layers:
//   1. Parity — src/lib/awareness/model.ts must mirror
//      db/migrations/0010_awareness_observations.sql exactly. No database.
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
  ANNOTATION_TYPES,
  CONFIDENCE_LEVELS,
  EVIDENCE_TYPES,
  FRESHNESS_THRESHOLDS,
  GAP_TYPES,
  INFORMATION_CREDIBILITY,
  LIFECYCLE_STATUSES,
  OBSERVATION_CLASSIFICATIONS,
  OBSERVATION_FRESHNESS,
  OBSERVATION_LOCATION_KINDS,
  OBSERVATION_SOURCES,
  OBSERVATION_TYPES,
  OWNER_ONLY_FIELDS,
  RELATIONSHIP_TYPES,
  RESTRICTED_SOURCE_FIELDS,
  SOURCE_RELIABILITY,
  TERMINAL_LIFECYCLE,
  URGENCY_LEVELS,
  VERIFICATION_STATUSES,
  VERIFICATION_TRANSITIONS,
  canTransitionVerification,
  observationFreshness,
  permissionForVerification,
} from "@/lib/awareness/model";
import { ROLE_PERMISSIONS } from "@/lib/rbac/roles";

const MIGRATION = readFileSync("db/migrations/0010_awareness_observations.sql", "utf8");

// --- layer 1: model <-> migration parity --------------------------------------

describe("awareness model mirrors migration 0010", () => {
  it("declares the same controlled vocabularies", () => {
    const lists: Array<[string, readonly string[]]> = [
      ["observation type", OBSERVATION_TYPES],
      ["source", OBSERVATION_SOURCES],
      ["reliability", SOURCE_RELIABILITY],
      ["credibility", INFORMATION_CREDIBILITY],
      ["confidence", CONFIDENCE_LEVELS],
      ["verification", VERIFICATION_STATUSES],
      ["lifecycle", LIFECYCLE_STATUSES],
      ["urgency", URGENCY_LEVELS],
      ["classification", OBSERVATION_CLASSIFICATIONS],
      ["location kind", OBSERVATION_LOCATION_KINDS],
      ["relationship", RELATIONSHIP_TYPES],
      ["gap type", GAP_TYPES],
      ["evidence type", EVIDENCE_TYPES],
      ["annotation type", ANNOTATION_TYPES],
      ["freshness", OBSERVATION_FRESHNESS],
    ];
    for (const [label, values] of lists) {
      for (const value of values) {
        expect(MIGRATION, `${label} '${value}' missing from migration 0010`).toContain(`'${value}'`);
      }
    }
  });

  it("uses the same freshness thresholds the database uses", () => {
    for (const [type, t] of Object.entries(FRESHNESS_THRESHOLDS)) {
      const row = new RegExp(
        `\\('${type}',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`,
      ).exec(MIGRATION);
      expect(row, `threshold row for ${type} missing`).toBeTruthy();
      expect(Number(row![1])).toBe(t.currentMinutes);
      expect(Number(row![2])).toBe(t.recentMinutes);
      expect(Number(row![3])).toBe(t.agingMinutes);
    }
  });

  it("keeps source, reliability, credibility and confidence as separate columns", () => {
    // Three independent judgements are recorded; the schema must never fold
    // them into a single derived verdict column.
    expect(MIGRATION).toContain("source_reliability");
    expect(MIGRATION).toContain("information_credibility");
    expect(MIGRATION).toContain("confidence_level");
    expect(MIGRATION).not.toMatch(/\btrust_score\b|\bcombined_rating\b|\boverall_verdict\b/);
  });
});

describe("verification transitions are default-deny", () => {
  it("refuses any transition that is not explicitly listed", () => {
    for (const from of VERIFICATION_STATUSES) {
      const allowed = VERIFICATION_TRANSITIONS[from];
      for (const to of VERIFICATION_STATUSES) {
        expect(canTransitionVerification(from, to)).toBe(allowed.includes(to));
      }
    }
  });

  it("requires a distinct permission for review, verification and rejection", () => {
    expect(permissionForVerification("under_review")).toBe("observation.review");
    expect(permissionForVerification("confirmed")).toBe("observation.verify");
    expect(permissionForVerification("corroborated")).toBe("observation.verify");
    expect(permissionForVerification("rejected")).toBe("observation.reject");
  });

  it("withholds the verification authority from reporting-only roles", () => {
    for (const role of ["rpic", "visual_observer", "partner_agency_user"] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("observation.verify");
      expect(ROLE_PERMISSIONS[role]).not.toContain("observation.reject");
    }
    expect(ROLE_PERMISSIONS.visual_observer).toContain("observation.create");
    expect(ROLE_PERMISSIONS.partner_agency_user).not.toContain("observation.create");
    expect(ROLE_PERMISSIONS.airspace_supervisor).toContain("observation.verify");
  });
});

describe("freshness is computed from the clock, not from lifecycle", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const ago = (min: number) => new Date(now - min * 60000).toISOString();

  it("grades a fast-moving observation type on its own thresholds", () => {
    const t = "suspected_unauthorized_uas";
    expect(observationFreshness(t, ago(2), null, now)).toBe("current");
    expect(observationFreshness(t, ago(10), null, now)).toBe("recent");
    expect(observationFreshness(t, ago(30), null, now)).toBe("aging");
    expect(observationFreshness(t, ago(300), null, now)).toBe("stale");
  });

  it("grades a slow-moving observation type differently at the same age", () => {
    expect(observationFreshness("critical_asset_concern", ago(30), null, now)).toBe("current");
    expect(observationFreshness("suspected_unauthorized_uas", ago(30), null, now)).toBe("aging");
  });

  it("never reports an unknown or expired observation as current", () => {
    expect(observationFreshness("public_report", null, null, now)).toBe("unknown");
    expect(observationFreshness("public_report", "not a date", null, now)).toBe("unknown");
    expect(observationFreshness("public_report", ago(1), ago(1), now)).toBe("expired");
  });

  it("treats an unknown observation type as the default, not as fresh", () => {
    expect(observationFreshness("invented_type", ago(30), null, now)).toBe("recent");
  });
});

describe("terminal lifecycle and restricted fields are declared, not inferred", () => {
  it("names the terminal states", () => {
    // 'resolved' is deliberately NOT terminal: a resolved observation can be
    // reopened by a role holding observation.reopen, a closed one cannot.
    expect([...TERMINAL_LIFECYCLE].sort()).toEqual(["cancelled", "closed", "expired"]);
    expect([...TERMINAL_LIFECYCLE]).not.toContain("resolved");
  });
  it("names every field a partner may never receive", () => {
    expect([...RESTRICTED_SOURCE_FIELDS]).toEqual([
      "sourceDetail",
      "reporterIdentity",
      "reporterContact",
      "internalNotes",
      "internalCaseNumber",
    ]);
    expect([...OWNER_ONLY_FIELDS]).toContain("classification");
    expect([...OWNER_ONLY_FIELDS]).toContain("declaredPrecision");
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
const meta = { ipAddress: "127.0.0.1", userAgent: "vitest", correlationId: `awareness-${RUN}` };
const PASSWORD = "Correct-Horse-Battery-Staple-9";
const email = (n: string) => `awareness.${n}.${RUN}@example.test`;

// Albany, NY. Exact to five decimals so every reduction is measurable.
const EXACT: [number, number] = [-73.75623, 42.65187];

let admin: Client;
let auth: typeof import("@/lib/auth/index.server");
let awareness: typeof import("@/lib/awareness/awareness.server");
let incidents: typeof import("@/lib/incidents/incidents.server");
let participation: typeof import("@/lib/incidents/participation.server");

let ORG_C = "";
let tokenAdminA = "";
let tokenIcA = "";
let tokenSupervisorA = "";
let tokenObserverA = "";
let tokenPartnerB = "";
let tokenOutsiderC = "";
let incidentId = "";
let incidentVersion = 0;

async function seedMember(name: string, orgId: string, roleKey: string) {
  const { hashPassword } = await import("@/lib/auth/password");
  const addr = email(name);
  const acct = await admin.query<{ id: string }>(
    `INSERT INTO airs.accounts (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [addr, `AWARE ${name}`, await hashPassword(PASSWORD)],
  );
  const accountId = acct.rows[0]!.id;
  const user = await admin.query<{ id: string }>(
    `INSERT INTO airs.users (org_id, email_address, display_name, account_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, addr, `AWARE ${name}`, accountId],
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

/** Read the audit trail this suite wrote, newest first. */
async function auditRows(action: string, resourceId?: string) {
  const rows = await admin.query<{
    action: string;
    outcome: string;
    resource_id: string | null;
    org_id: string;
  }>(
    `SELECT action, outcome, resource_id, org_id FROM airs.audit_events
      WHERE action = $1 AND ($2::text IS NULL OR resource_id = $2)
      ORDER BY occurred_at DESC, id DESC LIMIT 20`,
    [action, resourceId ?? null],
  );
  return rows.rows;
}

async function makeObservation(
  token: string,
  orgId: string,
  overrides: Partial<Parameters<typeof awareness.createObservation>[2]> = {},
) {
  return awareness.createObservation(
    token,
    orgId,
    {
      incidentId,
      observationType: "suspected_unauthorized_uas",
      title: `Quadcopter over the perimeter ${RUN}`,
      description: "Observed hovering at low altitude near the north perimeter.",
      observedObject: "small white quadcopter",
      observedAt: new Date(Date.now() - 120_000).toISOString(),
      observedTimePrecision: "exact",
      locationKind: "manual_point",
      geometry: { type: "Point", coordinates: EXACT },
      precisionPolicy: "exact",
      sourceType: "public_report",
      sourceDetail: "Caller watched it for four minutes.",
      reporterIdentity: "Jane Q. Reporter",
      reporterContact: "+1-518-555-0147",
      internalNotes: "Caller is a known complainant.",
      internalCaseNumber: `APD-${RUN}`,
      sourceReliability: "usually_reliable",
      informationCredibility: "probably_true",
      confidenceLevel: "moderate",
      urgency: "priority",
      classification: "participating_orgs",
      disclosureProfile: "operational",
      ...overrides,
    },
    meta,
  );
}

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  auth = await import("@/lib/auth/index.server");
  awareness = await import("@/lib/awareness/awareness.server");
  incidents = await import("@/lib/incidents/incidents.server");
  participation = await import("@/lib/incidents/participation.server");

  const org = await admin.query<{ id: string }>(
    `INSERT INTO airs.organizations (slug, name, agency_type)
     VALUES ($1,$2,'other') RETURNING id`,
    [`aware-outsider-${RUN}`, `Awareness Outsider ${RUN}`],
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
  tokenSupervisorA = await seedMember("sup-a", ORG_A, "airspace_supervisor");
  tokenObserverA = await seedMember("vo-a", ORG_A, "visual_observer");
  tokenPartnerB = await seedMember("partner-b", ORG_B, "partner_agency_user");
  tokenOutsiderC = await seedMember("outsider-c", ORG_C, "agency_admin");

  const room = await incidents.createIncident(
    tokenIcA,
    ORG_A,
    { name: `Awareness verification ${RUN}`, incidentType: "critical_incident" },
    meta,
  );
  incidentId = room.id;
  const active = await incidents.activateIncident(tokenIcA, ORG_A, incidentId, room.version, meta);
  incidentVersion = active.version;

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
  await participation.partnerParticipationAction(
    tokenPartnerB,
    ORG_B,
    invited.participant.id,
    "accept",
    meta,
  );
}, 120_000);

afterAll(async () => {
  if (admin) await admin.end();
});

const dbit = enabled ? it : it.skip;

describe("observation creation and the reporting plane", () => {
  dbit("records a report from a reporting-only role and writes an audit event", async () => {
    const obs = await awareness.createObservation(
      tokenObserverA,
      ORG_A,
      {
        incidentId,
        observationType: "unidentified_aircraft",
        title: `Visual observer report ${RUN}`,
        observedAt: new Date().toISOString(),
        locationKind: "none",
        sourceType: "direct_reporting_user",
      },
      meta,
    );
    expect(obs.relationship).toBe("owner");
    expect(obs.verificationStatus).toBe("unreviewed");
    expect(obs.lifecycleStatus).toBe("open");
    const events = await auditRows("observation.create");
    expect(events.some((r) => r.outcome === "allow" && r.org_id === ORG_A)).toBe(true);
  });

  dbit("refuses a report from an organization the caller does not belong to", async () => {
    await expect(makeObservation(tokenObserverA, ORG_B)).rejects.toMatchObject({
      code: "not_a_member",
    });
  });

  dbit("refuses a report from a partner-agency role with no create authority", async () => {
    await expect(
      awareness.createObservation(
        tokenPartnerB,
        ORG_B,
        {
          observationType: "public_report",
          title: "partner attempt",
          locationKind: "none",
          sourceType: "public_report",
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const denials = await auditRows("observation.create");
    expect(denials.some((r) => r.outcome === "deny" && r.org_id === ORG_B)).toBe(true);
  });

  dbit("rejects an invalid controlled value instead of storing it", async () => {
    await expect(
      makeObservation(tokenSupervisorA, ORG_A, { sourceReliability: "extremely_reliable" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      makeObservation(tokenSupervisorA, ORG_A, { observationType: "alien_craft" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      makeObservation(tokenSupervisorA, ORG_A, {
        geometry: { type: "Point", coordinates: [-400, 91] },
      }),
    ).rejects.toMatchObject({ code: "invalid_geometry" });
  });

  dbit("never lets a caller assert its own ownership or entitlement", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A, {
      // These are ignored by construction: the input type has no owner field,
      // and the service derives ownership from the session, not the payload.
      ...({ orgId: ORG_B, relationship: "owner", precision: "exact" } as Record<string, unknown>),
    });
    expect(obs.orgId).toBe(ORG_A);
    const raw = await admin.query<{ org_id: string; created_by_account: string | null }>(
      `SELECT org_id, created_by_account FROM airs.observations WHERE id = $1`,
      [obs.id],
    );
    expect(raw.rows[0]!.org_id).toBe(ORG_A);
    expect(raw.rows[0]!.created_by_account).not.toBeNull();
  });
});

describe("the verification lifecycle is separate from the report", () => {
  let target = "";

  dbit("moves a report through review to a confirmed judgement", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    target = obs.id;
    const reviewed = await awareness.setVerificationStatus(
      tokenSupervisorA,
      ORG_A,
      target,
      { status: "under_review", rationale: "Assigned to the airspace supervisor." },
      meta,
    );
    expect(reviewed.verificationStatus).toBe("under_review");
    const confirmed = await awareness.setVerificationStatus(
      tokenSupervisorA,
      ORG_A,
      target,
      { status: "confirmed", rationale: "Corroborated by a second caller.", confidenceLevel: "high" },
      meta,
    );
    expect(confirmed.verificationStatus).toBe("confirmed");
    expect(confirmed.confidenceLevel).toBe("high");
    // The original report text is untouched by the review.
    expect(confirmed.title).toBe(`Quadcopter over the perimeter ${RUN}`);
    expect(confirmed.sourceReliability).toBe("usually_reliable");
    expect((await auditRows("observation.verification.confirmed", target))[0]?.outcome).toBe("allow");
  });

  dbit("records the reviewer decision as an annotation, not as an edit", async () => {
    const detail = await awareness.getObservation(tokenSupervisorA, ORG_A, target, meta);
    const bodies = detail.annotations.map((a) => a.body);
    expect(bodies.some((b) => b.includes("Corroborated by a second caller."))).toBe(true);
    expect(detail.observation.description).toBe(
      "Observed hovering at low altitude near the north perimeter.",
    );
  });

  dbit("refuses a verification decision from a role without that authority", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    await expect(
      awareness.setVerificationStatus(tokenObserverA, ORG_A, obs.id, { status: "confirmed" }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The reporting role also cannot reject.
    await expect(
      awareness.setVerificationStatus(tokenObserverA, ORG_A, obs.id, { status: "rejected" }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });
    const fresh = await awareness.getObservation(tokenSupervisorA, ORG_A, obs.id, meta);
    expect(fresh.observation.verificationStatus).toBe("unreviewed");
  });

  dbit("refuses a transition the state machine does not allow", async () => {
    await expect(
      awareness.setVerificationStatus(
        tokenSupervisorA,
        ORG_A,
        target,
        { status: "unreviewed" },
        meta,
      ),
    ).rejects.toMatchObject({ code: "observation_state_invalid" });
  });

  dbit("refuses a stale version instead of silently overwriting", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    await awareness.setVerificationStatus(
      tokenSupervisorA,
      ORG_A,
      obs.id,
      { status: "under_review", expectedVersion: obs.version },
      meta,
    );
    await expect(
      awareness.setVerificationStatus(
        tokenSupervisorA,
        ORG_A,
        obs.id,
        { status: "confirmed", expectedVersion: obs.version },
        meta,
      ),
    ).rejects.toMatchObject({ code: "observation_stale_version" });
  });

  dbit("treats expiry as a clock outcome that no operator can set", async () => {
    await expect(
      awareness.setLifecycleStatus(tokenIcA, ORG_A, target, { status: "expired" }, meta),
    ).rejects.toMatchObject({ code: "observation_state_invalid" });
  });

  dbit("closes a report and then refuses further edits to it", async () => {
    const obs = await makeObservation(tokenIcA, ORG_A);
    const closed = await awareness.setLifecycleStatus(
      tokenIcA,
      ORG_A,
      obs.id,
      { status: "closed", note: "Resolved on scene." },
      meta,
    );
    expect(closed.lifecycleStatus).toBe("closed");
    await expect(
      awareness.setVerificationStatus(tokenIcA, ORG_A, obs.id, { status: "under_review" }, meta),
    ).rejects.toMatchObject({ code: "observation_terminal" });
  });
});

describe("corroboration, gaps and evidence", () => {
  dbit("links two independent reports without merging them", async () => {
    const first = await makeObservation(tokenSupervisorA, ORG_A);
    const second = await makeObservation(tokenSupervisorA, ORG_A, {
      title: `Second caller ${RUN}`,
      sourceType: "dispatch_communications_report",
    });
    await awareness.relateObservations(
      tokenSupervisorA,
      ORG_A,
      first.id,
      { relatedObservationId: second.id, relationship: "corroborates", note: "Same aircraft." },
      meta,
    );
    const detail = await awareness.getObservation(tokenSupervisorA, ORG_A, first.id, meta);
    expect(detail.corroborationCount).toBe(1);
    expect(detail.conflictCount).toBe(0);
    // Both records still exist independently.
    const other = await awareness.getObservation(tokenSupervisorA, ORG_A, second.id, meta);
    expect(other.observation.title).toBe(`Second caller ${RUN}`);
  });

  dbit("refuses to relate an observation to itself or to an unreachable one", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    await expect(
      awareness.relateObservations(
        tokenSupervisorA,
        ORG_A,
        obs.id,
        { relatedObservationId: obs.id, relationship: "supports" },
        meta,
      ),
    ).rejects.toMatchObject({ code: "observation_relationship_invalid" });
    await expect(
      awareness.relateObservations(
        tokenSupervisorA,
        ORG_A,
        obs.id,
        {
          relatedObservationId: "00000000-0000-4000-8000-000000000000",
          relationship: "supports",
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "observation_not_found" });
  });

  dbit("records an information gap and closes it with a resolution", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    const gap = await awareness.addInformationGap(
      tokenSupervisorA,
      ORG_A,
      obs.id,
      { gapType: "operator_unknown", detail: "No operator located on scene." },
      meta,
    );
    let detail = await awareness.getObservation(tokenSupervisorA, ORG_A, obs.id, meta);
    expect(detail.gaps.some((g) => g.id === gap.id && g.status === "open")).toBe(true);
    await awareness.closeInformationGap(
      tokenSupervisorA,
      ORG_A,
      gap.id,
      { status: "resolved", resolutionNote: "Operator identified." },
      meta,
    );
    detail = await awareness.getObservation(tokenSupervisorA, ORG_A, obs.id, meta);
    expect(detail.gaps.find((g) => g.id === gap.id)?.status).toBe("resolved");
  });

  dbit("stores an evidence reference but never evidence content", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A);
    const ev = await awareness.addEvidenceReference(
      tokenSupervisorA,
      ORG_A,
      obs.id,
      {
        referenceType: "external_case_number",
        displayName: "Records-management case",
        referenceValue: `APD-RMS-${RUN}`,
        classification: "participating_orgs",
      },
      meta,
    );
    expect(ev.id).toBeTruthy();
    await expect(
      awareness.addEvidenceReference(
        tokenSupervisorA,
        ORG_A,
        obs.id,
        {
          referenceType: "video_clip",
          displayName: "Local clip",
          referenceValue: "file:///var/evidence/clip.mp4",
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      awareness.addEvidenceReference(
        tokenSupervisorA,
        ORG_A,
        obs.id,
        {
          referenceType: "video_clip",
          displayName: "Insecure link",
          referenceValue: "http://evidence.example.gov/clip.mp4",
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("the partner plane receives a projection, never the record", () => {
  let shared = "";
  let withheld = "";
  let orgOnly = "";

  beforeAll(async () => {
    if (!enabled) return;
    const a = await makeObservation(tokenSupervisorA, ORG_A, { title: `Shared report ${RUN}` });
    shared = a.id;
    await awareness.shareObservation(
      tokenIcA,
      ORG_A,
      shared,
      {
        partnerOrgId: ORG_B,
        incidentId,
        disclosureProfile: "operational",
        precisionPolicy: "generalized",
      },
      meta,
    );

    const b = await makeObservation(tokenSupervisorA, ORG_A, {
      title: `Withheld report ${RUN}`,
      precisionPolicy: "withheld",
    });
    withheld = b.id;
    await awareness.shareObservation(
      tokenIcA,
      ORG_A,
      withheld,
      { partnerOrgId: ORG_B, incidentId, disclosureProfile: "operational" },
      meta,
    );

    const c = await makeObservation(tokenSupervisorA, ORG_A, {
      title: `Org-only report ${RUN}`,
      incidentId: null,
      classification: "originating_org_only",
    });
    orgOnly = c.id;
  }, 60_000);

  dbit("strips every restricted source field from the partner payload", async () => {
    const detail = await awareness.getObservation(tokenPartnerB, ORG_B, shared, meta);
    const view = detail.observation as Record<string, unknown>;
    expect(view.relationship).toBe("partner");
    for (const field of RESTRICTED_SOURCE_FIELDS) {
      expect(field in view, `${field} leaked to the partner`).toBe(false);
    }
    for (const field of OWNER_ONLY_FIELDS) {
      expect(field in view, `${field} leaked to the partner`).toBe(false);
    }
    expect(JSON.stringify(detail)).not.toContain("Jane Q. Reporter");
    expect(JSON.stringify(detail)).not.toContain("+1-518-555-0147");
    expect(JSON.stringify(detail)).not.toContain("known complainant");
  });

  dbit("keeps the reliability, credibility and confidence the owner recorded", async () => {
    const detail = await awareness.getObservation(tokenPartnerB, ORG_B, shared, meta);
    expect(detail.observation.sourceReliability).toBe("usually_reliable");
    expect(detail.observation.informationCredibility).toBe("probably_true");
    expect(detail.observation.sourceType).toBe("public_report");
  });

  dbit("reduces geography to the profile ceiling and never returns the exact point", async () => {
    const owner = await awareness.getObservation(tokenSupervisorA, ORG_A, shared, meta);
    expect(owner.observation.precision).toBe("exact");
    expect(owner.observation.geometry).toMatchObject({ type: "Point" });

    const partner = await awareness.getObservation(tokenPartnerB, ORG_B, shared, meta);
    expect(partner.observation.precision).toBe("area_only");
    expect(partner.observation.geometry?.type).toBe("Polygon");
    const body = JSON.stringify(partner.observation.geometry);
    expect(body).not.toContain(String(EXACT[0]));
    expect(body).not.toContain(String(EXACT[1]));
  });

  dbit("omits geography entirely when the owner withheld it", async () => {
    const partner = await awareness.getObservation(tokenPartnerB, ORG_B, withheld, meta);
    expect(partner.observation.precision).toBe("withheld");
    expect(partner.observation.geometry).toBeUndefined();
    expect("geometry" in partner.observation).toBe(false);
  });

  dbit("keeps internal annotations and information gaps inside the owning agency", async () => {
    await awareness.addAnnotation(
      tokenSupervisorA,
      ORG_A,
      shared,
      { annotationType: "review_note", body: `Internal only ${RUN}`, visibility: "internal" },
      meta,
    );
    await awareness.addInformationGap(
      tokenSupervisorA,
      ORG_A,
      shared,
      { gapType: "operator_unknown", detail: `Owner gap ${RUN}` },
      meta,
    );
    const partner = await awareness.getObservation(tokenPartnerB, ORG_B, shared, meta);
    expect(JSON.stringify(partner)).not.toContain(`Internal only ${RUN}`);
    expect(JSON.stringify(partner)).not.toContain(`Owner gap ${RUN}`);
    expect(partner.gaps).toHaveLength(0);
  });

  dbit("hides an unshared observation from the partner entirely", async () => {
    await expect(
      awareness.getObservation(tokenPartnerB, ORG_B, orgOnly, meta),
    ).rejects.toMatchObject({ code: "observation_not_found" });
    const list = await awareness.listObservations(tokenPartnerB, ORG_B, { limit: 500 }, meta);
    expect(list.some((o) => o.id === orgOnly)).toBe(false);
    expect(list.some((o) => o.id === shared)).toBe(true);
  });

  dbit("hides everything from an unrelated organization", async () => {
    await expect(
      awareness.getObservation(tokenOutsiderC, ORG_C, shared, meta),
    ).rejects.toMatchObject({ code: "observation_not_found" });
    const list = await awareness.listObservations(tokenOutsiderC, ORG_C, { limit: 500 }, meta);
    expect(list).toHaveLength(0);
    const summary = await awareness.awarenessSummary(tokenOutsiderC, ORG_C, {}, meta);
    expect(summary.total).toBe(0);
  });

  dbit("refuses every partner write attempt", async () => {
    await expect(
      awareness.updateObservation(
        tokenPartnerB,
        ORG_B,
        shared,
        {
          observationType: "suspected_unauthorized_uas",
          title: "hijacked",
          locationKind: "none",
          sourceType: "public_report",
        },
        meta,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      awareness.setVerificationStatus(tokenPartnerB, ORG_B, shared, { status: "confirmed" }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      awareness.setLifecycleStatus(tokenPartnerB, ORG_B, shared, { status: "closed" }, meta),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      awareness.shareObservation(
        tokenPartnerB,
        ORG_B,
        shared,
        { partnerOrgId: ORG_C, incidentId },
        meta,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const owner = await awareness.getObservation(tokenSupervisorA, ORG_A, shared, meta);
    expect(owner.observation.title).toBe(`Shared report ${RUN}`);
    expect(owner.observation.lifecycleStatus).toBe("open");
  });

  dbit("refuses to share with an organization that is not an approved partner", async () => {
    await expect(
      awareness.shareObservation(
        tokenIcA,
        ORG_A,
        shared,
        { partnerOrgId: ORG_C, incidentId },
        meta,
      ),
    ).rejects.toMatchObject({ code: "partner_not_eligible" });
  });

  dbit("ends partner access the moment the share is revoked", async () => {
    const obs = await makeObservation(tokenSupervisorA, ORG_A, {
      title: `Revocable report ${RUN}`,
      incidentId: null,
      classification: "originating_org_only",
    });
    const share = await awareness.shareObservation(
      tokenIcA,
      ORG_A,
      obs.id,
      { partnerOrgId: ORG_B, disclosureProfile: "operational", precisionPolicy: "generalized" },
      meta,
    );
    const before = await awareness.getObservation(tokenPartnerB, ORG_B, obs.id, meta);
    expect(before.observation.id).toBe(obs.id);

    await awareness.revokeObservationShare(tokenIcA, ORG_A, share.id, meta);
    await expect(
      awareness.getObservation(tokenPartnerB, ORG_B, obs.id, meta),
    ).rejects.toMatchObject({ code: "observation_not_found" });
    // The owner still holds the complete record.
    const owner = await awareness.getObservation(tokenSupervisorA, ORG_A, obs.id, meta);
    expect(owner.observation.reporterIdentity).toBe("Jane Q. Reporter");
  });
});

describe("incident closure ends the awareness plane it created", () => {
  dbit("closes open observations and revokes every room-scoped share", async () => {
    const partnerBefore = await awareness.listObservations(
      tokenPartnerB,
      ORG_B,
      { incidentId, limit: 500 },
      meta,
    );
    expect(partnerBefore.length).toBeGreaterThan(0);

    const current = await incidents.readIncident(tokenIcA, ORG_A, incidentId, meta);
    await incidents.closeIncident(
      tokenIcA,
      ORG_A,
      incidentId,
      { expectedVersion: current.incident.version, reason: "Awareness verification complete." },
      meta,
    );

    const partnerAfter = await awareness.listObservations(tokenPartnerB, ORG_B, { limit: 500 }, meta);
    expect(partnerAfter.some((o) => o.incidentId === incidentId)).toBe(false);

    const rows = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM airs.observations
        WHERE incident_id = $1 AND lifecycle_status IN ('open','monitoring','action_required')`,
      [incidentId],
    );
    expect(rows.rows[0]!.n).toBe("0");

    const shares = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM airs.observation_shares
        WHERE incident_id = $1 AND status = 'active'`,
      [incidentId],
    );
    expect(shares.rows[0]!.n).toBe("0");
    void incidentVersion;
  });

  dbit("still lets the owning agency read its own closed record in full", async () => {
    const list = await awareness.listObservations(
      tokenAdminA,
      ORG_A,
      { incidentId, includeTerminal: true, limit: 500 },
      meta,
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((o) => o.relationship === "owner")).toBe(true);
  });

  dbit("refuses a new observation filed into the closed room", async () => {
    await expect(makeObservation(tokenSupervisorA, ORG_A)).rejects.toMatchObject({
      code: "incident_closed",
    });
  });
});
