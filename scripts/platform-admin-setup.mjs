#!/usr/bin/env node
/**
 * AIRS Agent — Platform Administrator setup (operator-run, end to end).
 *
 *   AIRS_BOOTSTRAP_DATABASE_URL=postgres://owner:...@localhost:5432/airs \
 *   AIRS_PUBLIC_BASE_URL=http://localhost:3000 \
 *     npm run platform-admin:setup -- --email wflack@anconisonpmg.com
 *
 * Flags:
 *   --email <address>    platform administrator to invite (required)
 *   --ttl <seconds>      link lifetime, 300..604800 (default 259200 = 72h)
 *   --new-link           revoke any usable pending invitation and mint a fresh one
 *   --apply-migrations   run `npm run db:migrate` when migration 0011 is missing
 *   --report-only        run every check, issue nothing
 *
 * The command is idempotent: it never creates a second account, a second
 * membership, or a second usable invitation. It only ever sends a SHA-256 hash
 * of the token to the database, and prints the one-time URL to this terminal
 * and nowhere else — never to logs, audit metadata or files.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? null : args[i + 1];
};
const has = (n) => args.includes(`--${n}`);

const url = process.env.AIRS_BOOTSTRAP_DATABASE_URL ?? process.env.DATABASE_URL;
const email = (flag("email") ?? "").trim().toLowerCase();
const ttl = Number(flag("ttl") ?? 259200);
const reportOnly = has("report-only");
const newLink = has("new-link");
const applyMigrations = has("apply-migrations");
const baseUrl = (process.env.AIRS_PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);

let step = 0;
const ok = (message, detail) =>
  console.log(`[${String(++step).padStart(2, "0")}] OK    ${message}${detail ? ` — ${detail}` : ""}`);
const info = (message) => console.log(`         ${message}`);
const fail = (message) => {
  console.error(`\nFAILED: ${message}\n`);
  process.exitCode = 1;
  throw new SetupError(message);
};
class SetupError extends Error {}

// Operational permission prefixes a platform administrator must never hold.
const OPERATIONAL_PREFIXES = [
  "incident.",
  "resource.",
  "map.",
  "observation.",
  "airspace.",
  "personnel.",
  "qualification.",
  "aircraft.",
];

let client;
try {
  // 1. Database URL configured.
  if (!url) fail("AIRS_BOOTSTRAP_DATABASE_URL is not set (see .env.example)");
  if (!email && !reportOnly) fail("--email is required");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`invalid e-mail address: ${email}`);
  if (!baseUrl && !reportOnly) {
    fail("AIRS_PUBLIC_BASE_URL is not set — set it explicitly (e.g. http://localhost:3000)");
  }
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) fail("AIRS_PUBLIC_BASE_URL must start with http:// or https://");
  ok("database URL configured", "AIRS_BOOTSTRAP_DATABASE_URL");

  // 2. Reachability.
  client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    fail(`database unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  ok("database reachable");

  // 3. Server version.
  const { rows: v } = await client.query("SHOW server_version");
  ok("PostgreSQL version", `PostgreSQL ${v[0].server_version}`);

  // 4/5. Migration 0011 applied (bootstrap routine + org_kind present)?
  const migrated = async () => {
    const { rows } = await client.query(`
      SELECT to_regprocedure('airs.bootstrap_platform_invitation(text,text,int)') IS NOT NULL AS fn,
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='airs' AND table_name='organizations'
                        AND column_name='org_kind') AS col`);
    return rows[0].fn && rows[0].col;
  };
  if (await migrated()) {
    ok("migrations applied through 0011_platform_administration.sql");
  } else if (applyMigrations) {
    info("migration 0011 missing — running the established migration runner (npm run db:migrate)");
    try {
      execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "db:migrate"], {
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: url },
      });
    } catch {
      fail("npm run db:migrate failed — resolve the migration error and re-run");
    }
    if (!(await migrated())) fail("migrations ran but 0011 objects are still missing");
    ok("migrations applied through 0011_platform_administration.sql", "applied now");
  } else {
    fail(
      "migration 0011_platform_administration.sql is not applied — re-run with --apply-migrations (or run npm run db:migrate)",
    );
  }

  // 6. Platform organization.
  const { rows: org } = await client.query(
    `SELECT id, slug, name FROM airs.organizations WHERE org_kind = 'platform'`,
  );
  if (org.length !== 1 || org[0].slug !== "anconison-platform") {
    fail("the anconison-platform organization is missing or not unique");
  }
  ok("platform organization present", `${org[0].slug} (${org[0].id})`);

  // 7. Platform role.
  const { rows: role } = await client.query(
    `SELECT key FROM airs.roles WHERE key = 'platform_admin'`,
  );
  if (role.length !== 1) fail("role platform_admin is missing");
  ok("role platform_admin present");

  // 8. No operational permissions on the platform plane.
  const { rows: perms } = await client.query(
    `SELECT permission_key FROM airs.role_permissions WHERE role_key = 'platform_admin' ORDER BY 1`,
  );
  const granted = perms.map((p) => p.permission_key);
  const leaked = granted.filter((p) => OPERATIONAL_PREFIXES.some((prefix) => p.startsWith(prefix)));
  if (leaked.length) fail(`platform_admin holds operational permissions: ${leaked.join(", ")}`);
  ok("platform_admin holds no agency operational permissions", granted.join(", "));

  // 9. Identity report for the supplied address (aggregates only).
  const report = async () => {
    const { rows } = await client.query("SELECT * FROM airs.platform_identity_report($1)", [email]);
    return rows[0];
  };
  const identity = await report();
  ok("identity report", JSON.stringify(identity));

  // 10. Never duplicate an active platform administrator.
  if (identity.platform_membership) {
    ok("already provisioned", "this address holds an active platform membership — nothing to do");
    info(`Sign in normally at ${baseUrl || "<AIRS_PUBLIC_BASE_URL>"}/auth`);
    process.exitCode = 0;
    throw new Done();
  }
  if (identity.agency_user_rows > 0) {
    info(
      `note: ${identity.agency_user_rows} agency user record(s) share this address; the platform membership stays separate`,
    );
  }

  // 11. Reuse a still-usable pending invitation unless the operator wants a new link.
  const { rows: pending } = await client.query(
    `SELECT i.id, to_json(i.expires_at)#>>'{}' AS expires_at, (i.expires_at <= now()) AS expired
       FROM airs.invitations i
       JOIN airs.organizations o ON o.id = i.org_id
      WHERE lower(i.email) = $1 AND i.status = 'pending' AND o.org_kind = 'platform'
      ORDER BY i.expires_at DESC`,
    [email],
  );
  const usable = pending.filter((p) => !p.expired);
  if (usable.length && !newLink && !reportOnly) {
    ok("a usable pending invitation already exists", `expires ${usable[0].expires_at}`);
    info(
      "The one-time token is stored only as a hash and cannot be reprinted. Re-run with --new-link to revoke it and issue a fresh link.",
    );
    process.exitCode = 0;
    throw new Done();
  }
  if (pending.length && !usable.length) {
    info(`${pending.length} expired/unusable pending invitation(s) will be revoked and replaced`);
  }

  if (reportOnly) {
    ok("report-only", "no invitation issued");
    process.exitCode = 0;
    throw new Done();
  }

  // 12. Mint the token locally; the database receives only its SHA-256 hash.
  const token = randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { rows: issued } = await client.query(
    "SELECT * FROM airs.bootstrap_platform_invitation($1, $2, $3)",
    [email, tokenHash, Number.isFinite(ttl) ? Math.trunc(ttl) : 259200],
  );
  const result = issued[0];
  ok("single-use platform-administrator invitation created", `invitation ${result.invitation_id}`);
  info(`superseded pending invitations: ${result.superseded}`);

  // 13/14. Local terminal only.
  const path = result.account_exists ? "/invite/" : "/activate/";
  process.stdout.write(
    [
      "",
      "  ─────────────────────────────────────────────────────────────",
      `  One-time ${result.account_exists ? "acceptance" : "activation"} URL (this terminal only — do not paste anywhere):`,
      "",
      `  ${baseUrl}${path}${token}`,
      "",
      `  Expires: ${result.expires_at}`,
      "  Single use. Opening it a second time fails.",
      "  ─────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
} catch (error) {
  if (!(error instanceof Done) && !(error instanceof SetupError)) {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  // 16. Always close the connection.
  await client?.end().catch(() => {});
}

function Done() {}
Done.prototype = Object.create(Error.prototype);
