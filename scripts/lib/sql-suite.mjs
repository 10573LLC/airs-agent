// AIRS Agent - the ONE canonical SQL verification-suite runner.
//
// Why this module exists
// ----------------------
// The SQL assertion suites in db/tests/*.sql are SESSION-scoped scripts. Each
// one creates its own temporary assertion helpers (`pg_temp.ok`,
// `pg_temp.denied`) OUTSIDE any transaction, on purpose, and then opens,
// commits and rolls back its own transactions while calling those helpers.
//
// PostgreSQL creates the per-session temporary schema lazily, inside the
// transaction that first needs it. If a helper is created inside a transaction
// that is later rolled back, the temporary schema goes away with it and every
// later call fails with:
//
//     ERROR:  schema "pg_temp" does not exist
//     SELECT pg_temp.ok(...)
//
// That is exactly what happened when the reconciliation / adoption runners
// wrapped whole test files in an extra `BEGIN; ... ROLLBACK;`: the file's own
// intermediate `ROLLBACK;` (db/tests/auth_rls.sql, section 2 -> section 3)
// aborted the wrapper transaction and destroyed the helpers the rest of the
// file depends on. `npm run db:test` never wrapped the files, so it passed -
// two subtly different ways of running the same SQL.
//
// The rule this module enforces: a suite file is executed byte-for-byte as
// `psql -v ON_ERROR_STOP=1 -f <file>` would execute it, in ONE session, with
// NO runner-supplied transaction around it. Files own their transactions.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, VERIFICATION_FILES } from "./migrate-plan.mjs";

/** The canonical suite. Identical for db:test, adoption and reconciliation. */
export const SQL_SUITE_FILES = VERIFICATION_FILES;

/**
 * Composes the canonical script for one suite file.
 * No BEGIN/COMMIT/ROLLBACK is added: the file is session-scoped and owns its
 * own transactions, including the temporary assertion helpers.
 */
export function buildSqlSuiteScript(sqlText) {
  return ["\\set ON_ERROR_STOP on", "\\timing off", sqlText, ""].join("\n");
}

/**
 * The historical, defective wrapper. Exported ONLY so the tests can prove the
 * old shape loses the temporary helpers. Never call it from a runner.
 * @deprecated
 */
export function buildLegacyWrappedScript(sqlText) {
  return `\\set ON_ERROR_STOP on\nBEGIN;\n${sqlText}\nROLLBACK;\n`;
}

const TX_LINE = /^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK|END)\s*;\s*$/i;
const HELPER_DEF = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+pg_temp\.(\w+)/gi;
const HELPER_USE = /pg_temp\.(\w+)\s*\(/gi;

/**
 * Statically simulates PostgreSQL temporary-schema lifetime over a COMPOSED
 * script and reports whether a `pg_temp.<helper>()` call can be reached with
 * the helper gone.
 *
 * Model (matches PostgreSQL):
 *   * temp objects created inside a transaction that ROLLBACKs disappear with
 *     it, together with the lazily created temporary schema;
 *   * temp objects created at session scope (outside any transaction) or in a
 *     committed transaction survive later rollbacks.
 *
 * @returns {{status:"safe"|"lost", lostHelper:string|null, line:number|null}}
 */
export function tempHelperSurvival(script) {
  const lines = String(script).split(/\r?\n/);
  /** helper name -> "session" | "uncommitted" */
  const helpers = new Map();
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const tx = TX_LINE.exec(line);
    if (tx) {
      const keyword = tx[1].toUpperCase();
      if (keyword === "BEGIN" || keyword === "START TRANSACTION") {
        // psql warns and ignores a nested BEGIN; depth never exceeds 1.
        depth = 1;
      } else if (keyword === "ROLLBACK") {
        for (const [name, scope] of [...helpers]) if (scope === "uncommitted") helpers.delete(name);
        depth = 0;
      } else {
        for (const [name, scope] of [...helpers]) if (scope === "uncommitted") helpers.set(name, "session");
        depth = 0;
      }
      continue;
    }
    for (const m of line.matchAll(HELPER_DEF)) {
      helpers.set(m[1], depth > 0 ? "uncommitted" : "session");
    }
    for (const m of line.matchAll(HELPER_USE)) {
      const name = m[1];
      if (!helpers.has(name)) return { status: "lost", lostHelper: name, line: i + 1 };
    }
  }
  return { status: "safe", lostHelper: null, line: null };
}

/**
 * Suite-file precondition: every temporary helper a file calls must be defined
 * by that same file, before its first use, and must survive the file's own
 * transaction handling. Suite files are independent; none may inherit helpers
 * from a previously executed file.
 */
export function analyzeSqlSuiteFile(sqlText) {
  const defined = new Set([...String(sqlText).matchAll(HELPER_DEF)].map((m) => m[1]));
  const used = new Set([...String(sqlText).matchAll(HELPER_USE)].map((m) => m[1]));
  const undefinedHelpers = [...used].filter((n) => !defined.has(n));
  const survival = tempHelperSurvival(buildSqlSuiteScript(sqlText));
  return {
    defined: [...defined].sort(),
    used: [...used].sort(),
    undefinedHelpers,
    survival,
    ok: undefinedHelpers.length === 0 && survival.status === "safe",
  };
}

/** Throws when a file would call a temporary helper that cannot exist. */
export function assertSqlSuiteFileIsSessionSafe(file, sqlText) {
  const analysis = analyzeSqlSuiteFile(sqlText);
  if (analysis.undefinedHelpers.length) {
    throw new Error(
      `${file} calls pg_temp.${analysis.undefinedHelpers[0]}() but never defines it. ` +
        "Suite files must create their own temporary helpers in the same session.",
    );
  }
  if (analysis.survival.status === "lost") {
    throw new Error(
      `${file} line ${analysis.survival.line}: pg_temp.${analysis.survival.lostHelper}() is called after a ` +
        "ROLLBACK that destroys it. Create the helper at session scope, before the first transaction.",
    );
  }
  return analysis;
}

/**
 * Runs the canonical suite. Stops at the first failing file, never downgrades a
 * failure to a warning, and identifies the file that failed.
 *
 * @param {{run:(sql:string)=>{ok:boolean,stdout?:string,stderr?:string},
 *          files?:string[], root?:string, onFile?:(file:string)=>void}} options
 * @returns {{ok:boolean, ran:string[], failedFile:string|null, stderr:string}}
 */
export function runSqlSuite({ run, files = SQL_SUITE_FILES, root = REPO_ROOT, onFile } = {}) {
  const ran = [];
  for (const file of files) {
    const sqlText = readFileSync(join(root, file), "utf8");
    assertSqlSuiteFileIsSessionSafe(file, sqlText);
    const result = run(buildSqlSuiteScript(sqlText));
    if (!result.ok) {
      return { ok: false, ran, failedFile: file, stderr: String(result.stderr ?? "") };
    }
    ran.push(file);
    if (onFile) onFile(file);
  }
  return { ok: true, ran, failedFile: null, stderr: "" };
}