#!/usr/bin/env node
// AIRS Agent - operator-only cumulative legacy-schema reconciliation.
//
//   npm run db:reconcile-legacy                              report only
//   npm run db:reconcile-legacy -- --confirm --backup-confirmed
//
// Never runs automatically, never runs from Docker initialization and never
// runs as part of `npm run db:migrate`. It is NOT a numbered migration.
//
// Order of operations (stops at the first failure, always):
//   1. explicit confirmation + backup attestation (execute mode only)
//   2. PostGIS availability and PostgreSQL major version
//   3. object-level probes against the canonical post-0012 schema
//   4. plan: only genuinely missing CURRENT objects; superseded objects never
//   5. re-probe, abort on any conflict
//   6. advisory-locked, transactional, idempotent reconciliation per unit
//   7. full SQL assertion suite (includes role parity 10/56/175)
//   8. reconciliation security verification (db/repair/reconcile_verify.sql)
//   9. platform organization + platform administrator verification
//  10. only then: create the ledger and adopt 0001-0012 with current checksums
//  11. migration status: expect zero pending, zero checksum conflicts
import { spawnSync } from "node:child_process";

import {
  DEFAULT_LOCK_TIMEOUT_MS,
  REPO_ROOT,
  loadMigrations,
  planExecution,
  redact,
} from "./lib/migrate-plan.mjs";
import { runSqlSuite } from "./lib/sql-suite.mjs";
import {
  POSTGIS_MISSING_ERROR,
  REQUIRED_DB_IMAGE,
  REQUIRED_PG_MAJOR,
  buildLegacyLedgerScript,
  buildPlatformVerificationScript,
  buildPostgisProbeScript,
  parsePostgisProbe,
} from "./lib/legacy-repair.mjs";
import {
  DEFAULT_ADMIN_EMAIL,
  RECONCILE_HELP_TEXT,
  buildObjectProbeScript,
  buildReconcileScript,
  buildReconcileVerifyScript,
  formatReconcileReport,
  parseObjectProbe,
  parseReconcileArgs,
  planReconciliation,
} from "./lib/reconcile-legacy.mjs";

function fail(message, code = 1) {
  console.error(redact(message));
  process.exit(code);
}

const { flags, error: argError } = parseReconcileArgs(process.argv.slice(2));
if (argError) fail(`${argError}\n\n${RECONCILE_HELP_TEXT}`, 2);
if (flags.help) {
  console.log(RECONCILE_HELP_TEXT);
  process.exit(0);
}
const lockTimeoutMs = flags["lock-timeout-ms"] || DEFAULT_LOCK_TIMEOUT_MS;
const adminEmail = flags["admin-email"] || DEFAULT_ADMIN_EMAIL;

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}
function dockerDbRunning() {
  const probe = spawnSync("docker", ["compose", "ps", "--status", "running", "--services"], { encoding: "utf8" });
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

function run(sql) {
  const step = execPlan.exec(sql);
  const result = spawnSync(step.command, step.args, { input: step.stdin, encoding: "utf8" });
  if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message) };
  return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

console.log("AIRS Agent cumulative legacy-schema reconciliation");
console.log(`  execution path: ${execPlan.mode === "psql" ? "local psql client" : "Docker Compose `db` service"}`);
console.log(`  required image: ${REQUIRED_DB_IMAGE}`);
console.log("");

// --- 1. PostGIS + server version -------------------------------------------
const gis = parsePostgisProbe(run(buildPostgisProbeScript()).stdout);
if (gis.serverMajor && gis.serverMajor !== REQUIRED_PG_MAJOR) {
  fail(`This database reports PostgreSQL ${gis.serverMajor}; the supported major version is ${REQUIRED_PG_MAJOR}. Nothing was changed.`, 7);
}
if (!gis.installed && !gis.available) fail(POSTGIS_MISSING_ERROR, 7);
console.log(`  postgis:        ${gis.installed ? "installed" : "available, not yet created"}`);
console.log("");

// --- 2. Object probes + report ----------------------------------------------
function probeAndPlan() {
  const probe = run(buildObjectProbeScript());
  if (!probe.ok) fail(`Could not probe the database state.\n${probe.stderr}`);
  return planReconciliation(parseObjectProbe(probe.stdout));
}

const plan = probeAndPlan();
console.log(formatReconcileReport(plan));
console.log("");

