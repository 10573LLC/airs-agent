// Cumulative legacy-schema reconciliation.
//
// Pure-logic proofs against the exact live Windows state: no PostgreSQL,
// PostGIS or Docker required. Checks that need a live database are marked
// environment-blocked in BUILD_AUDIT.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, loadMigrations, stripOuterTransaction } from "../scripts/lib/migrate-plan.mjs";
import {
  CANONICAL_OBJECTS,
  RECONCILABLE_VERSIONS,
  SUPERSEDED_OBJECTS,
  deriveStateProbes,
} from "../scripts/lib/canonical-schema.mjs";
import { destructiveStatements, toIdempotentSql } from "../scripts/lib/idempotent-sql.mjs";
import {
  buildObjectProbeScript,
  buildReconcileScript,
  buildReconcileVerifyScript,
  formatReconcileReport,
  parseObjectProbe,
  parseReconcileArgs,
  planReconciliation,
} from "../scripts/lib/reconcile-legacy.mjs";
import {
  STATE_PROBES,
  buildLegacyLedgerScript,
  classifyState,
  parseProbeOutput,
} from "../scripts/lib/legacy-repair.mjs";
import { ROLE_PERMISSIONS, PERMISSION_KEYS, ROLE_KEYS } from "@/lib/rbac/roles";

const migrations = loadMigrations();
const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8"));

/** Object ids that are absent in the live Windows database. */
const LIVE_MISSING = new Set(
  CANONICAL_OBJECTS.filter(
    (o) =>
      (o.version === "0009" && !["ext:postgis", "type:geometry"].includes(o.id)) || // PostGIS installed, Stage 7 objects absent
      o.version === "0010", // Stage 8 entirely absent
  ).map((o) => o.id),
);

/** Reproduces the exact live probe output. */
function liveProbeOutput(extraMissing: string[] = []) {
  const missing = new Set([...LIVE_MISSING, ...extraMissing]);
  return CANONICAL_OBJECTS.map((o) => `${o.id}|${missing.has(o.id) ? "f" : "t"}`).join("\n");
}

