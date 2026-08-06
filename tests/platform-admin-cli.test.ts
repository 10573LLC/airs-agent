// `npm run platform-admin:setup -- --help` behaviour.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { HELP_TEXT, KNOWN_FLAGS, parseArgs } from "../scripts/lib/platform-admin-cli.mjs";

const run = (args: string[]) =>
  spawnSync(process.execPath, ["scripts/platform-admin-setup.mjs", ...args], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: { ...process.env, AIRS_BOOTSTRAP_DATABASE_URL: "", DATABASE_URL: "" },
  });

describe("platform-admin setup CLI", () => {
  it("--help exits zero and needs no email", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("platform administrator setup");
    expect(result.stdout).not.toMatch(/--email is required/);
  });

  it("documents every supported flag", () => {
    for (const flag of Object.keys(KNOWN_FLAGS)) {
      expect(HELP_TEXT).toContain(`--${flag}`);
    }
  });

  it("documents environment, effects, secrecy, Windows and link replacement", () => {
    expect(HELP_TEXT).toContain("AIRS_BOOTSTRAP_DATABASE_URL");
    expect(HELP_TEXT).toContain("AIRS_PUBLIC_BASE_URL");
    expect(HELP_TEXT).toContain("What this command changes");
    expect(HELP_TEXT).toContain("never prints or stores");
    expect(HELP_TEXT).toContain("Windows PowerShell example");
    expect(HELP_TEXT).toMatch(/Replacing an exposed or unusable invitation/);
    expect(HELP_TEXT).toMatch(/An account is NOT created/);
  });

  it("contains no credentials or activation tokens", () => {
    expect(HELP_TEXT).not.toMatch(/postgres:\/\/[^<\s]*:[^<@\s]+@/);
  });

  it("rejects unknown flags with a nonzero exit code", () => {
    const result = run(["--bogus"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown flag: --bogus");
  });

  it("parses supported flags", () => {
    expect(parseArgs(["--email", "a@b.test", "--new-link"]).flags).toEqual({
      email: "a@b.test",
      "new-link": true,
    });
    expect(parseArgs(["--ttl"]).error).toMatch(/requires a value/);
    expect(parseArgs(["oops"]).error).toMatch(/Unknown argument/);
  });
});
