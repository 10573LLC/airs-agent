#!/usr/bin/env node
// Portable, ledger-backed migration runner (Windows PowerShell, Linux, macOS).
//
//   npm run db:migrate                 apply pending migrations only
//   npm run db:migrate -- --dry-run    report only, changes nothing
//   npm run db:migrate:status          ledger / conflict / lock status
//   npm run db:migrate:adopt           adopt a verified existing database
//
// Migration state lives in airs_migrations.applied_migrations. Nothing is ever
// re-applied, nothing is applied without recording it, and an "already exists"
// SQL error is never treated as success.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ADOPT_VERIFY_FILE,
  DEFAULT_LOCK_TIMEOUT_MS,
  MARKER_ALREADY_APPLIED,
  MARKER_CHECKSUM_MISMATCH,
  MIGRATE_HELP_TEXT,
  REPO_ROOT,
  RUNNER_VERSION,
  buildAdoptionScript,
  buildLedgerBootstrapScript,
  buildLedgerReadScript,
  buildLockProbeScript,
  buildMigrationScript,
  diffMigrations,
  loadMigrations,
  parseMigrateArgs,
  planExecution,
  redact,
} from "./lib/migrate-plan.mjs";
import { runSqlSuite } from "./lib/sql-suite.mjs";
import {
  POSTGIS_MISSING_ERROR,
  buildPlatformVerificationScript,
  buildPostgisProbeScript,
  parsePostgisProbe,
} from "./lib/legacy-repair.mjs";
import {
  DEFAULT_ADMIN_EMAIL,
  buildObjectProbeScript,
  buildReconcileVerifyScript,
  parseObjectProbe,
  planReconciliation,
} from "./lib/reconcile-legacy.mjs";

function fail(message, code = 1) {
  console.error(redact(message));
  process.exit(code);
}

const { flags, error: argError } = parseMigrateArgs(process.argv.slice(2));
if (argError) fail(`${argError}\n\n${MIGRATE_HELP_TEXT}`, 2);
if (flags.help) {
  console.log(MIGRATE_HELP_TEXT);
  process.exit(0);
}
const lockTimeoutMs = flags["lock-timeout-ms"] || DEFAULT_LOCK_TIMEOUT_MS;

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}

