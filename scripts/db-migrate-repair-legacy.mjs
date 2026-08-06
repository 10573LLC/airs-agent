#!/usr/bin/env node
// AIRS Agent - explicit, operator-only repair of a legacy (pre-ledger) database.
//
//   npm run db:migrate:repair-legacy                        report only
//   npm run db:migrate:repair-legacy -- --confirm --backup-confirmed
//
// This command NEVER runs automatically and never runs as part of
// `npm run db:migrate`, application startup or Docker initialization.
//
// Order of operations (stops at the first failure, always):
//   1. explicit confirmation + backup attestation
//   2. PostGIS availability (hard requirement, actionable error otherwise)
//   3. concrete per-migration state probes -> present / missing / partial
//   4. advisory-locked, transactional execution of ONLY the missing migrations
//   5. full SQL assertion suite
//   6. role parity
//   7. platform organization + platform administrator verification
//   8. only then: create the ledger and record 0001-0012 with current checksums
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_LOCK_TIMEOUT_MS,
  REPO_ROOT,
  VERIFICATION_FILES,
  buildVerificationScript,
  loadMigrations,
  planExecution,
  redact,
} from "./lib/migrate-plan.mjs";
import {
  DEFAULT_ADMIN_EMAIL,
  POSTGIS_MISSING_ERROR,
  REPAIRABLE_VERSIONS,
  REPAIR_HELP_TEXT,
  REQUIRED_DB_IMAGE,
  REQUIRED_PG_MAJOR,
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
} from "./lib/legacy-repair.mjs";

function fail(message, code = 1) {
  console.error(redact(message));
  process.exit(code);
}

const { flags, error: argError } = parseRepairArgs(process.argv.slice(2));
if (argError) fail(`${argError}\n\n${REPAIR_HELP_TEXT}`, 2);
if (flags.help) {
  console.log(REPAIR_HELP_TEXT);
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
const pathLabel = execPlan.mode === "psql" ? "local psql client" : "Docker Compose `db` service";

function run(sql) {
  const step = execPlan.exec(sql);
  const result = spawnSync(step.command, step.args, { input: step.stdin, encoding: "utf8" });
  if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message) };
  return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

console.log("AIRS Agent legacy database repair");
console.log(`  execution path: ${pathLabel}`);
console.log(`  required image: ${REQUIRED_DB_IMAGE}`);

// --- 1. PostGIS availability ------------------------------------------------
const gis = parsePostgisProbe(run(buildPostgisProbeScript()).stdout);
if (gis.serverMajor && gis.serverMajor !== REQUIRED_PG_MAJOR) {
  fail(`This database reports PostgreSQL ${gis.serverMajor}; the supported major version is ${REQUIRED_PG_MAJOR}. Nothing was changed.`, 7);
}
if (!gis.installed && !gis.available) fail(POSTGIS_MISSING_ERROR, 7);
console.log(`  postgis:        ${gis.installed ? "installed" : "available, not yet created"}`);

// --- 2. State probes --------------------------------------------------------
const migrations = loadMigrations();
const probe = run(buildStateProbeScript());
if (!probe.ok) fail(`Could not probe the database state.\n${probe.stderr}`);
const state = classifyState(parseProbeOutput(probe.stdout));

console.log("");
console.log("Detected migration state (concrete schema probes, not a prefix assumption):");
for (const s of state) {
  const detail = s.status === "present" ? "already represented by the database" : s.failed.join(", ");
  console.log(`  ${s.version}: ${s.status.padEnd(7)} ${detail}`);
}

const plan = planRepair(state, migrations);
if (plan.error) fail(`\n${plan.error}`, 8);

console.log("");
console.log(`Missing and repairable: ${plan.apply.map((m) => m.version).join(", ") || "none"}`);
console.log(`Never replayed:         ${plan.present.join(", ") || "none"}`);

if (!flags.confirm) {
  console.log("");
  console.log("Report only - nothing was changed. Re-run with:");
  console.log("  npm run db:migrate:repair-legacy -- --confirm --backup-confirmed");
  console.log("Take a backup first, for example:");
  console.log("  docker compose exec -T db pg_dump -U airs_owner -d airs > airs-backup.sql");
  process.exit(0);
}

// --- 3. Apply only the missing migrations -----------------------------------
if (!gis.installed) {
  const created = run("\\set ON_ERROR_STOP on\nCREATE EXTENSION IF NOT EXISTS postgis;\n");
  if (!created.ok) fail(`${POSTGIS_MISSING_ERROR}\n\n${created.stderr}`, 7);
  console.log("Created the PostGIS extension.");
}

const appliedVersions = [];
for (const migration of plan.apply) {
  console.log(`Applying missing migration ${migration.version} (${migration.filename})...`);
  const result = run(buildLegacyMigrationScript(migration, { lockTimeoutMs }));
  if (!result.ok) {
    if (/lock_timeout|canceling statement due to lock timeout/i.test(result.stderr)) {
      fail(`Another migration process holds the advisory lock (waited ${lockTimeoutMs} ms). Nothing was applied.`, 6);
    }
    fail(
      [
        `Migration ${migration.version} failed and was rolled back in full.`,
        "No ledger was created and no ledger entry exists for it.",
        "",
        result.stderr.trim(),
      ].join("\n"),
      1,
    );
  }
  appliedVersions.push(migration.version);
  console.log(`  -> ${migration.version} applied and committed.`);
}

// --- 4. Verification: SQL suite, role parity, platform administrator --------
console.log("");
console.log("Running the full SQL assertion suite and role parity before recording anything...");
for (const file of VERIFICATION_FILES) {
  const sqlText = readFileSync(join(REPO_ROOT, file), "utf8");
  const result = run(buildVerificationScript(sqlText));
  if (!result.ok) fail(`Repair aborted: verification failed (${file}). No ledger was created.\n${result.stderr}`, 4);
  console.log(`  ok  ${file}`);
}
const platform = run(buildPlatformVerificationScript(adminEmail));
if (!platform.ok) fail(`Repair aborted: platform verification failed. No ledger was created.\n${platform.stderr}`, 4);
console.log("  ok  platform organization and platform administrator");

// --- 5. Ledger, last ---------------------------------------------------------
const ledger = run(
  buildLegacyLedgerScript(migrations, {
    lockTimeoutMs,
    appliedVersions,
    appRelease: process.env.AIRS_APP_RELEASE ?? null,
  }),
);
if (!ledger.ok) fail(`Repair aborted while creating the migration ledger. Nothing was recorded.\n${ledger.stderr}`, 4);

console.log("");
console.log(`Repair complete. Applied: ${appliedVersions.join(", ") || "none"} (only ${REPAIRABLE_VERSIONS.join("/")} are ever applied by repair).`);
console.log(`Ledger created and ${migrations.length} migrations recorded (0001-${migrations.at(-1).version}).`);
console.log("Next: npm run db:migrate:status   (expect zero pending)");
