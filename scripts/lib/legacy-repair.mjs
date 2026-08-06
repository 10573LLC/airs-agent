// AIRS Agent - legacy (pre-ledger) database repair planning.
//
// Pure logic, no side effects, so every rule is unit-testable without
// PostgreSQL or Docker. The CLI (scripts/db-migrate-repair-legacy.mjs) supplies
// the process/IO; everything here only builds SQL text and classifies probe
// output.
//
// Design rules:
//   * A migration is NEVER classified as present from one table alone: every
//     migration has a set of concrete schema probes (tables, functions,
//     extensions, permissions, policies, exact values) and all of them must
//     hold.
//   * Migration state is NOT assumed to be an uninterrupted prefix. The known
//     live state (0001-0008 present, 0009/0010 missing, 0011/0012 present) is a
//     first-class, supported input.
//   * `relation already exists` is never treated as success - the runner only
//     executes migrations that the probes classified as MISSING.
import { DEFAULT_LOCK_TIMEOUT_MS, ADVISORY_LOCK_KEYS, LEDGER_FILE, REPO_ROOT, stripOuterTransaction } from "./migrate-plan.mjs";
import { CANONICAL_OBJECTS, SUPERSEDED_OBJECTS, deriveStateProbes } from "./canonical-schema.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Database image the deployment is pinned to. Documented in DATABASE.md. */
export const REQUIRED_DB_IMAGE = "postgis/postgis:16-3.5-alpine";
export const REQUIRED_PG_MAJOR = 16;
export const REQUIRED_POSTGIS_MINIMUM = "3.5";

export const POSTGIS_MISSING_ERROR = [
  "PostGIS is not available in this PostgreSQL server.",
  "",
  "Migrations 0009 and 0010 require the PostGIS extension. The plain",
  "`postgres:16-alpine` image does not ship it.",
  "",
  "Recreate ONLY the database container on the pinned PostGIS image, keeping",
  "the existing named volume (never `docker compose down -v`):",
  "",
  `  1. docker compose stop app expiration-scheduler`,
  `  2. docker compose stop db`,
  `  3. docker compose pull db          # ${REQUIRED_DB_IMAGE}`,
  `  4. docker compose up -d db         # same volume, same data`,
  `  5. docker compose exec -T db psql -U airs_owner -d airs -c "CREATE EXTENSION IF NOT EXISTS postgis"`,
  "",
  "Then re-run this command. Nothing was started, changed or removed.",
].join("\n");

/**
 * Concrete per-migration state probes, DERIVED from the canonical cumulative
 * schema inventory (scripts/lib/canonical-schema.mjs) rather than from what a
 * historical migration once created.
 *
 * This distinction matters: a database can be complete and still fail a
 * historical probe when a later migration superseded an object. Objects listed
 * in SUPERSEDED_OBJECTS are never probed and never recreated (see
 * canonical-schema.mjs for airs.has_permission and airs.disclosure_profiles).
 * Genuinely missing CURRENT objects still cause a refusal.
 *
 * A migration counts as PRESENT only when every probe is true, MISSING when
 * every probe is false, and PARTIAL (a hard error) otherwise.
 */
export const STATE_PROBES = deriveStateProbes();

export { SUPERSEDED_OBJECTS };

/** Migrations the repair path is allowed to execute. Everything else is report-only. */
export const REPAIRABLE_VERSIONS = ["0009", "0010"];

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Builds the read-only state probe script. Every expression runs through a
 * temporary plpgsql wrapper with an exception handler, so probing a database
 * that lacks a table can never abort the script.
 * Emits `version|label|t|f` lines.
 */
