// Ledger-backed migration runner: manifest, checksums, pending-only execution,
// checksum immutability, adoption, dry-run/status safety, concurrency and
// path parity. Pure-logic proofs: no PostgreSQL or Docker required.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADVISORY_LOCK_KEYS,
  LEDGER_TABLE,
  MIGRATION_FILES,
  NO_PATH_ERROR,
  REPO_ROOT,
  VERIFICATION_FILES,
  buildAdoptionScript,
  buildLedgerReadScript,
  buildLockProbeScript,
  buildMigrationScript,
  diffMigrations,
  loadMigrations,
  parseMigrateArgs,
  parseVersion,
  planExecution,
  readManifest,
  redact,
  sha256,
  stripOuterTransaction,
} from "../scripts/lib/migrate-plan.mjs";

const URL_ = "postgres://airs_owner:s3cr3t@localhost:5432/airs";
const migrations = loadMigrations();
const ledgerSql = readFileSync(`${REPO_ROOT}/db/ledger/0000_migration_ledger.sql`, "utf8");
const adoptSql = readFileSync(`${REPO_ROOT}/db/ledger/adopt_verify.sql`, "utf8");
const dockerInit = readFileSync(`${REPO_ROOT}/db/init/00_apply_migrations.sh`, "utf8");

const runCli = (args: string[]) =>
  spawnSync(process.execPath, ["scripts/db-migrate.mjs", ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: "" },
  });

const filesUnder = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });

const rowsFor = (versions: string[]) =>
  migrations
    .filter((m) => versions.includes(m.version))
    .map((m) => ({ version: m.version, filename: m.filename, checksum: m.checksum }));

describe("canonical manifest", () => {
  it("is the single source of migration order for both execution paths", () => {
    expect(readManifest()).toEqual(MIGRATION_FILES);
    expect(MIGRATION_FILES[0]).toBe("db/migrations/0001_init.sql");
    expect(MIGRATION_FILES.at(-1)).toBe("db/migrations/0014_ics_command_operations.sql");
    expect(dockerInit).toContain("manifest.txt");
    expect(dockerInit).toContain("airs_migrations.record_applied");
  });

  it("sorts migrations by numeric version", () => {
    expect(migrations.map((m) => m.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
    ]);
    expect(parseVersion("db/migrations/0012_fix_platform_org_display_name.sql")).toBe("0012");
  });

  it("checksums each file with SHA-256 over its bytes", () => {
    for (const m of migrations) {
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(m.checksum).toBe(sha256(readFileSync(`${REPO_ROOT}/${m.path}`)));
    }
  });
});

describe("pending-only execution", () => {
  it("an empty ledger makes every manifest migration pending, in order", () => {
    const { applied, pending, conflicts } = diffMigrations(migrations, []);
    expect(applied).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
    expect(pending.map((m) => m.version)).toEqual(migrations.map((m) => m.version));
  });

  it("a fully recorded ledger leaves nothing pending (second run is a no-op)", () => {
    const { applied, pending } = diffMigrations(
      migrations,
      rowsFor(migrations.map((m) => m.version)),
    );
    expect(pending).toHaveLength(0);
    expect(applied).toHaveLength(migrations.length);
  });

  it("0001-0011 recorded and 0012 pending applies only 0012", () => {
    const recorded = migrations.filter((m) => m.version !== "0012").map((m) => m.version);
    const { pending } = diffMigrations(migrations, rowsFor(recorded));
    expect(pending.map((m) => m.version)).toEqual(["0012"]);
  });

  it("records exactly one ledger row per applied migration", () => {
    const script = buildMigrationScript(migrations[11]);
    expect(script.match(/record_applied/g)).toHaveLength(1);
    expect(script).toContain("'0012'");
    expect(script).toContain(migrations[11].checksum);
    expect(ledgerSql).toContain("version           text        PRIMARY KEY");
  });
});

