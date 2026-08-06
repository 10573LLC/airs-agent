#!/usr/bin/env node
// Portable migration runner (Windows PowerShell, Linux, macOS).
//   npm run db:migrate
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { planMigration, redact } from "./lib/migrate-plan.mjs";

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}

function dockerDbRunning() {
  const probe = spawnSync("docker", ["compose", "ps", "--status", "running", "--services"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return false;
  return String(probe.stdout)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .includes("db");
}

const hasLocalPsql = commandExists("psql");
const plan = planMigration({
  hasLocalPsql,
  dockerDbRunning: hasLocalPsql ? false : dockerDbRunning(),
  databaseUrl: process.env.DATABASE_URL,
});

if (plan.mode === "none") {
  console.error(redact(plan.error));
  process.exit(1);
}

console.log(
  plan.mode === "psql"
    ? "Applying migrations with the local psql client."
    : "Local psql not found — applying migrations through the running Docker Compose `db` service.",
);

for (const step of plan.steps) {
  console.log(`  -> ${step.file}`);
  const result = spawnSync(step.command, step.args, {
    input: step.stdinFile ? readFileSync(step.stdinFile) : undefined,
    stdio: step.stdinFile ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  if (result.error) {
    console.error(redact(`Migration failed to start: ${result.error.message}`));
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(redact(`Migration failed (${step.file}) with exit code ${result.status}.`));
    process.exit(result.status || 1);
  }
}

console.log("All migrations applied.");