export function buildStateProbeScript(probes = STATE_PROBES) {
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
  for (const [version, checks] of Object.entries(probes)) {
    for (const [label, expr] of checks) {
      lines.push(
        `SELECT ${sqlText(version)} || '|' || ${sqlText(label)} || '|' ||` +
          ` CASE WHEN pg_temp.airs_probe(${sqlText(expr)}) THEN 't' ELSE 'f' END;`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Parses `version|label|t/f` probe output into per-check results. */
export function parseProbeOutput(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\|/.test(line))
    .map((line) => {
      const [version, label, flag] = line.split("|");
      return { version, label, ok: flag === "t" };
    });
}

/**
 * Classifies each migration as present / missing / partial from probe results.
 * Explicitly does NOT assume a contiguous prefix.
 */
export function classifyState(results) {
  const byVersion = new Map();
  for (const r of results) {
    if (!byVersion.has(r.version)) byVersion.set(r.version, []);
    byVersion.get(r.version).push(r);
  }
  const state = [];
  for (const version of [...byVersion.keys()].sort()) {
    const checks = byVersion.get(version);
    const passed = checks.filter((c) => c.ok);
    const failed = checks.filter((c) => !c.ok);
    let status = "partial";
    if (failed.length === 0) status = "present";
    else if (passed.length === 0) status = "missing";
    state.push({ version, status, checks, failed: failed.map((c) => c.label) });
  }
  return state;
}

/**
 * Turns the classification into an executable plan.
 * Returns { apply, present, missing, partial, error }.
 */
export function planRepair(state, migrations) {
  const partial = state.filter((s) => s.status === "partial");
  const missing = state.filter((s) => s.status === "missing").map((s) => s.version);
  const present = state.filter((s) => s.status === "present").map((s) => s.version);
  const unrepairable = missing.filter((v) => !REPAIRABLE_VERSIONS.includes(v));
  const apply = migrations.filter((m) => missing.includes(m.version) && REPAIRABLE_VERSIONS.includes(m.version));
  let error = null;
  if (partial.length) {
    error = [
      "Refusing to repair: the following migrations are only PARTIALLY represented.",
      ...partial.map((p) => `  ${p.version}: missing ${p.failed.join(", ")}`),
      "",
      "A partially applied migration must be investigated by an operator; the",
      "repair command will not guess and will not replay a whole migration over",
      "a half-present schema. Nothing was changed.",
      "",
      "For a cumulative legacy database, use the object-level reconciliation",
      "instead - it creates only the CURRENT objects that are genuinely absent:",
      "",
      "  npm run db:reconcile-legacy                       report only",
      "  npm run db:reconcile-legacy -- --confirm --backup-confirmed",
    ].join("\n");
  } else if (unrepairable.length) {
    error = [
      `Refusing to repair: migration(s) ${unrepairable.join(", ")} are missing but the`,
      `repair path only applies ${REPAIRABLE_VERSIONS.join(" and ")}.`,
      "This database is not the supported legacy state. Nothing was changed.",
    ].join("\n");
  }
  return { apply, present, missing, partial, error };
}

/** Availability probe: is PostGIS installed, or at least installable? */
export function buildPostgisProbeScript() {
  return [
    "\\set ON_ERROR_STOP on",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "SELECT 'installed=' || CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') THEN 'yes' ELSE 'no' END;",
    "SELECT 'available=' || CASE WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='postgis') THEN 'yes' ELSE 'no' END;",
    "SELECT 'server_major=' || split_part(current_setting('server_version'), '.', 1);",
    "",
  ].join("\n");
}

export function parsePostgisProbe(stdout) {
  const text = String(stdout ?? "");
  const read = (key) => (new RegExp(`${key}=(\\S+)`).exec(text) ?? [])[1] ?? "";
  return {
    installed: read("installed") === "yes",
    available: read("available") === "yes",
    serverMajor: Number(read("server_major") || 0),
  };
}

function lockPreamble(lockTimeoutMs) {
  return [
    `SET LOCAL lock_timeout = '${Number(lockTimeoutMs)}ms';`,
    `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEYS[0]}, ${ADVISORY_LOCK_KEYS[1]});`,
  ].join("\n");
}

/**
 * One missing migration, one transaction, advisory lock held, NO ledger row -
 * the ledger is created only after the whole verification suite passed. A
 * failure rolls the entire migration back, so no partial Stage 7/8 objects,
 * permissions or policies can survive.
 */
export function buildLegacyMigrationScript(migration, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  return [
    "\\set ON_ERROR_STOP on",
    "\\timing off",
    "BEGIN;",
    lockPreamble(lockTimeoutMs),
    "-- >>> migration body",
    stripOuterTransaction(migration.sql),
    "-- <<< migration body",
    "COMMIT;",
    "",
  ].join("\n");
}

/** Post-repair verification of the platform administrator and organization. */
export function buildPlatformVerificationScript(adminEmail) {
  return [
    "\\set ON_ERROR_STOP on",
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (SELECT 1 FROM airs.organizations WHERE slug='anconison-platform'",
    "                  AND name='Anconison - AIRS Agent Platform' AND org_kind='platform') THEN",
    "    RAISE EXCEPTION 'REPAIR FAIL: platform organization is missing or renamed';",
    "  END IF;",
  `  IF NOT EXISTS (SELECT 1 FROM airs.users u JOIN airs.memberships m ON m.user_id = u.id`,
  `                  JOIN airs.organizations o ON o.id = m.org_id`,
  `                  WHERE lower(u.email_address) = lower(${sqlText(adminEmail)})`,
  `                    AND o.slug='anconison-platform' AND m.role_key='platform_admin') THEN`,
    "    RAISE EXCEPTION 'REPAIR FAIL: the platform administrator membership is missing';",
    "  END IF;",
    "  RAISE NOTICE 'ok  platform organization and platform administrator verified';",
    "END $$;",
    "",
  ].join("\n");
}

/**
 * Final step: create the ledger and record every migration 0001-0012 with its
 * CURRENT checksum, in one locked transaction. Migrations that the repair just
 * executed are recorded as applied; migrations already represented by the
 * database are recorded as adopted.
 */
export function buildLegacyLedgerScript(migrations, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, appliedVersions = [], runnerVersion = "repair-legacy", appRelease = null, root = REPO_ROOT } = {}) {
  const rows = [...migrations]
    .sort((a, b) => a.version.localeCompare(b.version))
    .map((m) => {
      const adopted = appliedVersions.includes(m.version) ? "false" : "true";
      return (
        `SELECT airs_migrations.record_applied(${sqlText(m.version)}, ${sqlText(m.filename)},` +
        ` ${sqlText(m.checksum)}, 0, ${sqlText(runnerVersion)}, ${appRelease ? sqlText(appRelease) : "NULL"}, ${adopted});`
      );
    });
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    readFileSync(join(root, LEDGER_FILE), "utf8"),
    lockPreamble(lockTimeoutMs),
    "-- the ledger must still be empty; a populated ledger means repair is not required",
    "DO $$ BEGIN",
    "  IF (SELECT count(*) FROM airs_migrations.applied_migrations) > 0 THEN",
    "    RAISE EXCEPTION 'REPAIR FAIL: the migration ledger already contains rows';",
    "  END IF;",
    "END $$;",
    ...rows,
    "COMMIT;",
    "",
  ].join("\n");
}

export const KNOWN_REPAIR_FLAGS = {
  confirm: "Required. Without it the command only reports state and changes nothing.",
  "backup-confirmed": "Required with --confirm. Attests that a recent database backup exists.",
  "admin-email": "Platform administrator email to verify after repair (default wflack@anconisonpmg.com).",
  "lock-timeout-ms": "Milliseconds to wait for the migration advisory lock (default 30000).",
  help: "Show this help.",
};

export function parseRepairArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `Unknown argument: ${arg}`, flags };
    const name = arg.slice(2);
    if (!(name in KNOWN_REPAIR_FLAGS)) return { error: `Unknown flag: ${arg}`, flags };
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

export const DEFAULT_ADMIN_EMAIL = "wflack@anconisonpmg.com";

export const REPAIR_HELP_TEXT = [
  "AIRS Agent legacy database repair (pre-ledger databases only)",
  "",
  "  npm run db:migrate:repair-legacy                       report state only",
  "  npm run db:migrate:repair-legacy -- --confirm --backup-confirmed",
  "",
  "Never runs automatically. It probes an existing database with concrete",
  "schema checks (tables, functions, extensions, permissions, policies and",
  "exact values), applies ONLY the migrations those probes prove missing",
  `(${REPAIRABLE_VERSIONS.join(", ")}), runs the full SQL assertion suite, role parity and the`,
  "platform administrator verification, and only then creates the migration",
  "ledger and records 0001-0012 with their current checksums.",
  "",
  "Flags:",
  ...Object.entries(KNOWN_REPAIR_FLAGS).map(([flag, help]) => `  --${flag.padEnd(18)} ${help}`),
  "",
  `Requires the ${REQUIRED_DB_IMAGE} database image (PostgreSQL ${REQUIRED_PG_MAJOR} +`,
  `PostGIS ${REQUIRED_POSTGIS_MINIMUM}). Passwords, URLs, tokens and connection strings are never printed.`,
].join("\n");