function dockerDbRunning() {
  const probe = spawnSync("docker", ["compose", "ps", "--status", "running", "--services"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return false;
  return String(probe.stdout).split(/\r?\n/).map((s) => s.trim()).includes("db");
}

const hasLocalPsql = commandExists("psql");
const execPlan = planExecution({
  hasLocalPsql,
  dockerDbRunning: hasLocalPsql ? false : dockerDbRunning(),
  databaseUrl: process.env.DATABASE_URL,
});
if (execPlan.mode === "none") fail(execPlan.error);

const pathLabel = execPlan.mode === "psql" ? "local psql client" : "Docker Compose `db` service";

/** Runs one SQL script through the chosen path. Never echoes credentials. */
function run(sql, { capture = false } = {}) {
  const step = execPlan.exec(sql);
  const result = spawnSync(step.command, step.args, {
    input: step.stdin,
    encoding: "utf8",
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "pipe"],
  });
  if (result.error) return { ok: false, status: -1, stdout: "", stderr: String(result.error.message) };
  const stderr = String(result.stderr ?? "");
  if (!capture && stderr) process.stderr.write(redact(stderr));
  return { ok: result.status === 0, status: result.status ?? 1, stdout: String(result.stdout ?? ""), stderr };
}

function ensureLedger() {
  const result = run(buildLedgerBootstrapScript(), { capture: true });
  if (!result.ok) fail(`Could not create or verify the migration ledger.\n${result.stderr}`);
}

function readLedger() {
  const result = run(buildLedgerReadScript(), { capture: true });
  if (!result.ok) fail(`Could not read the migration ledger.\n${result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [version, filename, checksum, appliedAt] = line.split("|");
      return { version, filename, checksum, appliedAt };
    });
}

function lockState() {
  const result = run(buildLockProbeScript(), { capture: true });
  if (!result.ok) return "unknown";
  return result.stdout.includes("held") ? "held by another migration process" : "free";
}

function reportConflicts(conflicts) {
  console.error("");
  console.error("Migration checksum conflict - previously applied migrations are immutable.");
  for (const c of conflicts) {
    console.error(`  ${c.version}  ${c.filename}: the file no longer matches the recorded checksum.`);
  }
  console.error("");
  console.error("Nothing was applied. Restore the original migration file, or add a new");
  console.error("forward migration. Do not edit recorded checksums.");
  process.exit(3);
}

const migrations = loadMigrations();

// --- status ---------------------------------------------------------------
if (flags.status) {
  const probe = run("\\set ON_ERROR_STOP on\n\\pset tuples_only on\n\\pset format unaligned\nSELECT to_regclass('airs_migrations.applied_migrations') IS NOT NULL;\n", { capture: true });
  const ledgerPresent = probe.ok && probe.stdout.trim().startsWith("t");
  const rows = ledgerPresent ? readLedger() : [];
  const { applied, pending, conflicts } = diffMigrations(migrations, rows);
  const highest = applied.length ? applied.at(-1).version : "none";
  console.log("AIRS Agent migration status");
  console.log(`  execution path:        ${pathLabel}`);
  console.log(`  migration ledger:      ${ledgerPresent ? "present" : "absent"}`);
  console.log(`  applied migrations:    ${applied.length}`);
  console.log(`  highest applied:       ${highest}`);
  console.log(`  pending migrations:    ${pending.length}${pending.length ? ` (${pending.map((m) => m.version).join(", ")})` : ""}`);
  console.log(`  checksum conflicts:    ${conflicts.length}${conflicts.length ? ` (${conflicts.map((c) => c.version).join(", ")})` : ""}`);
  console.log(`  adoption required:     ${!ledgerPresent || rows.length === 0 ? "yes, if this is an existing AIRS Agent database (npm run db:migrate:adopt)" : "no"}`);
  console.log(`  advisory lock:         ${ledgerPresent ? lockState() : "not probed"}`);
  process.exit(conflicts.length ? 3 : 0);
}

// --- adoption -------------------------------------------------------------
if (flags["adopt-existing"]) {
  console.log(`Adoption requested. Execution path: ${pathLabel}.`);
  ensureLedger();
  const rows = readLedger();
  if (rows.length > 0) {
    fail(`The migration ledger already contains ${rows.length} row(s); adoption is not required.`, 4);
  }
  console.log("  ledger present, zero applied rows - adoption applies.");

  // 1. PostGIS must really be installed before geospatial assertions run.
  const gis = parsePostgisProbe(run(buildPostgisProbeScript(), { capture: true }).stdout);
  if (!gis.installed) fail(`Adoption aborted: PostGIS is not installed in this database.\n${POSTGIS_MISSING_ERROR}`, 7);
  console.log("  ok  postgis installed");

  // 2. Every canonical post-0012 object must already exist. Adoption never
  //    creates, replaces or replays schema.
  const probe = run(buildObjectProbeScript(), { capture: true });
  if (!probe.ok) fail(`Adoption aborted: could not probe the canonical schema.\n${probe.stderr}`, 4);
  const canonical = planReconciliation(parseObjectProbe(probe.stdout));
  if (canonical.missing.length) {
    fail(
      ["Adoption aborted: canonical objects are missing; this database is not fully reconciled.",
        ...canonical.missing.map((m) => `  ${m.id} (${m.version})`),
        "", "Run `npm run db:reconcile-legacy` first. Nothing was recorded."].join("\n"),
      4,
    );
  }
  console.log("  ok  every canonical object present");

  // 3. The full SQL suite (includes role parity 10 roles / 56 permissions /
  //    175 grants) through the ONE canonical runner.
  console.log("Running the SQL assertion suite and role parity before recording anything...");
  const suite = runSqlSuite({ run: (sql) => run(sql, { capture: true }), root: REPO_ROOT, onFile: (file) => console.log(`  ok  ${file}`) });
  if (!suite.ok) fail(`Adoption aborted: verification suite failed (${suite.failedFile}). Nothing was recorded.\n${suite.stderr}`, 4);

  // 4. Security, tenancy and platform verification.
  const security = run(buildReconcileVerifyScript(), { capture: true });
  if (!security.ok) fail(`Adoption aborted: security verification failed. Nothing was recorded.\n${security.stderr}`, 4);
  console.log("  ok  db/repair/reconcile_verify.sql");
  const adminEmail = flags["admin-email"] || DEFAULT_ADMIN_EMAIL;
  const platform = run(buildPlatformVerificationScript(adminEmail), { capture: true });
  if (!platform.ok) fail(`Adoption aborted: platform verification failed. Nothing was recorded.\n${platform.stderr}`, 4);
  console.log("  ok  platform organization and platform administrator");

  // 5. Record 0001-0012 with their current checksums. No migration body runs.
  const verifySql = readFileSync(join(REPO_ROOT, ADOPT_VERIFY_FILE), "utf8");
  const script = buildAdoptionScript(migrations, verifySql, {
    lockTimeoutMs,
    runnerVersion: RUNNER_VERSION,
    appRelease: process.env.AIRS_APP_RELEASE ?? null,
  });
  const result = run(script, { capture: true });
  if (!result.ok) fail(`Adoption aborted: schema verification failed. Nothing was recorded.\n${result.stderr}`, 4);
  console.log("");
  console.log("Adopted the existing database. Migrations recorded WITHOUT being executed:");
  for (const m of migrations) console.log(`  ${m.version}  ${m.filename}  sha256:${m.checksum.slice(0, 12)}...`);
  console.log(`Total: ${migrations.length} migrations. Run \`npm run db:migrate\` to confirm zero pending.`);
  process.exit(0);
}

// --- dry run and apply ------------------------------------------------------
ensureLedger();
const rows = readLedger();
const { applied, pending, conflicts } = diffMigrations(migrations, rows);

if (flags["dry-run"]) {
  console.log("Dry run - no database changes will be made.");
  console.log(`  execution path: ${pathLabel}`);
  console.log(`  applied (${applied.length}): ${applied.map((m) => m.version).join(", ") || "none"}`);
  console.log(`  pending (${pending.length}): ${pending.map((m) => m.version).join(", ") || "none"}`);
  console.log(`  checksum conflicts (${conflicts.length}): ${conflicts.map((c) => c.version).join(", ") || "none"}`);
  process.exit(conflicts.length ? 3 : 0);
}

if (conflicts.length) reportConflicts(conflicts);

if (rows.length === 0 && applied.length === 0) {
  const probe = run("\\set ON_ERROR_STOP on\n\\pset tuples_only on\n\\pset format unaligned\nSELECT to_regclass('airs.organizations') IS NOT NULL;\n", { capture: true });
  if (probe.ok && probe.stdout.trim().startsWith("t")) {
    fail(
      [
        "This database already contains AIRS Agent objects but has no migration ledger.",
        "Refusing to replay migrations 0001+ (that is exactly the failure this runner exists to prevent).",
        "",
        "Run the explicit, verified adoption command once:",
        "  npm run db:migrate:adopt",
        "",
        "Nothing was started, changed or removed.",
      ].join("\n"),
      5,
    );
  }
}

if (pending.length === 0) {
  console.log(`Zero pending migrations. ${applied.length} already applied (execution path: ${pathLabel}).`);
  process.exit(0);
}

console.log(`Applying ${pending.length} pending migration(s) via the ${pathLabel}.`);
for (const migration of pending) {
  const started = performance.now();
  const result = run(
    buildMigrationScript(migration, {
      lockTimeoutMs,
      runnerVersion: RUNNER_VERSION,
      appRelease: process.env.AIRS_APP_RELEASE ?? null,
    }),
    { capture: true },
  );
  const durationMs = Math.round(performance.now() - started);
  if (result.ok) {
    console.log(`  -> ${migration.version}  ${migration.filename}  (${durationMs} ms, recorded)`);
    continue;
  }
  if (result.stderr.includes(MARKER_ALREADY_APPLIED)) {
    console.log(`  -- ${migration.version} was applied by a concurrent runner; skipped, nothing changed.`);
    continue;
  }
  if (result.stderr.includes(MARKER_CHECKSUM_MISMATCH)) {
    reportConflicts([{ version: migration.version, filename: migration.filename }]);
  }
  if (/lock_timeout|canceling statement due to lock timeout/i.test(result.stderr)) {
    fail(
      `Migration already in progress: another runner holds the advisory lock (waited ${lockTimeoutMs} ms). Nothing was applied.`,
      6,
    );
  }
  fail(
    [
      `Migration ${migration.version} (${migration.filename}) failed and was rolled back.`,
      "No ledger entry was created and no later migration was executed.",
      "",
      result.stderr.trim(),
    ].join("\n"),
    1,
  );
}

console.log("All pending migrations applied and recorded.");
