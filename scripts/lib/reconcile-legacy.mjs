// AIRS Agent - cumulative legacy-schema reconciliation planning.
//
// Pure logic (no IO side effects beyond reading repository files), so every
// rule is unit-testable without PostgreSQL or Docker.
//
// Difference from scripts/lib/legacy-repair.mjs:
//   legacy-repair reasons in whole migrations and refuses anything partial.
//   Reconciliation reasons in *objects of the cumulative post-0012 schema*
//   (scripts/lib/canonical-schema.mjs) and creates only the objects that are
//   genuinely absent, using the current canonical definition, idempotently.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADVISORY_LOCK_KEYS,
  DEFAULT_LOCK_TIMEOUT_MS,
  REPO_ROOT,
  stripOuterTransaction,
} from "./migrate-plan.mjs";
import { CANONICAL_OBJECTS, RECONCILABLE_VERSIONS, SUPERSEDED_OBJECTS } from "./canonical-schema.mjs";
import { destructiveStatements, toIdempotentSql } from "./idempotent-sql.mjs";

export const RECONCILE_VERIFY_FILE = "db/repair/reconcile_verify.sql";
export const RECONCILE_RUNNER_VERSION = "reconcile-legacy";

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Read-only object probe. Every expression is evaluated inside a temporary
 * plpgsql wrapper with an exception handler, so probing a database that lacks
 * a table, type or extension can never abort the script.
 * Emits `id|t|f` lines.
 */
