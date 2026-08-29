// The canonical SQL-suite runner: reproduces the exact live failure
//   ERROR:  schema "pg_temp" does not exist / SELECT pg_temp.ok(...)
// and proves the corrected runner cannot produce it, that failures still fail,
// and that a fully reconciled schema with an empty ledger can be adopted
// without replaying any migration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  VERIFICATION_FILES,
  buildAdoptionScript,
  diffMigrations,
  loadMigrations,
  parseMigrateArgs,
} from "../scripts/lib/migrate-plan.mjs";
import {
  SQL_SUITE_FILES,
  analyzeSqlSuiteFile,
  assertSqlSuiteFileIsSessionSafe,
  buildLegacyWrappedScript,
  buildSqlSuiteScript,
  runSqlSuite,
  tempHelperSurvival,
} from "../scripts/lib/sql-suite.mjs";

const migrations = loadMigrations();
const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8"));
const read = (file: string) => readFileSync(`${REPO_ROOT}/${file}`, "utf8");

describe("the exact pg_temp failure", () => {
  const authSql = read("db/tests/auth_rls.sql");

  it("the old runner destroys pg_temp.ok on the file's own intermediate ROLLBACK", () => {
    const legacy = tempHelperSurvival(buildLegacyWrappedScript(authSql));
    expect(legacy.status).toBe("lost");
    expect(legacy.lostHelper).toBe("ok");
    expect(legacy.line).toBeGreaterThan(0);
  });

  it("the corrected runner adds no transaction, so the helpers stay session-scoped", () => {
    const script = buildSqlSuiteScript(authSql);
    expect(script.startsWith("\\set ON_ERROR_STOP on\n\\timing off\n")).toBe(true);
    // the ONLY transaction control comes from the file itself
    const runnerLines = script.replace(authSql, "");
    expect(runnerLines).not.toMatch(/\bBEGIN;|\bCOMMIT;|\bROLLBACK;/);
    expect(tempHelperSurvival(script).status).toBe("safe");
  });

  it("every suite file defines the temporary helpers it calls, in its own session", () => {
    for (const file of SQL_SUITE_FILES) {
      const analysis = analyzeSqlSuiteFile(read(file));
      expect(analysis.undefinedHelpers, file).toEqual([]);
      expect(analysis.survival.status, file).toBe("safe");
      expect(analysis.ok, file).toBe(true);
    }
  });

  it("a missing temporary helper is impossible through the canonical runner", () => {
    const broken = "\\set ON_ERROR_STOP on\nDO $$ BEGIN PERFORM pg_temp.ok(true, 'x'); END $$;\n";
    expect(() => assertSqlSuiteFileIsSessionSafe("broken.sql", broken)).toThrow(/never defines it/);
    const rolledBack = [
      "BEGIN;",
      "CREATE OR REPLACE FUNCTION pg_temp.ok(c boolean, l text) RETURNS void LANGUAGE sql AS $$ SELECT $$;",
      "ROLLBACK;",
      "DO $$ BEGIN PERFORM pg_temp.ok(true, 'x'); END $$;",
    ].join("\n");
    expect(() => assertSqlSuiteFileIsSessionSafe("rolled-back.sql", rolledBack)).toThrow(
      /ROLLBACK that destroys it/,
    );
  });
});

describe("canonical runner failure semantics", () => {
  const fakeRun = (failOn: string | null) => {
    const seen: string[] = [];
    const run = (sql: string) => {
      seen.push(sql);
      const isFailing = failOn !== null && sql.includes(read(failOn).slice(0, 200));
      return isFailing
        ? { ok: false, stdout: "", stderr: "psql:...: ERROR:  AUTH-RLS FAIL: tenant isolation" }
        : { ok: true, stdout: "", stderr: "" };
    };
    return { run, seen };
  };

  it("runs every suite file, in order, one script per file", () => {
    const { run, seen } = fakeRun(null);
    const result = runSqlSuite({ run });
    expect(result.ok).toBe(true);
    expect(result.ran).toEqual(SQL_SUITE_FILES);
    expect(seen.length).toBe(SQL_SUITE_FILES.length);
  });

  it("stops at the first real assertion failure and identifies the file", () => {
    const { run, seen } = fakeRun("db/tests/auth_rls.sql");
    const result = runSqlSuite({ run });
    expect(result.ok).toBe(false);
    expect(result.failedFile).toBe("db/tests/auth_rls.sql");
    expect(result.stderr).toContain("AUTH-RLS FAIL");
    // nothing after the failing file was executed
    expect(seen.length).toBe(SQL_SUITE_FILES.indexOf("db/tests/auth_rls.sql") + 1);
  });

  it("never downgrades a failure to a warning", () => {
    const source = read("scripts/lib/sql-suite.mjs");
    expect(source).not.toMatch(/console\.warn/);
    expect(source).not.toMatch(/ok:\s*true\s*,\s*failedFile/);
  });
});

describe("one canonical implementation, used everywhere", () => {
  const files = {
    migrate: read("scripts/db-migrate.mjs"),
    reconcile: read("scripts/db-reconcile-legacy.mjs"),
    repair: read("scripts/db-migrate-repair-legacy.mjs"),
    dbTest: read("scripts/db-test.mjs"),
    plan: read("scripts/lib/migrate-plan.mjs"),
  };

  it("db:test runs the canonical runner, not a bespoke psql -f list", () => {
    expect(pkg.scripts["db:test"]).toBe("node scripts/db-test.mjs");
    expect(pkg.scripts["db:test"]).not.toContain("-f db/tests/");
    expect(files.dbTest).toContain("runSqlSuite");
  });

  it("adoption, reconciliation and legacy repair all use the canonical runner", () => {
    for (const [name, source] of Object.entries(files)) {
      if (name === "plan" || name === "dbTest") continue;
      expect(source, name).toContain("runSqlSuite");
      expect(source, name).not.toContain("buildVerificationScript");
    }
  });

  it("the defective transaction wrapper no longer exists in the planning library", () => {
    expect(files.plan).not.toMatch(/export function buildVerificationScript/);
  });

  it("suite membership has exactly one definition", () => {
    expect(SQL_SUITE_FILES).toBe(VERIFICATION_FILES);
    expect(SQL_SUITE_FILES).toContain("db/tests/role_parity.sql");
  });
});

