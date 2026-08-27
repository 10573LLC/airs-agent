// Proves the platform tenant display name is plain ASCII in every canonical
// source, and that the repair migration is safe, idempotent and narrowly scoped.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SQL_SUITE_FILES } from "../scripts/lib/sql-suite.mjs";

import { MIGRATION_FILES } from "../scripts/lib/migrate-plan.mjs";

const EXPECTED = "Anconison - AIRS Agent Platform";
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

const seed = read("db/migrations/0011_platform_administration.sql");
const repair = read("db/migrations/0012_fix_platform_org_display_name.sql");

describe("platform organization display name", () => {
  it("seeds the plain ASCII name in migration 0011", () => {
    expect(seed).toContain(`'anconison-platform','${EXPECTED}'`);
    expect(seed).not.toContain("Anconison — AIRS Agent Platform");
    expect(seed).not.toMatch(/\uFFFD/);
  });

  it("keeps the identity of the platform tenant unchanged", () => {
    expect(seed).toContain("'00000000-0000-4000-8000-00000000a123','anconison-platform'");
    expect(seed).toContain("'other','platform'");
  });

  it("keeps the display-name repair before later migrations", () => {
    expect(MIGRATION_FILES).toContain("db/migrations/0012_fix_platform_org_display_name.sql");
    expect(MIGRATION_FILES.indexOf("db/migrations/0012_fix_platform_org_display_name.sql")).toBeLessThan(MIGRATION_FILES.indexOf("db/migrations/0013_agency_system_profiles.sql"));
    expect(new Set(MIGRATION_FILES).size).toBe(MIGRATION_FILES.length);
  });

  it("updates only the platform tenant, idempotently", () => {
    expect(repair).toContain("WHERE slug = 'anconison-platform'");
    expect(repair).toContain(`SET name = '${EXPECTED}'`);
    expect(repair).toContain(`name IS DISTINCT FROM '${EXPECTED}'`);
    // exactly one UPDATE, and it targets organizations only
    const updates = repair.match(/UPDATE\s+airs\.[a-z_]+/g) ?? [];
    expect(updates).toEqual(["UPDATE airs.organizations"]);
  });

  it("fails when duplicate platform organizations exist", () => {
    expect(repair).toMatch(/v_count > 1/);
    expect(repair).toMatch(/RAISE EXCEPTION 'duplicate anconison-platform/);
  });

  it("never touches ids, slugs, org_kind, memberships, roles or agency tenants", () => {
    for (const forbidden of [
      "airs.memberships",
      "airs.user_roles",
      "airs.role_permissions",
      "airs.invitations",
      "airs.accounts",
      "albany-pd",
      "albany-county",
      "SET id",
      "SET slug",
      "SET org_kind",
      "DELETE",
    ]) {
      expect(repair).not.toContain(forbidden);
    }
  });

  it("contains only ASCII characters in both migrations", () => {
    // eslint-disable-next-line no-control-regex
    const nonAscii = /[^\x00-\x7F]/;
    expect(nonAscii.test(repair)).toBe(false);
    expect(
      nonAscii.test(
        seed
          .split("\n")
          .filter((l) => l.includes(EXPECTED))
          .join("\n"),
      ),
    ).toBe(false);
  });

  it("ships a SQL proof exercised by npm run db:test", () => {
    const sqlTest = read("db/tests/platform_org_name.sql");
    expect(sqlTest).toContain(EXPECTED);
    expect(sqlTest).toContain("Albany Police Department");
    expect(sqlTest).toContain("platform_admin");
    // suite membership is declared once, in the canonical runner's file list
    expect(SQL_SUITE_FILES).toContain("db/tests/platform_org_name.sql");
    expect(JSON.parse(read("package.json")).scripts["db:test"]).toBe("node scripts/db-test.mjs");
  });
});
