// Creates only a disposable test database; never uses operator DATABASE_URL.
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  loadMigrations,
  buildLedgerBootstrapScript,
  buildMigrationScript,
} from "./lib/migrate-plan.mjs";
import { runSqlSuite } from "./lib/sql-suite.mjs";

const suffix = randomBytes(6).toString("hex");
const container = `airs-oidc-test-${suffix}`;
const password = randomBytes(24).toString("hex");
const docker = (args, input) =>
  spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
let created = false;
let appCreated = false;
let networkCreated = false;
const network = `${container}-network`;
const app = `${container}-app`;
try {
  const started = docker([
    "run",
    "--detach",
    "--name",
    container,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER=airs_owner",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=airs",
    "postgis/postgis:16-3.5-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr);
  created = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "airs_owner", "-d", "airs"])
        .status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  const sql = (input) => {
    const result = docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "airs_owner",
        "-d",
        "airs",
      ],
      input,
    );
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  };
  const apply = (input) => {
    const result = sql(input);
    if (!result.ok) throw new Error(result.stderr);
  };
  apply(buildLedgerBootstrapScript());
  for (const migration of loadMigrations()) {
    apply(buildMigrationScript(migration));
    console.log(`Applied ${migration.filename}`);
  }
  apply(readFileSync("db/seed/demo_orgs.sql", "utf8"));
  apply(
    `ALTER ROLE airs_app LOGIN PASSWORD '${password}'; ALTER ROLE airs_maintenance LOGIN PASSWORD '${password}';`,
  );
  const suite = runSqlSuite({ run: sql, onFile: (file) => console.log(`SQL passed: ${file}`) });
  if (!suite.ok) throw new Error(`${suite.failedFile}: ${suite.stderr}`);
  const port = docker(["port", container, "5432/tcp"]).stdout.trim().split(":").at(-1);
  const url = (role) => `postgres://${role}:${password}@127.0.0.1:${port}/airs`;
  const child = spawn(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        AUTH_DRIVER: "local",
        DATABASE_URL: url("airs_app"),
        TEST_DATABASE_URL: url("airs_app"),
        TEST_ADMIN_DATABASE_URL: url("airs_owner"),
        TEST_MAINTENANCE_DATABASE_URL: url("airs_maintenance"),
      },
    },
  );
  const status = await new Promise((resolve) => child.on("exit", resolve));
  if (status !== 0) process.exitCode = 1;
  if (status === 0 && process.env.AIRS_TEST_IMAGE) {
    if (docker(["network", "create", network]).status !== 0)
      throw new Error("Could not create test network");
    networkCreated = true;
    if (docker(["network", "connect", network, container]).status !== 0)
      throw new Error("Could not connect test database");
    if (process.env.AIRS_TEST_OPS_IMAGE) {
      const ops = docker([
        "run",
        "--rm",
        "--network",
        network,
        "--env",
        `DATABASE_URL=postgres://airs_owner:${password}@${container}:5432/airs`,
        process.env.AIRS_TEST_OPS_IMAGE,
        "node",
        "scripts/db-migrate.mjs",
        "--status",
      ]);
      if (
        ops.status !== 0 ||
        !/pending migrations:\s+0\b/.test(ops.stdout) ||
        !/checksum conflicts:\s+0\b/.test(ops.stdout)
      ) {
        throw new Error(`Ops migration status failed: ${ops.stdout}\n${ops.stderr}`);
      }
      console.log("Ops image passed: migration ledger reports no pending migrations");
    }
    const appStart = docker([
      "run",
      "--detach",
      "--name",
      app,
      "--network",
      network,
      "--publish",
      "127.0.0.1::3000",
      "--env",
      "AUTH_DRIVER=oidc",
      "--env",
      `DATABASE_URL=postgres://airs_app:${password}@${container}:5432/airs`,
      "--env",
      "AIRS_PUBLIC_BASE_URL=https://app.example.test",
      "--env",
      "OIDC_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
      "--env",
      "OIDC_DOMAIN=https://test.auth.us-east-1.amazoncognito.com",
      "--env",
      "OIDC_CLIENT_ID=test-client",
      "--env",
      "OIDC_CLIENT_SECRET=test-secret",
      "--env",
      `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
      process.env.AIRS_TEST_IMAGE,
    ]);
    if (appStart.status !== 0) throw new Error(appStart.stderr);
    appCreated = true;
    const appPort = docker(["port", app, "3000/tcp"]).stdout.trim().split(":").at(-1);
    const base = `http://127.0.0.1:${appPort}`;
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        healthy =
          (await fetch(`${base}/api/public/health`, { signal: AbortSignal.timeout(3000) }))
            .status === 200;
      } catch {}
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error("Container readiness failed");
    const page = await fetch(`${base}/auth`);
    if (page.status !== 200 || !(await page.text()).includes("Sign in securely"))
      throw new Error("Managed login page did not render");
    const login = await fetch(`${base}/auth/login?redirect=%2Finvite%2Ftest-invitation`, {
      redirect: "manual",
    });
    const location = new URL(login.headers.get("location"));
    const cookie = login.headers.get("set-cookie") ?? "";
    if (
      login.status !== 302 ||
      location.origin !== "https://test.auth.us-east-1.amazoncognito.com" ||
      location.searchParams.get("code_challenge_method") !== "S256" ||
      !cookie.includes("__Host-airs_oidc=") ||
      !/HttpOnly/i.test(cookie) ||
      !/Secure/i.test(cookie) ||
      !/SameSite=Lax/i.test(cookie)
    ) {
      throw new Error("Login redirect/cookie security failed");
    }
    const callback = await fetch(`${base}/auth/callback?code=invalid&state=invalid`, {
      redirect: "manual",
    });
    if (
      callback.status !== 302 ||
      callback.headers.get("location") !== "/auth?error=sign_in_failed" ||
      (callback.headers.get("set-cookie") ?? "").includes("airs_session=")
    )
      throw new Error("Invalid callback was not rejected");
    console.log(
      "Container smoke passed: readiness, managed login page, PKCE redirect, secure transaction cookie, invalid callback rejection",
    );
  }
} catch (error) {
  console.error(String(error).replaceAll(password, "[redacted]"));
  process.exitCode = 1;
} finally {
  if (appCreated) docker(["rm", "--force", "--volumes", app]);
  if (created) docker(["rm", "--force", "--volumes", container]);
  if (networkCreated) docker(["network", "rm", network]);
}