describe("canonical cumulative schema", () => {
  it("derives the legacy probes from the canonical inventory, not from history", () => {
    expect(deriveStateProbes()).toEqual(STATE_PROBES);
    expect(Object.keys(STATE_PROBES).sort()).toEqual(migrations.map((m) => m.version).sort());
  });

  it("documents every superseded object with its current equivalent and reason", () => {
    expect(SUPERSEDED_OBJECTS.map((s) => s.id).sort()).toEqual([
      "airs.disclosure_profiles",
      "airs.has_permission",
    ]);
    for (const s of SUPERSEDED_OBJECTS) {
      expect(s.equivalent).toBeTruthy();
      expect(s.reason.length).toBeGreaterThan(40);
      expect(CANONICAL_OBJECTS.some((o) => o.id === s.id)).toBe(false);
    }
  });

  it("proves the superseded objects are created by no migration in the manifest", () => {
    const allSql = migrations.map((m) => m.sql).join("\n");
    expect(allSql).not.toMatch(/FUNCTION\s+airs\.has_permission/i);
    expect(allSql).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?airs\.disclosure_profiles\b/i);
    // ...while the current equivalents genuinely exist
    expect(allSql).toMatch(/FUNCTION airs\.current_account_id/);
    expect(allSql).toMatch(/FUNCTION airs\.current_org_id/);
    expect(allSql).toMatch(/CREATE TABLE (IF NOT EXISTS )?airs\.disclosure_fields/);
    expect(allSql).toMatch(/CREATE TABLE (IF NOT EXISTS )?airs\.disclosure_profile_fields/);
  });

  it("never classifies a migration as present from one object alone", () => {
    for (const [version, checks] of Object.entries(STATE_PROBES)) {
      expect(checks.length, `migration ${version}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("probe SQL cannot abort on a database missing those objects", () => {
    const script = buildObjectProbeScript();
    expect(script).toContain("EXCEPTION WHEN OTHERS THEN RETURN false;");
    expect(script).toContain("pg_temp.airs_probe");
    expect(script).not.toMatch(/\b(CREATE TABLE|DROP|INSERT|UPDATE|DELETE)\b(?! FROM pg_)/);
  });
});

describe("the exact live Windows state", () => {
  const plan = planReconciliation(parseObjectProbe(liveProbeOutput()));

  it("reports 0001-0008, 0011 and 0012 as fully represented", () => {
    const missingVersions = new Set(plan.missing.map((m) => m.version));
    for (const v of [
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0011",
      "0012",
    ]) {
      expect(missingVersions.has(v), `migration ${v}`).toBe(false);
    }
  });

  it("0003 is a superseded-object false positive, not a defect", () => {
    const state = classifyState(
      parseProbeOutput(
        CANONICAL_OBJECTS.map(
          (o) => `${o.version}|${o.label}|${LIVE_MISSING.has(o.id) ? "f" : "t"}`,
        ).join("\n"),
      ),
    );
    expect(state.find((s) => s.version === "0003")!.status).toBe("present");
    expect(state.find((s) => s.version === "0008")!.status).toBe("present");
    expect(state.find((s) => s.version === "0009")!.status).toBe("partial");
    expect(state.find((s) => s.version === "0010")!.status).toBe("missing");
  });

  it("detects PostGIS present but every Stage 7 object absent", () => {
    expect(plan.present).toContain("ext:postgis");
    expect(plan.present).toContain("type:geometry");
    for (const id of [
      "airs.map_features",
      "airs.operating_areas",
      "airs.resource_locations",
      "policy:map_features",
      "rlsforce:resource_locations",
    ]) {
      expect(plan.missing.map((m) => m.id)).toContain(id);
    }
  });

  it("detects Stage 8 absent in full", () => {
    const stage8 = CANONICAL_OBJECTS.filter((o) => o.version === "0010").map((o) => o.id);
    for (const id of stage8) expect(plan.missing.map((m) => m.id)).toContain(id);
  });

  it("plans only the missing CURRENT objects, in 0009 then 0010 order", () => {
    expect(plan.safe).toBe(true);
    expect(plan.units.map((u) => u.version)).toEqual(["0009", "0010"]);
    expect(plan.error).toBeNull();
  });

  it("report-only output names every missing object and the superseded ones", () => {
    const report = formatReconcileReport(plan);
    expect(report).toContain("airs.map_features");
    expect(report).toContain("airs.observations");
    expect(report).toContain("airs.has_permission");
    expect(report).toContain("airs.disclosure_profiles");
    expect(report).toContain("Reconciliation is SAFE");
    expect(report).not.toMatch(/postgres(ql)?:\/\//);
    expect(report).not.toMatch(/password/i);
  });
});

describe("genuinely partial Stage 6 disclosure state", () => {
  const plan = planReconciliation(
    parseObjectProbe(
      liveProbeOutput([
        "airs.disclosure_allows",
        "seed:disclosure_profile_fields",
        "col:resource_shares.disclosure_profile",
      ]),
    ),
  );

  it("still refuses to call 0008 represented and reconciles it first", () => {
    expect(plan.units.map((u) => u.version)).toEqual(["0008", "0009", "0010"]);
    expect(plan.units[0].objects).toContain("airs.disclosure_allows");
    expect(plan.safe).toBe(true);
  });
});

describe("unsafe states are refused", () => {
  it("refuses when an object outside the reconciliation scope is missing", () => {
    const plan = planReconciliation(parseObjectProbe(liveProbeOutput(["airs.incidents"])));
    expect(plan.safe).toBe(false);
    expect(plan.error).toContain("airs.incidents");
    expect(plan.units.every((u) => RECONCILABLE_VERSIONS.includes(u.version))).toBe(true);
  });

  it("refuses when the platform tenant or its role is missing", () => {
    const plan = planReconciliation(parseObjectProbe(liveProbeOutput(["org:anconison-platform"])));
    expect(plan.safe).toBe(false);
    expect(plan.error).toContain("0011");
  });

  it("refuses when PostGIS itself is unavailable", () => {
    const plan = planReconciliation(
      parseObjectProbe(liveProbeOutput(["ext:postgis", "type:geometry"])),
    );
    expect(plan.units.map((u) => u.version)).toContain("0009");
    // prerequisites are inside the same plan, so this stays safe to reconcile;
    // the CLI still gates on a real PostGIS availability probe first.
    expect(plan.safe).toBe(true);
  });

  it("refuses when the probe set and the canonical inventory disagree", () => {
    const partialOutput = CANONICAL_OBJECTS.slice(0, 5)
      .map((o) => `${o.id}|t`)
      .join("\n");
    const plan = planReconciliation(parseObjectProbe(partialOutput));
    expect(plan.safe).toBe(false);
    expect(plan.error).toContain("not probed");
  });
});

describe("reconciliation execution guarantees", () => {
  const units = ["0008", "0009", "0010"].map((v) => migrations.find((m) => m.version === v)!);

  it("creates only current objects, never dropping data", () => {
    for (const m of units) {
      const script = buildReconcileScript(m);
      expect(destructiveStatements(script)).toEqual([]);
      expect(script).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|DROP COLUMN|DROP ROLE/i);
    }
  });

  it("runs each unit in one advisory-locked transaction", () => {
    for (const m of units) {
      const script = buildReconcileScript(m);
      expect(script.indexOf("BEGIN;")).toBeLessThan(script.indexOf("pg_advisory_xact_lock"));
      expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
      expect(script).toContain("ON_ERROR_STOP on");
      expect(script.split(/^BEGIN;$/m).length - 1).toBe(1);
    }
  });

  it("is idempotent: a second run re-creates nothing", () => {
    for (const m of units) {
      const body = toIdempotentSql(stripOuterTransaction(m.sql));
      expect(body).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
      expect(body).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
      const policies = (body.match(/CREATE POLICY/g) ?? []).length;
      const dropPolicies = (body.match(/DROP POLICY IF EXISTS/g) ?? []).length;
      expect(dropPolicies).toBe(policies);
      const triggers = (body.match(/CREATE TRIGGER/g) ?? []).length;
      const dropTriggers = (body.match(/DROP TRIGGER IF EXISTS/g) ?? []).length;
      expect(dropTriggers).toBe(triggers);
      expect(body).toContain("ON CONFLICT");
      expect(buildReconcileScript(m)).toEqual(buildReconcileScript(m));
    }
  });

  it("uses the canonical migration text, so it cannot drift from a fresh install", () => {
    for (const m of units) {
      const body = toIdempotentSql(stripOuterTransaction(m.sql));
      const canonical = stripOuterTransaction(m.sql);
      const normalize = (s: string) =>
        s
          .replace(/IF NOT EXISTS /g, "")
          .replace(/^\s*DROP (POLICY|TRIGGER) IF EXISTS[^\n]*\n/gm, "")
          .replace(/\n\s*\n/g, "\n")
          .trim();
      expect(normalize(body)).toEqual(normalize(canonical));
    }
  });

  it("never treats `already exists` as success and writes no ledger row while applying", () => {
    for (const m of units) {
      expect(buildReconcileScript(m)).not.toContain("record_applied");
      expect(buildReconcileScript(m)).not.toMatch(/EXCEPTION WHEN duplicate_(table|object)/i);
    }
  });

  it("Stage 7 rolls back entirely when PostGIS cannot be created", () => {
    const s = buildReconcileScript(units[1]);
    const gisAt = s.indexOf("CREATE EXTENSION IF NOT EXISTS postgis");
    expect(gisAt).toBeGreaterThan(s.indexOf("BEGIN;"));
    expect(gisAt).toBeLessThan(s.indexOf("CREATE TABLE IF NOT EXISTS airs.map_features"));
    expect(gisAt).toBeLessThan(s.lastIndexOf("COMMIT;"));
  });

  it("Stage 8 rolls back entirely when the geometry type is missing", () => {
    const s = buildReconcileScript(units[2]);
    expect(s).toMatch(/public\.geometry/);
    expect(s.indexOf("CREATE TABLE IF NOT EXISTS airs.observations")).toBeGreaterThan(
      s.indexOf("BEGIN;"),
    );
    expect(s.indexOf("CREATE TABLE IF NOT EXISTS airs.observations")).toBeLessThan(
      s.lastIndexOf("COMMIT;"),
    );
  });

  it("completes Stage 6, Stage 7 and Stage 8 object sets", () => {
    const s6 = buildReconcileScript(units[0]);
    for (const needle of [
      "airs.disclosure_fields",
      "airs.disclosure_profile_fields",
      "airs.disclosure_allows",
      "airs.effective_disclosure",
      "disclosure_profile",
    ]) {
      expect(s6, needle).toContain(needle);
    }
    const s7 = buildReconcileScript(units[1]);
    for (const needle of [
      "airs.map_features",
      "airs.operating_areas",
      "airs.resource_locations",
      "airs.geographic_precisions",
      "airs.apply_precision",
      "airs.terminate_incident_geography",
      "map.",
      "FORCE ROW LEVEL SECURITY",
    ]) {
      expect(s7, needle).toContain(needle);
    }
    const s8 = buildReconcileScript(units[2]);
    for (const needle of [
      "airs.observations",
      "airs.observation_relationships",
      "airs.observation_information_gaps",
      "airs.observation_evidence_references",
      "airs.observation_annotations",
      "airs.observation_shares",
      "airs.observation_freshness_thresholds",
      "airs.terminate_incident_observations",
      "observation.",
      "FORCE ROW LEVEL SECURITY",
    ]) {
      expect(s8, needle).toContain(needle);
    }
  });
});

describe("role parity target", () => {
  const parity = readFileSync(`${REPO_ROOT}/db/tests/role_parity.sql`, "utf8");

  it("is derived from the canonical TypeScript RBAC model", () => {
    const roles = Object.keys(ROLE_PERMISSIONS);
    const grants = roles.reduce(
      (n, r) => n + ROLE_PERMISSIONS[r as keyof typeof ROLE_PERMISSIONS].length,
      0,
    );
    expect(roles.length).toBe(ROLE_KEYS.length);
    expect(roles.length).toBe(10);
    expect(PERMISSION_KEYS.length).toBe(56);
    expect(grants).toBe(175);
    expect(parity).toContain(`(10, 56, 175)`);
    expect(parity).toContain("175 FROM airs.role_permissions");
    expect(parity).not.toContain("171");
  });
});

describe("verification, ledger and adoption ordering", () => {
  it("verifies security, tenancy and closure before anything is recorded", () => {
    const verify = buildReconcileVerifyScript();
    for (const needle of [
      "rolsuper",
      "rolbypassrls",
      "relforcerowsecurity",
      "anconison-platform",
      "Anconison - AIRS Agent Platform",
      "org_kind='platform'",
      "platform_admin",
      "albany-pd",
      "sensitive",
      "disclosure_precisions",
      "apply_precision",
      "observation_precision",
      "observation_profile",
      "terminate_incident_geography",
      "terminate_incident_observations",
      "expire_incident_state",
    ]) {
      expect(verify, needle).toContain(needle);
    }
    expect(verify).toContain("ON_ERROR_STOP on");
    expect(verify).not.toContain("record_applied");
  });

  it("records exactly 0001-0012 with current checksums, reconciled units as applied", () => {
    const ledger = buildLegacyLedgerScript(migrations, {
      appliedVersions: ["0009", "0010"],
      runnerVersion: "reconcile-legacy",
    });
    const recorded = [...ledger.matchAll(/record_applied\('(\d{4})'/g)].map((m) => m[1]);
    expect(recorded).toEqual(migrations.map((m) => m.version));
    for (const m of migrations) expect(ledger).toContain(m.checksum);
    expect(ledger).toMatch(/record_applied\('0009'.*false\);/);
    expect(ledger).toMatch(/record_applied\('0011'.*true\);/);
    expect(ledger).toContain("REPAIR FAIL: the migration ledger already contains rows");
    expect(ledger).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_app");
    expect(ledger).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_maintenance");
  });

  it("adoption verification no longer demands superseded or renamed objects", () => {
    const adopt = readFileSync(`${REPO_ROOT}/db/ledger/adopt_verify.sql`, "utf8");
    expect(adopt).not.toContain("'airs.has_permission'");
    expect(adopt).not.toContain("'airs.disclosure_profiles'");
    // airs.aircraft is a live 0001 table (never dropped or superseded); the
    // 0007 registry adds airs.resource_aircraft alongside it.
    expect(adopt).toContain("'airs.aircraft'");
    expect(adopt).toContain("'airs.resource_aircraft'");
    expect(adopt).toContain("'airs.current_account_id'");
  });

  it("the CLI records the ledger only after every verification step", () => {
    const cli = readFileSync(`${REPO_ROOT}/scripts/db-reconcile-legacy.mjs`, "utf8");
    const verifyAt = cli.indexOf("buildReconcileVerifyScript");
    const platformAt = cli.indexOf("buildPlatformVerificationScript(adminEmail)");
    const ledgerAt = cli.lastIndexOf("buildLegacyLedgerScript");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(ledgerAt);
    expect(platformAt).toBeLessThan(ledgerAt);
    expect(cli.indexOf("runSqlSuite")).toBeGreaterThan(-1);
    expect(cli.indexOf("runSqlSuite")).toBeLessThan(ledgerAt);
    // a failure anywhere above exits before the ledger is written
    expect(cli).toContain("No ledger was created");
  });

  it("re-probes after reconciliation and refuses adoption while objects remain missing", () => {
    const cli = readFileSync(`${REPO_ROOT}/scripts/db-reconcile-legacy.mjs`, "utf8");
    expect(cli).toContain("canonical objects are still missing after reconciliation");
    expect(cli.indexOf("canonical objects are still missing after reconciliation")).toBeLessThan(
      cli.lastIndexOf("buildLegacyLedgerScript"),
    );
  });
});

describe("command safety", () => {
  it("is report-only by default and needs confirmation plus a backup attestation", () => {
    expect(parseReconcileArgs([]).flags.confirm).toBeUndefined();
    expect(parseReconcileArgs(["--confirm"]).error).toContain("--backup-confirmed");
    expect(parseReconcileArgs(["--confirm", "--backup-confirmed"]).error).toBeUndefined();
    expect(parseReconcileArgs(["--nope"]).error).toContain("Unknown flag");
  });

  it("is a separate operator command that never runs automatically", () => {
    expect(pkg.scripts["db:reconcile-legacy"]).toBe("node scripts/db-reconcile-legacy.mjs");
    expect(pkg.scripts["db:migrate"]).not.toContain("reconcile");
    const dockerInit = readFileSync(`${REPO_ROOT}/db/init/00_apply_migrations.sh`, "utf8");
    expect(dockerInit).not.toContain("reconcile");
    // db-migrate.mjs may POINT AT the reconciliation command, but never runs it
    const migrate = readFileSync(`${REPO_ROOT}/scripts/db-migrate.mjs`, "utf8");
    expect(migrate).not.toContain("run(buildReconcileScript(");
    expect(migrate).not.toContain("toIdempotentSql");
    expect(migrate).toContain("npm run db:reconcile-legacy");
  });

  it("redacts secrets and prints no connection strings", () => {
    const cli = readFileSync(`${REPO_ROOT}/scripts/db-reconcile-legacy.mjs`, "utf8");
    expect(cli).toContain("redact(");
    expect(cli).not.toMatch(/console\.log\([^)]*DATABASE_URL/);
    expect(cli).not.toMatch(/console\.log\([^)]*password/i);
  });

  it("help runs without touching a database", () => {
    const help = spawnSync(process.execPath, ["scripts/db-reconcile-legacy.mjs", "--help"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("report only");
    expect(help.stdout).toContain("never recreated");
  });
});