describe("transaction, failure and concurrency protection", () => {
  const script = buildMigrationScript(migrations[0]);

  it("wraps each migration in one transaction with ON_ERROR_STOP", () => {
    expect(script).toContain("\\set ON_ERROR_STOP on");
    expect(script.indexOf("BEGIN;")).toBeLessThan(script.indexOf("record_applied"));
    expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("takes the advisory lock before touching migration state", () => {
    expect(script).toContain(
      `pg_advisory_xact_lock(${ADVISORY_LOCK_KEYS[0]}, ${ADVISORY_LOCK_KEYS[1]})`,
    );
    expect(script).toContain("SET LOCAL lock_timeout");
    expect(script.indexOf("pg_advisory_xact_lock")).toBeLessThan(script.indexOf("assert_pending"));
    expect(script.indexOf("assert_pending")).toBeLessThan(script.indexOf("migration body"));
  });

  it("cannot race: the guard aborts a runner whose migration was applied concurrently", () => {
    expect(script).toContain("airs_migrations.assert_pending('0001'");
    expect(ledgerSql).toContain("AIRS_MIGRATION_ALREADY_APPLIED");
    expect(ledgerSql).toContain("AIRS_MIGRATION_CHECKSUM_MISMATCH");
  });

  it("records the ledger row only after the migration body, inside the same transaction", () => {
    const bodyEnd = script.indexOf("-- <<< migration body");
    expect(bodyEnd).toBeGreaterThan(0);
    expect(script.indexOf("record_applied")).toBeGreaterThan(bodyEnd);
    // a rollback therefore removes the ledger entry with the migration itself
    expect(script.split("COMMIT;")).toHaveLength(2);
  });

  it("does not let a migration's own BEGIN/COMMIT commit the runner transaction early", () => {
    const stripped = stripOuterTransaction(
      readFileSync(`${REPO_ROOT}/${migrations[0].path}`, "utf8"),
    );
    expect(stripped).not.toMatch(/^COMMIT;$/m);
    expect(stripped).not.toMatch(/^BEGIN;$/m);
    // nested plpgsql blocks survive untouched
    expect(stripped).toMatch(/^BEGIN$/m);
    expect(stripped).toContain("CREATE SCHEMA IF NOT EXISTS airs");
  });
});

describe("checksum immutability", () => {
  it("stops on a modified applied migration and never rewrites the stored checksum", () => {
    const tampered = [
      { version: "0005", filename: "0005_incident_rooms.sql", checksum: "f".repeat(64) },
    ];
    const { conflicts, pending } = diffMigrations(migrations, [
      ...rowsFor(["0001", "0002", "0003", "0004"]),
      ...tampered,
    ]);
    expect(conflicts.map((c) => c.version)).toEqual(["0005"]);
    expect(conflicts[0].filename).toBe("0005_incident_rooms.sql");
    // later migrations remain pending: the runner exits before applying them
    expect(pending.map((m) => m.version)).toContain("0006");
    expect(JSON.stringify(conflicts)).not.toContain("UPDATE");
    expect(ledgerSql).toContain("AIRS_LEDGER_IMMUTABLE");
    expect(ledgerSql).toContain("BEFORE UPDATE OR DELETE");
  });
});

describe("existing-database adoption", () => {
  const script = buildAdoptionScript(migrations, adoptSql);

  it("never replays migration SQL", () => {
    expect(script).not.toContain("CREATE TABLE airs.organizations");
    expect(script).not.toContain(">>> migration body");
    for (const m of migrations) expect(script).toContain(`record_applied('${m.version}'`);
    expect(script.match(/record_applied/g)).toHaveLength(migrations.length);
  });

  it("verifies before recording, inside one locked transaction", () => {
    expect(script.indexOf("ADOPT FAIL")).toBeLessThan(script.indexOf("record_applied"));
    expect(script).toContain("pg_advisory_xact_lock");
    expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("requires an empty or absent ledger", () => {
    expect(adoptSql).toContain("adoption is not required");
  });

  it("fails when a required object, role, function or policy is missing", () => {
    for (const needle of [
      "airs.organizations",
      "airs.incidents",
      "airs.observations",
      "airs.expire_incident_state",
      "airs_maintenance",
      "required table % is missing",
      "row-level security is not enabled on %",
      "row-level security is not FORCED on %",
      "no RLS policy exists on %",
      "required function % is missing",
      "required database role % is missing",
    ]) {
      expect(adoptSql).toContain(needle);
    }
  });

  it("fails on role-parity drift", () => {
    expect(adoptSql).toContain(
      "role parity mismatch (expected 10 roles / 56 permissions / 175 grants)",
    );
  });

  it("fails when the platform organization values are wrong", () => {
    expect(adoptSql).toContain("anconison-platform");
    expect(adoptSql).toContain("Anconison - AIRS Agent Platform");
    expect(adoptSql).toContain("org_kind = 'platform'");
    expect(adoptSql).toContain("platform_admin permission set has drifted");
    expect(adoptSql).toContain("platform_admin holds operational permissions");
  });

  it("keeps Albany organizations as agency tenants", () => {
    expect(adoptSql).toContain("Albany Police Department");
    expect(adoptSql).toContain("Albany County");
  });

  it("runs the full SQL assertion suite and role parity before adopting", () => {
    expect(VERIFICATION_FILES).toContain("db/tests/role_parity.sql");
    expect(VERIFICATION_FILES).toContain("db/tests/platform_org_name.sql");
    expect(VERIFICATION_FILES.length).toBeGreaterThanOrEqual(11);
  });

  it("never runs automatically: adoption needs an explicit flag", () => {
    expect(parseMigrateArgs([]).flags["adopt-existing"]).toBeUndefined();
    expect(parseMigrateArgs(["--adopt-existing"]).flags["adopt-existing"]).toBe(true);
  });

  it("a partially migrated database cannot be adopted", () => {
    // adoption verifies every table/function through 0012 before recording
    expect(adoptSql).toContain("this is not an existing AIRS Agent database");
    expect(adoptSql).toContain("airs.observations");
  });
});

describe("adoption verifier: existence and RLS are separate invariants", () => {
  const section = (start: string, end: string) => {
    const from = adoptSql.indexOf(start);
    const to = end ? adoptSql.indexOf(end) : adoptSql.length;
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return adoptSql.slice(from, to);
  };
  const requiredTables = section("-- 3. Required tables", "-- 4. Tenant/identity");
  const rlsRequired = section("-- 4. Tenant/identity", "-- 5. Exact platform organization");
  const CATALOGS = ["'airs.roles'", "'airs.permissions'", "'airs.role_permissions'"];

  it("keeps the global RBAC catalogs in required-table verification", () => {
    for (const t of CATALOGS) expect(requiredTables).toContain(t);
  });

  it("never subjects the global RBAC catalogs to RLS/policy verification", () => {
    for (const t of CATALOGS) expect(rlsRequired).not.toContain(t);
  });

  it("keeps tenant-scoped tables in the RLS-required set", () => {
    for (const t of [
      "'airs.organizations'",
      "'airs.users'",
      "'airs.memberships'",
      "'airs.incidents'",
      "'airs.observations'",
      "'airs.map_features'",
    ]) {
      expect(requiredTables).toContain(t);
      expect(rlsRequired).toContain(t);
    }
  });

  it("verifies ENABLE, FORCE and a policy for every RLS-required table", () => {
    expect(rlsRequired).toContain("c.relrowsecurity");
    expect(rlsRequired).toContain("c.relforcerowsecurity");
    expect(rlsRequired).toContain("no RLS policy exists on %");
    expect(requiredTables).not.toContain("relrowsecurity");
    expect(requiredTables).not.toContain("pg_policies");
  });

  it("never introduces a blanket 'all airs tables need RLS' rule", () => {
    expect(adoptSql).not.toMatch(/FROM pg_tables[\s\S]{0,200}relrowsecurity/);
    expect(adoptSql).not.toMatch(/schemaname\s*=\s*'airs'[\s\S]{0,200}relrowsecurity/);
    for (const t of [
      "'airs.disclosure_fields'",
      "'airs.disclosure_precisions'",
      "'airs.disclosure_profile_fields'",
      "'airs.geographic_precisions'",
      "'airs.observation_freshness_thresholds'",
      "'airs.resource_category_statuses'",
    ]) {
      expect(rlsRequired).not.toContain(t);
    }
  });

  it("treats seed-only Albany demo organizations as conditional, not mandatory", () => {
    expect(adoptSql).toContain("Albany Police Department");
    expect(adoptSql).toContain("org_kind <> 'agency'");
    expect(adoptSql).not.toContain("name = 'Albany County' AND org_kind = 'agency'");
  });
});

describe("ledger access model", () => {
  it("denies airs_app entirely and denies airs_maintenance any write", () => {
    expect(ledgerSql).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM PUBLIC");
    expect(ledgerSql).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_app");
    expect(ledgerSql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA airs_migrations FROM airs_app");
    expect(ledgerSql).toContain("REVOKE ALL ON SCHEMA airs_migrations FROM airs_maintenance");
    expect(ledgerSql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA airs_migrations FROM airs_maintenance",
    );
    expect(ledgerSql).not.toMatch(/GRANT[^\n]*airs_app/);
    expect(ledgerSql).not.toMatch(/GRANT[^\n]*airs_maintenance/);
  });

  it("keeps migration state outside the tenant schema and out of application traffic", () => {
    expect(LEDGER_TABLE).toBe("airs_migrations.applied_migrations");
    const appSources = filesUnder(join(REPO_ROOT, "src")).filter((path) =>
      readFileSync(path, "utf8").includes("airs_migrations"),
    );
    expect(appSources).toEqual([]);
  });
});

describe("dry run, status and execution paths", () => {
  it("dry run and status compose read-only SQL", () => {
    expect(buildLedgerReadScript()).toMatch(/^\s*SELECT/m);
    expect(buildLedgerReadScript()).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(buildLockProbeScript()).toContain("pg_try_advisory_xact_lock");
    expect(buildLockProbeScript()).toContain("ROLLBACK;");
    expect(buildLockProbeScript()).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it("local psql and the Docker fallback run byte-identical SQL", () => {
    const sql = buildMigrationScript(migrations[11]);
    const local = planExecution({ hasLocalPsql: true, dockerDbRunning: false, databaseUrl: URL_ });
    const docker = planExecution({ hasLocalPsql: false, dockerDbRunning: true });
    expect(local.mode).toBe("psql");
    expect(docker.mode).toBe("docker");
    expect(local.exec!(sql).stdin).toBe(docker.exec!(sql).stdin);
    expect(local.exec!(sql).args).toContain("ON_ERROR_STOP=1");
    expect(docker.exec!(sql).args.slice(0, 5)).toEqual(["compose", "exec", "-T", "db", "psql"]);
    expect(docker.exec!(sql).args).toContain("ON_ERROR_STOP=1");
  });

  it("fails safely when neither psql nor a running database is available", () => {
    const plan = planExecution({ hasLocalPsql: false, dockerDbRunning: false });
    expect(plan.mode).toBe("none");
    expect(plan.error).toBe(NO_PATH_ERROR);
    expect(plan.error).toMatch(/docker compose up -d db/);
    expect(plan.error).not.toMatch(/down -v/);
  });

  it("requires DATABASE_URL for the local psql path", () => {
    const plan = planExecution({ hasLocalPsql: true, dockerDbRunning: false });
    expect(plan.mode).toBe("none");
    expect(plan.error).toMatch(/DATABASE_URL/);
  });

  it("never leaks passwords or database URLs in printable output", () => {
    const message = redact(`connect failed for ${URL_} password=hunter2`);
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("localhost:5432/airs");
    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(/postgres:\/\/\S*:\S*@/);
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("--adopt-existing");
  });

  it("rejects unknown flags without touching the database", () => {
    const result = runCli(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown flag: --bogus");
    expect(parseMigrateArgs(["--lock-timeout-ms"]).error).toMatch(/requires a value/);
    expect(parseMigrateArgs(["oops"]).error).toMatch(/Unknown argument/);
  });
});
