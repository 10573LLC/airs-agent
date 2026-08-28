// Docker/PostGIS deployment defect + legacy (pre-ledger) repair path.
//
// Pure-logic proofs: no PostgreSQL, PostGIS or Docker required. Checks that
// need a live database are marked environment-blocked in BUILD_AUDIT.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, loadMigrations, stripOuterTransaction } from "../scripts/lib/migrate-plan.mjs";
import {
  REPAIRABLE_VERSIONS,
  REQUIRED_DB_IMAGE,
  STATE_PROBES,
  SUPERSEDED_OBJECTS,
  buildLegacyLedgerScript,
  buildLegacyMigrationScript,
  buildPlatformVerificationScript,
  buildPostgisProbeScript,
  buildStateProbeScript,
  classifyState,
  parsePostgisProbe,
  parseProbeOutput,
  parseRepairArgs,
  planRepair,
} from "../scripts/lib/legacy-repair.mjs";

const migrations = loadMigrations();
const compose = readFileSync(`${REPO_ROOT}/docker-compose.yml`, "utf8");
const dockerInit = readFileSync(`${REPO_ROOT}/db/init/00_apply_migrations.sh`, "utf8");
const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8"));

/** The exact known live state: 0001-0008 present, 0009/0010 missing, 0011/0012 present. */
function liveStateOutput() {
  const missing = new Set(["0009", "0010"]);
  return Object.entries(STATE_PROBES)
    .flatMap(([version, checks]) =>
      checks.map(([label]) => `${version}|${label}|${missing.has(version) ? "f" : "t"}`),
    )
    .join("\n");
}

describe("database image", () => {
  it("is pinned to a PostgreSQL 16 + PostGIS image, never latest", () => {
    expect(compose).toContain(`image: ${REQUIRED_DB_IMAGE}`);
    expect(compose).not.toMatch(/^\s*image:\s*postgres:16-alpine\s*$/m);
    expect(compose).not.toMatch(/image:\s*\S*:latest/);
  });

  it("preserves the existing volume, database name, roles, ports and health check", () => {
    expect(compose).toContain("airs_pgdata:/var/lib/postgresql/data");
    expect(compose).toContain("POSTGRES_DB: airs");
    expect(compose).toContain("POSTGRES_USER: airs_owner");
    expect(compose).toContain('"5432:5432"');
    expect(compose).toContain("pg_isready -U airs_owner -d airs");
    expect(compose).not.toContain("down -v");
  });
});

describe("fresh Docker installation", () => {
  it("rejects a plain PostgreSQL image with an actionable error", () => {
    expect(dockerInit).toContain("pg_available_extensions WHERE name = 'postgis'");
    expect(dockerInit).toContain("FATAL - PostGIS is not available");
    expect(dockerInit).toContain(REQUIRED_DB_IMAGE);
    expect(dockerInit).toContain("exit 1");
  });

  it("enables PostGIS before any migration and still uses the canonical manifest + ledger", () => {
    const gisAt = dockerInit.indexOf("CREATE EXTENSION IF NOT EXISTS postgis");
    const ledgerAt = dockerInit.indexOf("ledger/0000_migration_ledger.sql");
    const applyAt = dockerInit.lastIndexOf("migrations/manifest.txt");
    expect(gisAt).toBeGreaterThan(-1);
    expect(gisAt).toBeLessThan(ledgerAt);
    expect(ledgerAt).toBeLessThan(applyAt);
    expect(dockerInit).toContain("postgis_full_version()");
    expect(dockerInit).toContain("record_applied");
  });

  it("never depends on host-installed PostGIS", () => {
    expect(dockerInit).not.toMatch(/apt-get|apk add/);
  });
});