if (!flags.confirm) {
  console.log("Report only - nothing was changed. To execute:");
  console.log("  npm run db:reconcile-legacy -- --confirm --backup-confirmed");
  console.log("Take a backup first, for example:");
  console.log("  docker compose exec -T db pg_dump -U airs_owner -d airs > airs-backup.sql");
  process.exit(plan.safe ? 0 : 3);
}
if (!plan.safe) fail(`\n${plan.error}`, 3);
if (plan.units.length === 0) {
  console.log("Nothing to reconcile: every canonical object already exists.");
  console.log("");
  console.log("No object is recreated or replaced merely to reach the adoption step.");
  console.log("Finish with the verified adoption command instead:");
  console.log("  npm run db:migrate:adopt");
  console.log("  npm run db:migrate:status   (expect 12 applied, zero pending, zero conflicts)");
  process.exit(0);
}

// --- 3. Re-probe immediately before changing anything ------------------------
const confirmPlan = probeAndPlan();
if (!confirmPlan.safe) fail(`\n${confirmPlan.error}`, 3);
if (JSON.stringify(confirmPlan.units) !== JSON.stringify(plan.units)) {
  fail("The database changed between the report and the execution. Nothing was changed. Re-run the report.", 3);
}

// --- 4. Apply the reconciliation units --------------------------------------
const migrations = loadMigrations();
const reconciledVersions = [];
for (const unit of confirmPlan.units) {
  const migration = migrations.find((m) => m.version === unit.version);
  if (!migration) fail(`Canonical migration ${unit.version} is missing from the manifest. Nothing was changed.`);
  console.log(`Reconciling ${unit.version} (${unit.objects.length} missing object(s), idempotent, one transaction)...`);
  const result = run(buildReconcileScript(migration, { lockTimeoutMs }));
  if (!result.ok) {
    if (/lock_timeout|canceling statement due to lock timeout/i.test(result.stderr)) {
      fail(`Another migration process holds the advisory lock (waited ${lockTimeoutMs} ms). Nothing was applied.`, 6);
    }
    fail(
      [
        `Reconciliation of ${unit.version} failed and was rolled back in full.`,
        "No ledger was created and no adoption state exists.",
        "",
        result.stderr.trim(),
      ].join("\n"),
      1,
    );
  }
  reconciledVersions.push(unit.version);
  console.log(`  -> ${unit.version} reconciled and committed.`);
}

// --- 5. Verification: SQL suite, role parity, security, platform -------------
console.log("");
console.log("Running the full SQL assertion suite and role parity before recording anything...");
const suite = runSqlSuite({ run, root: REPO_ROOT, onFile: (file) => console.log(`  ok  ${file}`) });
if (!suite.ok) {
  fail(`Reconciliation aborted: verification failed (${suite.failedFile}). No ledger was created.\n${suite.stderr}`, 4);
}
const security = run(buildReconcileVerifyScript());
if (!security.ok) fail(`Reconciliation aborted: security verification failed. No ledger was created.\n${security.stderr}`, 4);
console.log("  ok  db/repair/reconcile_verify.sql");

const platform = run(buildPlatformVerificationScript(adminEmail));
if (!platform.ok) fail(`Reconciliation aborted: platform verification failed. No ledger was created.\n${platform.stderr}`, 4);
console.log("  ok  platform organization and platform administrator");

// --- 6. Post-probe: the canonical schema must now be complete ----------------
const finalPlan = probeAndPlan();
if (finalPlan.missing.length) {
  fail(
    ["Reconciliation aborted: canonical objects are still missing after reconciliation.",
      ...finalPlan.missing.map((m) => `  ${m.id} (${m.version})`),
      "", "No ledger was created."].join("\n"),
    4,
  );
}

// --- 7. Ledger, last ----------------------------------------------------------
const ledger = run(
  buildLegacyLedgerScript(migrations, {
    lockTimeoutMs,
    appliedVersions: reconciledVersions,
    runnerVersion: "reconcile-legacy",
    appRelease: process.env.AIRS_APP_RELEASE ?? null,
  }),
);
if (!ledger.ok) fail(`Reconciliation aborted while creating the migration ledger. Nothing was recorded.\n${ledger.stderr}`, 4);

console.log("");
console.log(`Reconciliation complete. Reconciled: ${reconciledVersions.join(", ") || "none"}.`);
console.log(`Ledger created and ${migrations.length} migrations recorded (0001-${migrations.at(-1).version}).`);
console.log("Next: npm run db:migrate:status   (expect zero pending, zero checksum conflicts)");
