#!/usr/bin/env node
// AIRS Agent - SQL assertion suite (npm run db:test).
//
// Uses the ONE canonical suite runner (scripts/lib/sql-suite.mjs), the same
// implementation reconciliation and migration adoption use. Each suite file
// runs in its own PostgreSQL session, exactly as
// `psql -v ON_ERROR_STOP=1 -f <file>` would run it: the files create their own
// session-scoped temporary assertion helpers and own their transactions.
//
// A failed assertion or any SQL error stops the run immediately and exits
// non-zero, naming the file that failed. Failures are never downgraded.
import { spawnSync } from "node:child_process";

import { planExecution, redact } from "./lib/migrate-plan.mjs";
import { SQL_SUITE_FILES, runSqlSuite } from "./lib/sql-suite.mjs";

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
const execPlan = planExecution({
  hasLocalPsql,
  dockerDbRunning: hasLocalPsql ? false : dockerDbRunning(),
  databaseUrl: process.env.DATABASE_URL,
});
if (execPlan.mode === "none") {
  console.error(redact(execPlan.error));
  process.exit(1);
}

function run(sql) {
  const step = execPlan.exec(sql);
  const result = spawnSync(step.command, step.args, { input: step.stdin, encoding: "utf8" });
  if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message) };
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

console.log(`AIRS Agent SQL assertion suite (${SQL_SUITE_FILES.length} files)`);
console.log(
  `  execution path: ${execPlan.mode === "psql" ? "local psql client" : "Docker Compose `db` service"}`,
);

const suite = runSqlSuite({ run, onFile: (file) => console.log(`  ok  ${file}`) });
if (!suite.ok) {
  console.error(redact(`\nFAILED: ${suite.failedFile}\n${suite.stderr.trim()}`));
  process.exit(1);
}
console.log(`All ${suite.ran.length} SQL suite files passed.`);
