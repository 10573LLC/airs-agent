// Argument parsing and help text for `npm run platform-admin:setup`.
// Kept separate from the runner so `--help` and unknown-flag handling can be
// unit tested without a database.

/** flag name -> whether it takes a value */
export const KNOWN_FLAGS = {
  help: false,
  email: true,
  ttl: true,
  "new-link": false,
  "apply-migrations": false,
  "report-only": false,
};

export const HELP_TEXT = `AIRS Agent — platform administrator setup

Usage:
  npm run platform-admin:setup -- --email <address> [options]
  npm run platform-admin:setup -- --help

Options:
  --email <address>     Platform administrator to provision an invitation for.
                        Required for every mode except --help and --report-only.
  --ttl <seconds>       Invitation lifetime, 300..604800. Default 259200 (72h).
  --new-link            Revoke any usable pending invitation for the address and
                        mint a fresh single-use link. Use this whenever an
                        activation URL has been exposed, screenshotted or shared.
  --apply-migrations    Run the established migration runner (npm run db:migrate)
                        when migration 0011_platform_administration.sql is missing.
  --report-only         Run every check and print the identity report; issue
                        nothing and change nothing.
  --help                Print this help and exit 0. Does not require --email.

Environment variables:
  AIRS_BOOTSTRAP_DATABASE_URL   Required. Operator/owner connection string
                                (NOT the airs_app role). Falls back to DATABASE_URL.
  AIRS_PUBLIC_BASE_URL          Required unless --report-only. Base URL used to
                                build the one-time link, e.g. http://localhost:3000.
                                Falls back to APP_BASE_URL.

What this command changes:
  * Verifies the anconison-platform organization, the platform_admin role, and
    that platform_admin holds no agency operational permissions.
  * Optionally applies pending database migrations (only with --apply-migrations).
  * Creates ONE single-use, expiring platform_admin invitation, storing only its
    SHA-256 hash, and revokes any earlier pending invitation for the address.
  * Writes an audit event that contains no token material.
  * It never creates a second account, membership or usable invitation, and it
    never grants agency operational access.

What this command never prints or stores:
  * No password, no database URL, no connection credentials.
  * No token or token hash in logs, audit metadata or files.
  * The one-time URL is written to this terminal only. It cannot be reprinted;
    re-run with --new-link to replace it.

Account creation:
  An account is NOT created by this command. The account, its password hash and
  the platform membership only come into existence when the invited person
  completes activation at the one-time URL. The link is single-use and expires.

Windows PowerShell example:
  $env:AIRS_BOOTSTRAP_DATABASE_URL = "postgres://airs_owner:<password>@localhost:5432/airs"
  $env:AIRS_PUBLIC_BASE_URL = "http://localhost:3000"
  npm run platform-admin:setup -- --email wflack@anconisonpmg.com
  # or the wrapper:
  .\\scripts\\platform-admin-setup.ps1 -Email wflack@anconisonpmg.com

Replacing an exposed or unusable invitation:
  npm run platform-admin:setup -- --email wflack@anconisonpmg.com --new-link
  This revokes the previous pending link (it stops working immediately) and
  prints a fresh one-time URL.
`;

/**
 * @param {string[]} argv
 * @returns {{help:boolean, error?:string, flags:Record<string,string|boolean>}}
 */
export function parseArgs(argv = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      return { help: false, flags, error: `Unknown argument: ${token}` };
    }
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    if (!(rawName in KNOWN_FLAGS)) {
      return {
        help: false,
        flags,
        error: `Unknown flag: --${rawName}\nSupported flags: ${Object.keys(KNOWN_FLAGS)
          .map((f) => `--${f}`)
          .join(", ")}`,
      };
    }
    if (KNOWN_FLAGS[rawName]) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined || String(value).startsWith("--")) {
        return { help: false, flags, error: `Flag --${rawName} requires a value.` };
      }
      flags[rawName] = value;
    } else {
      flags[rawName] = true;
    }
  }
  return { help: flags.help === true, flags };
}