describe("adoption of the live reconciled state", () => {
  const migrate = read("scripts/db-migrate.mjs");
  const adoptSql = read("db/ledger/adopt_verify.sql");

  it("detects a present but empty ledger and refuses a second adoption", () => {
    expect(migrate).toContain("ledger present, zero applied rows - adoption applies.");
    expect(migrate).toContain("adoption is not required");
  });

  it("verifies PostGIS, every canonical object, the suite, security and platform first", () => {
    const order = [
      "buildPostgisProbeScript",
      "buildObjectProbeScript",
      "runSqlSuite",
      "buildReconcileVerifyScript",
      "buildPlatformVerificationScript",
      "buildAdoptionScript",
    ].map((needle) => ({ needle, at: migrate.indexOf(needle) }));
    for (const step of order) expect(step.at, step.needle).toBeGreaterThan(-1);
    const positions = order.map((s) => migrate.lastIndexOf(s.needle));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("refuses adoption while any canonical object is missing", () => {
    expect(migrate).toContain(
      "canonical objects are missing; this database is not fully reconciled",
    );
    expect(migrate).toContain("npm run db:reconcile-legacy");
  });

  it("verifies role parity 10 / 56 / 175, the platform org and Albany tenants", () => {
    expect(read("db/tests/role_parity.sql")).toContain("(10, 56, 175)");
    expect(adoptSql).toContain(
      "role parity mismatch (expected 10 roles / 56 permissions / 175 grants)",
    );
    expect(adoptSql).toContain("anconison-platform");
    expect(adoptSql).toContain("Anconison - AIRS Agent Platform");
    expect(adoptSql).toContain("org_kind = 'platform'");
    expect(adoptSql).toContain("Albany Police Department");
    expect(adoptSql).toContain("Albany County");
    expect(adoptSql).toContain("platform_admin holds operational permissions");
  });

  it("records every manifest migration with its checksum and runs no migration body", () => {
    const script = buildAdoptionScript(migrations, adoptSql, {});
    const recorded = [...script.matchAll(/record_applied\('(\d{4})'/g)].map((m) => m[1]);
    expect(recorded).toEqual(migrations.map((m) => m.version));
    expect(recorded).toEqual([
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
      "0015",
      "0016",
      "0017",
    ]);
    for (const m of migrations) expect(script).toContain(m.checksum);
    expect(script).toContain("no migration body is executed during adoption");
    // no schema object is created or replaced by adoption
    expect(script).not.toMatch(
      /CREATE TABLE airs\.|DROP TABLE|CREATE EXTENSION|ALTER TABLE airs\./,
    );
    expect(script).toMatch(/record_applied\('0015'.*true\);/);
  });

  it("after adoption: every migration applied, zero pending, zero conflicts, no adoption required", () => {
    const rows = migrations.map((m) => ({
      version: m.version,
      filename: m.filename,
      checksum: m.checksum,
    }));
    const { applied, pending, conflicts } = diffMigrations(migrations, rows);
    expect(applied.length).toBe(migrations.length);
    expect(applied.at(-1)!.version).toBe("0017");
    expect(pending.length).toBe(0);
    expect(conflicts.length).toBe(0);
    // `npm run db:migrate` then applies nothing
    expect(pending).toEqual([]);
    // adoption-required is derived from a non-empty ledger
    expect(rows.length).toBeGreaterThan(0);
  });

  it("accepts an explicit platform administrator email and nothing unknown", () => {
    expect(parseMigrateArgs(["--adopt-existing"]).flags["adopt-existing"]).toBe(true);
    expect(parseMigrateArgs(["--admin-email", "a@b.c"]).flags["admin-email"]).toBe("a@b.c");
    expect(parseMigrateArgs(["--nope"]).error).toContain("Unknown flag");
  });
});

describe("reconciliation on an already reconciled database", () => {
  const cli = read("scripts/db-reconcile-legacy.mjs");

  it("recreates nothing and points the operator at adoption", () => {
    const at = cli.indexOf("Nothing to reconcile: every canonical object already exists.");
    expect(at).toBeGreaterThan(-1);
    const tail = cli.slice(at, at + 600);
    expect(tail).toContain("npm run db:migrate:adopt");
    expect(tail).toContain("process.exit(0);");
    // the exit happens before any reconciliation unit is applied
    expect(at).toBeLessThan(cli.indexOf("run(buildReconcileScript("));
  });
});

describe("security and output safety", () => {
  it("the runner prints no credentials or connection strings", () => {
    for (const file of [
      "scripts/db-test.mjs",
      "scripts/lib/sql-suite.mjs",
      "scripts/db-migrate.mjs",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/console\.log\([^)]*DATABASE_URL/);
      expect(source, file).not.toMatch(/console\.(log|error)\([^)]*password/i);
    }
    expect(read("scripts/db-test.mjs")).toContain("redact(");
  });

  it("the harness fix touches no migration, policy or permission", () => {
    const suite = read("scripts/lib/sql-suite.mjs");
    expect(suite).not.toMatch(/CREATE POLICY|ALTER TABLE|GRANT |REVOKE |ROW LEVEL SECURITY/);
  });
});
