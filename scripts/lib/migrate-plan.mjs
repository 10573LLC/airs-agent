// Portable migration planning — pure logic, no side effects, so it can be unit
// tested without PostgreSQL or Docker present.
//
// Two execution paths, in priority order:
//   1. a local `psql` binary on PATH, using DATABASE_URL;
//   2. otherwise the running Docker Compose `db` service, via
//      `docker compose exec -T db psql`, with each migration piped on stdin.
// Neither path available => a clear, actionable error (never a silent
// container start or removal).

/** Applied in exactly this order. */
export const MIGRATION_FILES = [
  "db/migrations/0001_init.sql",
  "db/migrations/0002_roles_seed.sql",
  "db/migrations/0003_auth.sql",
  "db/migrations/0004_org_context_guard.sql",
  "db/migrations/0005_incident_rooms.sql",
  "db/migrations/0006_maintenance.sql",
  "db/migrations/0007_resource_registry.sql",
  "db/migrations/0008_disclosure_profiles.sql",
  "db/migrations/0009_common_operating_picture.sql",
  "db/migrations/0010_awareness_observations.sql",
  "db/migrations/0011_platform_administration.sql",
  "db/migrations/0012_fix_platform_org_display_name.sql",
];

export const COMPOSE_SERVICE = "db";
export const DEFAULT_DB_USER = "airs_owner";
export const DEFAULT_DB_NAME = "airs";

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

/**
 * Builds the ordered list of commands to run.
 *
 * @param {{hasLocalPsql:boolean, dockerDbRunning:boolean, databaseUrl?:string,
 *          files?:string[], dbUser?:string, dbName?:string}} input
 * @returns {{mode:"psql"|"docker"|"none", error?:string, steps:Array<{
 *          file:string, command:string, args:string[], stdinFile?:string}>}}
 */
export function planMigration({
  hasLocalPsql,
  dockerDbRunning,
  databaseUrl,
  files = MIGRATION_FILES,
  dbUser = DEFAULT_DB_USER,
  dbName = DEFAULT_DB_NAME,
} = {}) {
  if (hasLocalPsql) {
    if (!databaseUrl) {
      return {
        mode: "none",
        steps: [],
        error: "DATABASE_URL is not set — required when using the local `psql` client.",
      };
    }
    return {
      mode: "psql",
      steps: [
        {
          file: files.join(", "),
          command: "psql",
          args: [databaseUrl, "-v", "ON_ERROR_STOP=1", ...files.flatMap((f) => ["-f", f])],
        },
      ],
    };
  }

  if (dockerDbRunning) {
    return {
      mode: "docker",
      // One invocation per migration, in order; the runner stops at the first
      // nonzero exit code, so a failed migration never lets later files run.
      steps: files.map((file) => ({
        file,
        command: "docker",
        args: [
          "compose",
          "exec",
          "-T",
          COMPOSE_SERVICE,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          dbUser,
          "-d",
          dbName,
        ],
        stdinFile: file,
      })),
    };
  }

  return { mode: "none", steps: [], error: NO_PATH_ERROR };
}
