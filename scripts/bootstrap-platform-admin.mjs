#!/usr/bin/env node
/**
 * AIRS Agent — platform administrator bootstrap (portable, operator-run).
 *
 *   AIRS_BOOTSTRAP_DATABASE_URL=postgres://owner:...@host/airs \
 *   APP_BASE_URL=https://airs.example.gov \
 *     npm run bootstrap:platform-admin -- --email wflack@anconisonpmg.com
 *
 * Flags:
 *   --email <address>   recipient of the one-time invitation (required)
 *   --check <address>   additional address to report on (repeatable)
 *   --ttl <seconds>     link lifetime, 300..604800 (default 259200 = 72h)
 *   --report-only       run the identity report and exit without issuing a link
 *
 * Plain Node plus `pg`: no bundler, no framework, nothing builder-specific.
 *
 * Security properties:
 *   * the invitation token is generated here and sent to the database ONLY as a
 *     SHA-256 hash; the database never sees or stores the token;
 *   * the activation URL is written to stdout once and to nothing else — not to
 *     the audit trail, not to the structured log lines, not to any file;
 *   * the invitation expires and is single-use (claimed by a conditional
 *     UPDATE ... WHERE status = 'pending' during acceptance);
 *   * it needs an operator connection: airs.bootstrap_platform_invitation is
 *     not executable by the application role.
 */
import { createHash, randomBytes } from "node:crypto";

import pg from "pg";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
}
function flagAll(name) {
  return args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
}

const url = process.env.AIRS_BOOTSTRAP_DATABASE_URL ?? process.env.DATABASE_URL;
const email = (flag("email") ?? "").trim().toLowerCase();
const ttl = Number(flag("ttl") ?? 259200);
const reportOnly = args.includes("--report-only");
const extraChecks = flagAll("check").map((v) => v.trim().toLowerCase());
const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const log = (payload) => console.log(JSON.stringify(payload));
const fail = (message) => {
  console.error(JSON.stringify({ event: "bootstrap.failed", message }));
  process.exit(1);
};

if (!url) fail("AIRS_BOOTSTRAP_DATABASE_URL (or DATABASE_URL) is not set");
if (!email && !reportOnly) fail("--email is required");

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // 1. Pre-flight: does this address already exist anywhere? Aggregates only.
  for (const address of [...new Set([email, ...extraChecks].filter(Boolean))]) {
    const { rows } = await client.query("SELECT * FROM airs.platform_identity_report($1)", [
      address,
    ]);
    log({ event: "bootstrap.identity_report", email: address, ...rows[0] });
  }

  if (reportOnly) {
    log({ event: "bootstrap.report_only", issued: false });
    process.exit(0);
  }

  // 2. Refuse to duplicate an already-active platform administrator.
  const { rows: pre } = await client.query("SELECT * FROM airs.platform_identity_report($1)", [
    email,
  ]);
  if (pre[0]?.platform_membership) {
    log({
      event: "bootstrap.already_active",
      email,
      issued: false,
      message: "this address already holds a platform membership; nothing to do",
    });
    process.exit(0);
  }

  // 3. Mint the one-time token locally; the database receives only its hash.
  const token = randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const { rows } = await client.query(
    "SELECT * FROM airs.bootstrap_platform_invitation($1, $2, $3)",
    [email, tokenHash, Number.isFinite(ttl) ? Math.trunc(ttl) : 259200],
  );
  const result = rows[0];

  log({
    event: "bootstrap.invitation_created",
    email,
    role_key: "platform_admin",
    organization: result.org_slug,
    organization_id: result.org_id,
    invitation_id: result.invitation_id,
    expires_at: result.expires_at,
    superseded_pending_invitations: result.superseded,
    account_existed: result.account_exists,
    audited: "platform.bootstrap_invitation_created",
  });

  // 4. The single-use link. Printed here only — deliver it out of band and do
  //    not copy it into tickets, chat, screenshots or version control.
  const path = result.account_exists ? "/invite/" : "/activate/";
  process.stdout.write(
    `\n  One-time ${result.account_exists ? "acceptance" : "activation"} link (do not store):\n  ${baseUrl}${path}${token}\n\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end().catch(() => {});
}
