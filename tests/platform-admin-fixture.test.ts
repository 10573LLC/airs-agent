import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync("db/tests/platform_admin_rls.sql", "utf8");
const SECTION_5 = SQL.slice(SQL.indexOf("-- 5. A platform administrator"));
const ROLE_SWITCH = SECTION_5.indexOf("SET LOCAL ROLE airs_app;");

describe("platform_admin_rls.sql section 5 fixture", () => {
  it("resolves the platform probe account BEFORE switching to airs_app", () => {
    const before = SECTION_5.slice(0, ROLE_SWITCH);
    expect(before).toContain("FROM airs.accounts WHERE email = 'platform.probe@example.test'");
    expect(before).toContain("set_config('airs.test_platform_account_id'");
  });

  it("never queries airs.accounts once the restricted role is active", () => {
    expect(SECTION_5.slice(ROLE_SWITCH)).not.toContain("FROM airs.accounts");
  });

  it("reads the carried account id under airs_app instead of re-querying", () => {
    expect(SECTION_5).toContain("current_setting('airs.test_platform_account_id', true)::uuid");
  });

  it("asserts the fixture preconditions", () => {
    for (const label of [
      "the platform probe account exists before the restricted-role section begins",
      "the platform probe holds exactly one active platform_admin membership",
      "that membership belongs to the anconison-platform organization",
      "the platform probe holds no Albany membership",
      "the Albany users probe record exists and is retained for the invisibility proof",
      "the restricted-role section runs with a real platform-admin account id",
    ]) {
      expect(SECTION_5).toContain(label);
    }
  });

  it("asserts the platform-admin authorization outcomes", () => {
    for (const label of [
      "a platform administrator cannot assume an agency organization context",
      "a platform administrator cannot see the Albany organization row",
      "a platform administrator still sees its own platform organization",
      "a platform administrator reads no agency user rows",
      "a platform administrator reads no agency incidents",
      "a platform administrator reads no agency audit rows",
      "a platform administrator may act inside the platform organization",
      "the resolved organization is the Anconison platform tenant",
    ]) {
      expect(SECTION_5).toContain(label);
    }
  });

  it("keeps account-less and invitation-redemption context behaviour under test", () => {
    expect(SECTION_5).toContain(
      "account-less tenant-only context still resolves the requested organization",
    );
    expect(SECTION_5).toContain("an account with no membership resolves no organization context");
  });

  it("does not weaken RLS or add an Albany membership for the probe", () => {
    expect(SQL).not.toMatch(/ALTER TABLE[\s\S]*DISABLE ROW LEVEL SECURITY/i);
    expect(SQL).not.toMatch(/CREATE POLICY/i);
    expect(SQL).not.toMatch(/GRANT /i);
    expect(SECTION_5).not.toMatch(/INSERT INTO airs\.memberships/i);
  });
});
