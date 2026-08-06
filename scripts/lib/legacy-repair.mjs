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
 * Concrete per-migration state probes. Each entry is a boolean SQL expression;
 * a migration counts as PRESENT only when every one of its probes is true, as
 * MISSING when every probe is false, and as PARTIAL (a hard error) otherwise.
 */
export const STATE_PROBES = {
  "0001": [
    ["organizations table", "to_regclass('airs.organizations') IS NOT NULL"],
    ["users table", "to_regclass('airs.users') IS NOT NULL"],
    ["memberships table", "to_regclass('airs.memberships') IS NOT NULL"],
    ["permissions table", "to_regclass('airs.permissions') IS NOT NULL"],
    ["forced RLS on organizations", "(SELECT relrowsecurity FROM pg_class WHERE oid = 'airs.organizations'::regclass)"],
  ],
  "0002": [
    ["10 roles seeded", "(SELECT count(*) FROM airs.roles) >= 10"],
    ["role_permissions seeded", "(SELECT count(*) FROM airs.role_permissions) > 0"],
    ["demo role keys", "EXISTS (SELECT 1 FROM airs.roles WHERE key = 'agency_admin')"],
  ],
  "0003": [
    ["sessions table", "to_regclass('airs.sessions') IS NOT NULL"],
    ["invitations table", "to_regclass('airs.invitations') IS NOT NULL"],
    ["audit_events table", "to_regclass('airs.audit_events') IS NOT NULL"],
    ["has_permission function", "to_regprocedure('airs.has_permission(text)') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='has_permission')"],
  ],
  "0004": [
    ["current_org_id function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='current_org_id')"],
    ["current_user_id function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='current_user_id')"],
    ["airs_app role", "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_app')"],
  ],
  "0005": [
    ["incidents table", "to_regclass('airs.incidents') IS NOT NULL"],
    ["incident_participants table", "to_regclass('airs.incident_participants') IS NOT NULL"],
    ["incident RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='incidents')"],
    ["incident permissions", "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'incident.%') > 0"],
  ],
  "0006": [
    ["expire_incident_state function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='expire_incident_state')"],
    ["airs_maintenance role", "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_maintenance')"],
  ],
  "0007": [
    ["resources table", "to_regclass('airs.resources') IS NOT NULL"],
    ["resource_aircraft table", "to_regclass('airs.resource_aircraft') IS NOT NULL"],
    ["resource_vehicles table", "to_regclass('airs.resource_vehicles') IS NOT NULL"],
    ["resource_sensors table", "to_regclass('airs.resource_sensors') IS NOT NULL"],
    ["personnel_profiles table", "to_regclass('airs.personnel_profiles') IS NOT NULL"],
    ["incident_assignments table", "to_regclass('airs.incident_assignments') IS NOT NULL"],
    ["resource_shares table", "to_regclass('airs.resource_shares') IS NOT NULL"],
    ["resource permissions", "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'resource.%') >= 6"],
    ["resources RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='resources')"],
    ["forced RLS on resources", "(SELECT relforcerowsecurity FROM pg_class WHERE oid = 'airs.resources'::regclass)"],
  ],
  "0008": [
    ["disclosure_profiles table", "to_regclass('airs.disclosure_profiles') IS NOT NULL"],
    ["disclosure_fields table", "to_regclass('airs.disclosure_fields') IS NOT NULL"],
    ["disclosure_profile_fields table", "to_regclass('airs.disclosure_profile_fields') IS NOT NULL"],
    ["disclosure profiles seeded", "(SELECT count(*) FROM airs.disclosure_profiles) > 0"],
    ["disclosure_profiles RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='disclosure_profiles')"],
  ],
  "0009": [
    ["postgis extension", "EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')"],
    ["geometry type", "to_regtype('public.geometry') IS NOT NULL"],
    ["map_features table", "to_regclass('airs.map_features') IS NOT NULL"],
    ["operating_areas table", "to_regclass('airs.operating_areas') IS NOT NULL"],
    ["resource_locations table", "to_regclass('airs.resource_locations') IS NOT NULL"],
    ["geographic_precisions table", "to_regclass('airs.geographic_precisions') IS NOT NULL"],
    ["apply_precision function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='apply_precision')"],
    ["terminate_incident_geography function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='terminate_incident_geography')"],
    ["map permissions", "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'map.%') >= 6"],
    ["map_features RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='map_features')"],
    ["operating_areas RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='operating_areas')"],
    ["forced RLS on resource_locations", "(SELECT relforcerowsecurity FROM pg_class WHERE oid = 'airs.resource_locations'::regclass)"],
  ],
  "0010": [
    ["observations table", "to_regclass('airs.observations') IS NOT NULL"],
    ["observation_relationships table", "to_regclass('airs.observation_relationships') IS NOT NULL"],
    ["observation_information_gaps table", "to_regclass('airs.observation_information_gaps') IS NOT NULL"],
    ["observation_evidence_references table", "to_regclass('airs.observation_evidence_references') IS NOT NULL"],
    ["observation_annotations table", "to_regclass('airs.observation_annotations') IS NOT NULL"],
    ["observation_shares table", "to_regclass('airs.observation_shares') IS NOT NULL"],
    ["observation_freshness_thresholds table", "to_regclass('airs.observation_freshness_thresholds') IS NOT NULL"],
    ["observation_freshness function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='observation_freshness')"],
    ["terminate_incident_observations function", "EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='terminate_incident_observations')"],
    ["observation permissions", "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'observation.%') >= 10"],
    ["observations RLS policy", "EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='observations')"],
    ["forced RLS on observations", "(SELECT relforcerowsecurity FROM pg_class WHERE oid = 'airs.observations'::regclass)"],
  ],
  "0011": [
    ["platform organization", "EXISTS (SELECT 1 FROM airs.organizations WHERE slug = 'anconison-platform' AND org_kind = 'platform')"],
    ["platform_admin role", "EXISTS (SELECT 1 FROM airs.roles WHERE key = 'platform_admin')"],
    ["platform_admin grants", "(SELECT count(*) FROM airs.role_permissions WHERE role_key = 'platform_admin') = 4"],
    ["platform_admin has no operational permission", "NOT EXISTS (SELECT 1 FROM airs.role_permissions WHERE role_key='platform_admin' AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%' OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%'))"],
  ],
  "0012": [
    ["ASCII platform display name", "EXISTS (SELECT 1 FROM airs.organizations WHERE slug = 'anconison-platform' AND name = 'Anconison - AIRS Agent Platform')"],
    ["no legacy em-dash / mojibake name", "NOT EXISTS (SELECT 1 FROM airs.organizations WHERE slug = 'anconison-platform' AND name <> 'Anconison - AIRS Agent Platform')"],
  ],
};

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
      "repair command will not guess. Nothing was changed.",
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
    `                  WHERE lower(u.email) = lower(${sqlText(adminEmail)})`,
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
