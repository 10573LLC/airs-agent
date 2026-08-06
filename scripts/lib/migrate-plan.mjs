// Portable migration planning - pure logic, no side effects, so every rule can
// be unit tested without PostgreSQL or Docker present.
//
// Responsibilities:
//   * read the ONE canonical migration manifest (db/migrations/manifest.txt),
//     which the Docker initialization path reads as well, so the two can never
//     drift;
//   * checksum every migration file (SHA-256 over the raw file bytes);
//   * diff the files against the persistent ledger
//     (airs_migrations.applied_migrations) into applied / pending / conflicts;
//   * compose the exact SQL each phase runs - one transaction per migration,
//     guarded by a PostgreSQL advisory lock;
//   * choose an execution path: a local `psql` binary, or the running Docker
//     Compose `db` service. Neither available => a clear, actionable error.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

export const RUNNER_VERSION = "2.0.0";

export const MANIFEST_FILE = "db/migrations/manifest.txt";
export const LEDGER_FILE = "db/ledger/0000_migration_ledger.sql";
export const ADOPT_VERIFY_FILE = "db/ledger/adopt_verify.sql";
export const LEDGER_TABLE = "airs_migrations.applied_migrations";

/** Session-independent advisory lock key. Held for the transaction only. */
export const ADVISORY_LOCK_KEYS = [4718152, 12];
/** How long a second runner waits for the lock before failing safely. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30000;

export const COMPOSE_SERVICE = "db";
export const DEFAULT_DB_USER = "airs_owner";
export const DEFAULT_DB_NAME = "airs";

/** SQL assertion suites adoption must pass before recording anything. */
export const VERIFICATION_FILES = [
  "db/tests/rls_matrix.sql",
  "db/tests/role_parity.sql",
  "db/tests/auth_rls.sql",
  "db/tests/incident_rls.sql",
  "db/tests/incident_expiration.sql",
  "db/tests/resource_registry_rls.sql",
  "db/tests/disclosure_projection.sql",
  "db/tests/map_geography_rls.sql",
  "db/tests/awareness_observations_rls.sql",
  "db/tests/platform_admin_rls.sql",
  "db/tests/platform_org_name.sql",
];

export const MARKER_ALREADY_APPLIED = "AIRS_MIGRATION_ALREADY_APPLIED";
export const MARKER_CHECKSUM_MISMATCH = "AIRS_MIGRATION_CHECKSUM_MISMATCH";
export const MARKER_LOCK_TIMEOUT = "lock timeout";

export const NO_PATH_ERROR = [
  "Cannot run migrations: neither a local `psql` nor a running Docker Compose `db` service was found.",
  "",
  "Choose one:",
  "  * start the database:            docker compose up -d db",
  "    (then re-run: npm run db:migrate)",
  "  * or install the PostgreSQL client tools and set DATABASE_URL",
  "",
  "Nothing was started, changed or removed.",
].join("\n");

/**
 * Redacts connection strings and password-like values from any text that may be
 * printed. Migration output must never leak credentials.
 */
export function redact(text) {
  return String(text ?? "")
    .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi, "$1://<redacted>")
    .replace(/\b(password|pgpassword|pwd)\s*[=:]\s*\S+/gi, "$1=<redacted>");
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** `0012_fix_platform_org_display_name.sql` -> `0012`. */
export function parseVersion(filename) {
  const match = /^(\d{4})_/.exec(filename.replace(/^.*[\\/]/, ""));
  if (!match) throw new Error(`Migration filename is not versioned: ${filename}`);
  return match[1];
}