describe("migration-specific state probes", () => {
  it("covers every manifest migration", () => {
    expect(Object.keys(STATE_PROBES).sort()).toEqual(migrations.map((m) => m.version).sort());
  });

  it("never classifies a migration as present from one table alone", () => {
    for (const [version, checks] of Object.entries(STATE_PROBES)) {
      expect(checks.length, `migration ${version}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("probes the specific objects the stage requirements name", () => {
    const text = JSON.stringify(STATE_PROBES);
    for (const needle of [
      "airs.resources", "resource.%",
      "airs.disclosure_fields", "airs.disclosure_profile_fields",
      "pg_extension WHERE extname = 'postgis'", "public.geometry",
      "airs.map_features", "airs.operating_areas", "airs.resource_locations", "map.%",
      "airs.observations", "airs.observation_relationships",
      "airs.observation_information_gaps", "airs.observation_evidence_references", "observation.%",
      "anconison-platform", "platform_admin",
      "Anconison - AIRS Agent Platform",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("never probes an object later migrations superseded", () => {
    const text = JSON.stringify(STATE_PROBES);
    expect(text).not.toContain("has_permission");
    expect(text).not.toContain("airs.disclosure_profiles'");
    for (const s of SUPERSEDED_OBJECTS) {
      expect(text, s.id).not.toContain(`proname='${s.id.split(".")[1]}'`);
      expect(s.equivalent.length).toBeGreaterThan(0);
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it("still probes the genuinely required current equivalents", () => {
    const text = JSON.stringify(STATE_PROBES);
    expect(text).toContain("proname='ctx'");
    expect(text).toContain("proname='current_account_id'");
    expect(text).toContain("proname='disclosure_allows'");
  });

  it("probe SQL cannot abort on a database missing those objects", () => {
    const script = buildStateProbeScript();
    expect(script).toContain("EXCEPTION WHEN OTHERS THEN RETURN false;");
    expect(script).toContain("pg_temp.airs_probe");
  });
});

describe("legacy state classification", () => {
  const state = classifyState(parseProbeOutput(liveStateOutput()));

  it("detects the exact known noncontiguous live state", () => {
    const byVersion = Object.fromEntries(state.map((s) => [s.version, s.status]));
    expect(byVersion).toEqual({
      "0001": "present", "0002": "present", "0003": "present", "0004": "present",
      "0005": "present", "0006": "present", "0007": "present", "0008": "present",
      "0009": "missing", "0010": "missing",
      "0011": "present", "0012": "present", "0013": "present", "0014": "present", "0015": "present", "0016": "present",
    });
  });

  it("plans only 0009 and 0010, replaying nothing else", () => {
    const plan = planRepair(state, migrations);
    expect(plan.error).toBeNull();
    expect(plan.apply.map((m) => m.version)).toEqual(["0009", "0010"]);
    expect(plan.present).toContain("0011");
    expect(plan.present).toContain("0012");
    expect(plan.apply.map((m) => m.version)).not.toContain("0011");
    expect(plan.apply.map((m) => m.version)).not.toContain("0012");
    expect(REPAIRABLE_VERSIONS).toEqual(["0009", "0010"]);
  });

  it("refuses to repair a partially applied migration", () => {
    const partial = classifyState([
      { version: "0009", label: "postgis extension", ok: true },
      { version: "0009", label: "map_features table", ok: false },
    ]);
    expect(partial[0].status).toBe("partial");
    expect(planRepair(partial, migrations).error).toContain("PARTIALLY");
  });

  it("refuses when a migration outside the repair scope is missing", () => {
    const state2 = classifyState(
      parseProbeOutput(liveStateOutput().replace(/^0007\|(.*)\|t$/gm, "0007|$1|f")),
    );
    expect(planRepair(state2, migrations).error).toContain("0007");
  });
});

describe("repair execution guarantees", () => {
  const m9 = migrations.find((m) => m.version === "0009")!;
  const m10 = migrations.find((m) => m.version === "0010")!;

  it("runs each missing migration in one advisory-locked transaction", () => {
    for (const m of [m9, m10]) {
      const script = buildLegacyMigrationScript(m);
      expect(script.indexOf("BEGIN;")).toBeLessThan(script.indexOf("pg_advisory_xact_lock"));
      expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
      expect(script).toContain("ON_ERROR_STOP on");
      // exactly one outer transaction: the migration's own BEGIN/COMMIT is stripped
      expect(script.split(/^BEGIN;$/m).length - 1).toBe(1);
      expect(stripOuterTransaction(m.sql)).not.toMatch(/^BEGIN;$/m);
    }
  });

  it("0009 rolls back entirely when PostGIS cannot be created", () => {
    // CREATE EXTENSION is inside the same transaction as every Stage 7 object,
    // so ON_ERROR_STOP + no COMMIT means no partial tables/permissions/policies.
    const script = buildLegacyMigrationScript(m9);
    const gisAt = script.indexOf("CREATE EXTENSION IF NOT EXISTS postgis");
    expect(gisAt).toBeGreaterThan(script.indexOf("BEGIN;"));
    expect(gisAt).toBeLessThan(script.indexOf("CREATE TABLE airs.map_features"));
    expect(gisAt).toBeLessThan(script.lastIndexOf("COMMIT;"));
  });

  it("0010 rolls back entirely when the geometry type is missing", () => {
    const script = buildLegacyMigrationScript(m10);
    expect(script).toMatch(/public\.geometry/);
    expect(script.indexOf("CREATE TABLE airs.observations")).toBeGreaterThan(script.indexOf("BEGIN;"));
    expect(script.indexOf("CREATE TABLE airs.observations")).toBeLessThan(script.lastIndexOf("COMMIT;"));
  });

  it("writes no ledger row while applying - the ledger comes last", () => {
    expect(buildLegacyMigrationScript(m9)).not.toContain("record_applied");
    expect(buildLegacyMigrationScript(m10)).not.toContain("record_applied");
  });

  it("a retry after PostGIS exists simply re-runs the same idempotent script", () => {
    expect(buildLegacyMigrationScript(m9)).toEqual(buildLegacyMigrationScript(m9));
    expect(m9.sql).toContain("CREATE EXTENSION IF NOT EXISTS postgis");
  });
});

describe("ledger creation after verification", () => {
  const ledger = buildLegacyLedgerScript(migrations, { appliedVersions: ["0009", "0010"] });

  it("records exactly 0001-0012 with current checksums", () => {
    const recorded = [...ledger.matchAll(/record_applied\('(\d{4})'/g)].map((m) => m[1]);
    expect(recorded).toEqual(migrations.map((m) => m.version));
    for (const m of migrations) expect(ledger).toContain(m.checksum);
  });

  it("marks repaired migrations applied and pre-existing ones adopted", () => {
    expect(ledger).toMatch(/record_applied\('0009'.*false\);/);
    expect(ledger).toMatch(/record_applied\('0011'.*true\);/);
  });

  it("refuses to write into an already populated ledger", () => {
    expect(ledger).toContain("REPAIR FAIL: the migration ledger already contains rows");
    expect(ledger.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      ledger.indexOf("SELECT airs_migrations.record_applied("),
    );
  });

  it("keeps airs_app and airs_maintenance denied ledger access", () => {
    expect(ledger).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_app");
    expect(ledger).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_maintenance");
  });
});

describe("repair command safety", () => {
  it("requires explicit confirmation plus a backup attestation", () => {
    expect(parseRepairArgs([]).flags.confirm).toBeUndefined();
    expect(parseRepairArgs(["--confirm"]).error).toContain("--backup-confirmed");
    expect(parseRepairArgs(["--confirm", "--backup-confirmed"]).error).toBeUndefined();
    expect(parseRepairArgs(["--nope"]).error).toContain("Unknown flag");
  });

  it("is a separate operator command that never runs automatically", () => {
    expect(pkg.scripts["db:migrate:repair-legacy"]).toBe("node scripts/db-migrate-repair-legacy.mjs");
    expect(pkg.scripts["db:migrate"]).not.toContain("repair");
    expect(dockerInit).not.toContain("repair-legacy");
    const source = readFileSync(`${REPO_ROOT}/scripts/db-migrate.mjs`, "utf8");
    expect(source).not.toContain("repair-legacy.mjs");
  });

  it("verifies the platform organization and administrator before recording", () => {
    const sql = buildPlatformVerificationScript("wflack@anconisonpmg.com");
    expect(sql).toContain("Anconison - AIRS Agent Platform");
    expect(sql).toContain("m.role_key='platform_admin'");
    expect(sql).toContain("REPAIR FAIL");
  });

  it("uses the canonical users.email_address column for the platform admin lookup", () => {
    const sql = buildPlatformVerificationScript("wflack@anconisonpmg.com");
    expect(sql).toContain("lower(u.email_address)");
    expect(sql).not.toMatch(/lower\(u\.email\)/);
    expect(sql).toContain("JOIN airs.memberships m ON m.user_id = u.id");
    expect(sql).toContain("o.slug='anconison-platform'");
    expect(sql).toContain("m.role_key='platform_admin'");
  });

  it("prints no passwords, URLs, tokens or connection strings", () => {
    const source = readFileSync(`${REPO_ROOT}/scripts/db-migrate-repair-legacy.mjs`, "utf8");
    expect(source).toContain("redact(");
    expect(source).not.toMatch(/console\.log\([^)]*DATABASE_URL/);
    expect(source).not.toMatch(/console\.log\([^)]*password/i);
  });

  it("help runs without touching a database and reports state only by default", () => {
    const help = spawnSync(process.execPath, ["scripts/db-migrate-repair-legacy.mjs", "--help"], {
      encoding: "utf8", cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: "" },
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Never runs automatically");
  });

  it("probes PostGIS availability and server major version", () => {
    const parsed = parsePostgisProbe("installed=no\navailable=yes\nserver_major=16\n");
    expect(parsed).toEqual({ installed: false, available: true, serverMajor: 16 });
    expect(buildPostgisProbeScript()).toContain("pg_available_extensions");
  });
});