export function buildObjectProbeScript(objects = CANONICAL_OBJECTS) {
  const lines = [
    "\\set ON_ERROR_STOP on",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "CREATE OR REPLACE FUNCTION pg_temp.airs_probe(_expr text) RETURNS boolean",
    "LANGUAGE plpgsql AS $probe$",
    "DECLARE r boolean;",
    "BEGIN",
    "  EXECUTE 'SELECT (' || _expr || ')' INTO r;",
    "  RETURN COALESCE(r, false);",
    "EXCEPTION WHEN OTHERS THEN RETURN false;",
    "END $probe$;",
  ];
  for (const o of objects) {
    lines.push(
      `SELECT ${sqlText(o.id)} || '|' || CASE WHEN pg_temp.airs_probe(${sqlText(o.probe)}) THEN 't' ELSE 'f' END;`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Parses `id|t/f` output into { id, ok } records. */
export function parseObjectProbe(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\|/.test(l))
    .map((l) => {
      const [id, flag] = l.split("|");
      return { id, ok: flag === "t" };
    });
}

/**
 * Builds the reconciliation plan from probe results.
 * Returns { present, missing, units, conflicts, superseded, safe, error }.
 *
 * A missing object is only reconcilable when
 *   a) its owning migration is in RECONCILABLE_VERSIONS, and
 *   b) every prerequisite it declares is either already present or itself part
 *      of the plan (prerequisites are ordered by migration version).
 */
export function planReconciliation(results, objects = CANONICAL_OBJECTS) {
  const seen = new Map(results.map((r) => [r.id, r.ok]));
  const present = [];
  const missing = [];
  const conflicts = [];

  for (const o of objects) {
    const ok = seen.get(o.id);
    if (ok === undefined) {
      conflicts.push(`${o.id}: not probed (the probe script and the canonical inventory disagree)`);
      continue;
    }
    (ok ? present : missing).push(o);
  }

  const missingIds = new Set(missing.map((o) => o.id));

  for (const o of missing) {
    if (!RECONCILABLE_VERSIONS.includes(o.version)) {
      conflicts.push(
        `${o.id} (${o.label}) belongs to migration ${o.version}, which reconciliation never creates. ` +
          "This database is outside the supported legacy state.",
      );
      continue;
    }
    for (const req of o.requires ?? []) {
      const known = objects.find((c) => c.id === req);
      if (!known) {
        conflicts.push(`${o.id} declares unknown prerequisite ${req}`);
      } else if (missingIds.has(req) && !RECONCILABLE_VERSIONS.includes(known.version)) {
        conflicts.push(`${o.id} requires ${req}, which is missing and cannot be reconciled`);
      }
    }
  }

  const units = RECONCILABLE_VERSIONS.filter((v) => missing.some((o) => o.version === v)).map((version) => ({
    version,
    objects: missing.filter((o) => o.version === version).map((o) => o.id),
  }));

  const safe = conflicts.length === 0;
  return {
    present: present.map((o) => o.id),
    missing: missing.map((o) => ({ id: o.id, label: o.label, version: o.version })),
    units,
    conflicts,
    superseded: SUPERSEDED_OBJECTS,
    safe,
    error: safe
      ? null
      : ["Refusing to reconcile: unsafe or ambiguous state.", ...conflicts.map((c) => `  ${c}`), "", "Nothing was changed."].join("\n"),
  };
}

/** Operator-facing report. Never contains credentials, URLs or tokens. */
export function formatReconcileReport(plan, objects = CANONICAL_OBJECTS) {
  const lines = [];
  lines.push("Cumulative schema reconciliation report (post-0012 canonical schema)");
  lines.push("");
  lines.push(`  canonical objects: ${objects.length}`);
  lines.push(`  present:           ${plan.present.length}`);
  lines.push(`  missing:           ${plan.missing.length}`);
  lines.push("");
  lines.push("Superseded objects - required by NO current migration, never recreated:");
  for (const s of plan.superseded) {
    lines.push(`  ${s.id} (introduced-era ${s.version}) -> current equivalent: ${s.equivalent}`);
  }
  lines.push("");
  if (plan.missing.length === 0) {
    lines.push("Every canonical object is present. Reconciliation would make no changes.");
  } else {
    lines.push("Missing objects, by owning migration:");
    for (const unit of plan.units) {
      lines.push(`  ${unit.version}:`);
      for (const id of unit.objects) {
        const o = objects.find((c) => c.id === id);
        lines.push(`    - ${id}  (${o?.label ?? ""})`);
      }
    }
    const outside = plan.missing.filter((m) => !RECONCILABLE_VERSIONS.includes(m.version));
    if (outside.length) {
      lines.push("  outside the reconciliation scope:");
      for (const m of outside) lines.push(`    - ${m.id} (${m.version})`);
    }
  }
  lines.push("");
  lines.push("Expected actions:");
  if (plan.units.length === 0) {
    lines.push("  none");
  } else {
    for (const unit of plan.units) {
      lines.push(
        `  replay the canonical definition of ${unit.version} idempotently in one transaction ` +
          `(creates ${unit.objects.length} missing object(s), preserves every existing object and row)`,
      );
    }
    lines.push("  then: full SQL assertion suite, role parity, platform verification, ledger adoption 0001-0012");
  }
  lines.push("");
  lines.push(plan.safe ? "Reconciliation is SAFE for this database." : "Reconciliation is NOT safe:");
  for (const c of plan.conflicts) lines.push(`  ${c}`);
  return lines.join("\n");
}

function lockPreamble(lockTimeoutMs) {
  return [
    `SET LOCAL lock_timeout = '${Number(lockTimeoutMs)}ms';`,
    `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEYS[0]}, ${ADVISORY_LOCK_KEYS[1]});`,
  ].join("\n");
}

/**
 * One reconciliation unit = the current canonical migration body, transformed
 * into idempotent form, in ONE advisory-locked transaction. No ledger row is
 * written here: adoption happens only after every verification passed.
 */
export function buildReconcileScript(migration, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const body = toIdempotentSql(stripOuterTransaction(migration.sql));
  const destructive = destructiveStatements(body);
  if (destructive.length) {
    throw new Error(`Reconciliation body for ${migration.version} contains destructive statements: ${destructive.join(", ")}`);
  }
  return [
    "\\set ON_ERROR_STOP on",
    "\\timing off",
    "BEGIN;",
    lockPreamble(lockTimeoutMs),
    `-- >>> canonical ${migration.filename} (idempotent reconciliation form)`,
    body,
    "-- <<< reconciliation body",
    "COMMIT;",
    "",
  ].join("\n");
}

/** Post-reconciliation security and tenancy assertions (db/repair/reconcile_verify.sql). */
export function buildReconcileVerifyScript(root = REPO_ROOT) {
  return ["\\set ON_ERROR_STOP on", readFileSync(join(root, RECONCILE_VERIFY_FILE), "utf8"), ""].join("\n");
}

export const KNOWN_RECONCILE_FLAGS = {
  confirm: "Required to change anything. Without it the command only reports and changes nothing.",
  "backup-confirmed": "Required with --confirm. Attests that a recent pg_dump backup exists outside the repository.",
  "admin-email": "Platform administrator email to verify after reconciliation (default wflack@anconisonpmg.com).",
  "lock-timeout-ms": "Milliseconds to wait for the migration advisory lock (default 30000).",
  help: "Show this help.",
};

export function parseReconcileArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `Unknown argument: ${arg}`, flags };
    const name = arg.slice(2);
    if (!(name in KNOWN_RECONCILE_FLAGS)) return { error: `Unknown flag: ${arg}`, flags };
    if (name === "lock-timeout-ms" || name === "admin-email") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: `--${name} requires a value`, flags };
      flags[name] = name === "lock-timeout-ms" ? Number(value) : value;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  if (flags.confirm && !flags["backup-confirmed"]) {
    return { error: "--confirm also requires --backup-confirmed (attest that a recent backup exists).", flags };
  }
  return { flags };
}

export const RECONCILE_HELP_TEXT = [
  "AIRS Agent cumulative legacy-schema reconciliation (operator only)",
  "",
  "  npm run db:reconcile-legacy                        report only, changes nothing",
  "  npm run db:reconcile-legacy -- --confirm --backup-confirmed",
  "",
  "Never runs automatically and is not a numbered production migration. It",
  "probes the database object by object against the canonical post-0012 schema",
  "and creates ONLY the current objects that are genuinely absent, using the",
  "current canonical definition in idempotent form. Existing objects, rows,",
  "accounts, organizations, memberships, incidents, audit rows and platform",
  "administration records are never dropped, reset or overwritten.",
  "",
  "Objects that later migrations intentionally superseded are reported as",
  "superseded and are never recreated.",
  "",
  "Flags:",
  ...Object.entries(KNOWN_RECONCILE_FLAGS).map(([f, h]) => `  --${f.padEnd(18)} ${h}`),
  "",
  "Passwords, URLs, tokens and connection strings are never printed.",
].join("\n");

export const DEFAULT_ADMIN_EMAIL = "wflack@anconisonpmg.com";