/** Reads the single canonical manifest and returns migration file paths. */
export function readManifest(root = REPO_ROOT) {
  return readFileSync(join(root, MANIFEST_FILE), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((name) => `db/migrations/${name}`);
}

export const MIGRATION_FILES = readManifest();

/** Loads {version, filename, path, sql, checksum} for every manifest entry, sorted by version. */
export function loadMigrations(root = REPO_ROOT, files = MIGRATION_FILES) {
  return files
    .map((file) => {
      const bytes = readFileSync(join(root, file));
      return {
        version: parseVersion(file),
        filename: file.replace(/^.*[\\/]/, ""),
        path: file,
        sql: bytes.toString("utf8"),
        checksum: sha256(bytes),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Diffs migration files against ledger rows.
 * @param {Array<{version:string,filename:string,checksum:string}>} migrations
 * @param {Array<{version:string,filename:string,checksum:string}>} appliedRows
 */
export function diffMigrations(migrations, appliedRows) {
  const byVersion = new Map(appliedRows.map((r) => [r.version, r]));
  const applied = [];
  const pending = [];
  const conflicts = [];
  for (const m of [...migrations].sort((a, b) => a.version.localeCompare(b.version))) {
    const row = byVersion.get(m.version);
    if (!row) {
      pending.push(m);
    } else if (row.checksum !== m.checksum) {
      conflicts.push({ version: m.version, filename: m.filename, recorded: row.checksum, current: m.checksum });
    } else {
      applied.push(m);
    }
  }
  const unknown = appliedRows.filter((r) => !migrations.some((m) => m.version === r.version));
  return { applied, pending, conflicts, unknown };
}

/**
 * psql executes a script in one implicit session; the runner supplies the
 * transaction, so a migration's own outer `BEGIN;` / `COMMIT;` would commit the
 * ledger-less state early. Those two standalone statements are removed; nested
 * `BEGIN`/`END` inside DO blocks (indented, or without a trailing semicolon at
 * column 0) are left untouched.
 */
export function stripOuterTransaction(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^(BEGIN|COMMIT);\s*$/.test(line))
    .join("\n");
}

function lockPreamble(lockTimeoutMs) {
  return [
    `SET LOCAL lock_timeout = '${Number(lockTimeoutMs)}ms';`,
    `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEYS[0]}, ${ADVISORY_LOCK_KEYS[1]});`,
  ].join("\n");
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Idempotent bootstrap of the ledger objects themselves. */
export function buildLedgerBootstrapScript(root = REPO_ROOT) {
  return `\\set ON_ERROR_STOP on\nBEGIN;\n${readFileSync(join(root, LEDGER_FILE), "utf8")}\nCOMMIT;\n`;
}

/** Read-only ledger query. Emits `version|filename|checksum|applied_at`. */
export function buildLedgerReadScript() {
  return [
    "\\set ON_ERROR_STOP on",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "\\pset fieldsep '|'",
    `SELECT version, filename, checksum, applied_at FROM ${LEDGER_TABLE} ORDER BY version;`,
    "",
  ].join("\n");
}

/** Reports whether another migration process currently holds the advisory lock. */
export function buildLockProbeScript() {
  return [
    "\\set ON_ERROR_STOP on",
    "\\pset tuples_only on",
    "\\pset format unaligned",
    "BEGIN;",
    `SELECT CASE WHEN pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEYS[0]}, ${ADVISORY_LOCK_KEYS[1]})`,
    "  THEN 'free' ELSE 'held' END;",
    "ROLLBACK;",
    "",
  ].join("\n");
}

/**
 * One migration = one transaction: advisory lock, pending guard, migration SQL,
 * ledger row, COMMIT. A failure anywhere rolls the whole thing back, so a failed
 * migration never leaves a ledger entry behind.
 */
export function buildMigrationScript(migration, options = {}) {
  const {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    runnerVersion = RUNNER_VERSION,
    appRelease = null,
  } = options;
  return [
    "\\set ON_ERROR_STOP on",
    "\\timing off",
    "BEGIN;",
    lockPreamble(lockTimeoutMs),
    `SELECT airs_migrations.assert_pending(${sqlLiteral(migration.version)}, ${sqlLiteral(migration.checksum)});`,
    "-- >>> migration body",
    stripOuterTransaction(migration.sql),
    "-- <<< migration body",
    `SELECT airs_migrations.record_applied(${sqlLiteral(migration.version)}, ${sqlLiteral(migration.filename)},` +
      ` ${sqlLiteral(migration.checksum)}, 0, ${sqlLiteral(runnerVersion)}, ${sqlLiteral(appRelease)}, false);`,
    "COMMIT;",
    "",
  ].join("\n");
}

/**
 * Adoption: verification first, ledger rows second, migration SQL NEVER.
 * Everything happens in one locked transaction, so a failing assertion leaves
 * the database exactly as it was.
 */
export function buildAdoptionScript(migrations, verifySql, options = {}) {
  const {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    runnerVersion = RUNNER_VERSION,
    appRelease = null,
  } = options;
  const rows = [...migrations]
    .sort((a, b) => a.version.localeCompare(b.version))
    .map(
      (m) =>
        `SELECT airs_migrations.record_applied(${sqlLiteral(m.version)}, ${sqlLiteral(m.filename)},` +
        ` ${sqlLiteral(m.checksum)}, 0, ${sqlLiteral(runnerVersion)}, ${sqlLiteral(appRelease)}, true);`,
    );
  return [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    lockPreamble(lockTimeoutMs),
    "-- verification only; no migration body is executed during adoption",
    verifySql.replace(/^\\set ON_ERROR_STOP on\s*$/gm, ""),
    ...rows,
    "COMMIT;",
    "",
  ].join("\n");
}

/** Read-only assertion suite run, wrapped so it can never write. */
export function buildVerificationScript(sqlText) {
  return `\\set ON_ERROR_STOP on\nBEGIN;\n${sqlText}\nROLLBACK;\n`;
}

/**
 * Chooses the execution path and returns an `exec(sqlText)` descriptor factory.
 * Both paths pipe SQL on stdin, so local psql and the Docker fallback run byte
 * identical scripts.
 *
 * @returns {{mode:"psql"|"docker"|"none", error?:string,
 *            exec?:(sql:string)=>{command:string,args:string[],stdin:string}}}
 */
export function planExecution({
  hasLocalPsql,
  dockerDbRunning,
  databaseUrl,
  dbUser = DEFAULT_DB_USER,
  dbName = DEFAULT_DB_NAME,
} = {}) {
  if (hasLocalPsql) {
    if (!databaseUrl) {
      return {
        mode: "none",
        error: "DATABASE_URL is not set - required when using the local `psql` client.",
      };
    }
    return {
      mode: "psql",
      exec: (sql) => ({
        command: "psql",
        args: [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
        stdin: sql,
      }),
    };
  }
  if (dockerDbRunning) {
    return {
      mode: "docker",
      exec: (sql) => ({
        command: "docker",
        args: [
          "compose", "exec", "-T", COMPOSE_SERVICE,
          "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", dbUser, "-d", dbName, "-f", "-",
        ],
        stdin: sql,
      }),
    };
  }
  return { mode: "none", error: NO_PATH_ERROR };
}

/** CLI flag parsing for scripts/db-migrate.mjs. */
export const KNOWN_MIGRATE_FLAGS = {
  "dry-run": "Show applied, pending and conflicting migrations. Changes nothing.",
  status: "Print ledger status, including whether adoption or a lock wait applies.",
  "adopt-existing": "Record migrations 0001-0012 for a verified existing database, without running them.",
  "lock-timeout-ms": "Milliseconds a second runner waits for the advisory lock (default 30000).",
  help: "Show this help.",
};

export function parseMigrateArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `Unknown argument: ${arg}`, flags };
    const name = arg.slice(2);
    if (!(name in KNOWN_MIGRATE_FLAGS)) return { error: `Unknown flag: ${arg}`, flags };
    if (name === "lock-timeout-ms") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: `--${name} requires a value`, flags };
      flags[name] = Number(value);
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { flags };
}

export const MIGRATE_HELP_TEXT = [
  "AIRS Agent migration runner",
  "",
  "  npm run db:migrate                      apply pending migrations only",
  "  npm run db:migrate -- --dry-run         show what would run; changes nothing",
  "  npm run db:migrate:status               ledger status, conflicts, lock state",
  "  npm run db:migrate:adopt                adopt a verified existing database",
  "",
  "Flags:",
  ...Object.entries(KNOWN_MIGRATE_FLAGS).map(([flag, help]) => `  --${flag.padEnd(16)} ${help}`),
  "",
  "State lives in airs_migrations.applied_migrations. Previously applied",
  "migrations are immutable: a changed file stops the run instead of being",
  "re-applied or silently re-checksummed. Credentials and database URLs are",
  "never printed.",
].join("\n");
