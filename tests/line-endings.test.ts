// Windows bootstrap hardening: tracked shell scripts must be stored with LF.
// A CRLF shebang breaks the PostgreSQL container init ("/bin/sh^M: bad interpreter").
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkShellLineEndings,
  findCrlfFiles,
  hasCrlf,
  isShellPath,
  listTrackedShellFiles,
} from "../scripts/lib/line-endings.mjs";

describe("shell script line endings", () => {
  it("detects CRLF and accepts LF", () => {
    expect(hasCrlf("#!/bin/sh\r\nset -e\r\n")).toBe(true);
    expect(hasCrlf("#!/bin/sh\nset -e\n")).toBe(false);
  });

  it("recognises shell paths", () => {
    expect(isShellPath("db/init/04_app_role_login.sh")).toBe(true);
    expect(isShellPath("scripts/platform-admin-setup.ps1")).toBe(false);
  });

  it("tracks at least the two container init scripts", () => {
    const files = listTrackedShellFiles(process.cwd());
    expect(files).toContain("db/init/04_app_role_login.sh");
    expect(files).toContain("db/init/05_maintenance_role_login.sh");
  });

  it("every tracked .sh file uses LF", () => {
    const { offenders } = checkShellLineEndings(process.cwd());
    expect(offenders).toEqual([]);
  });

  it("rejects a CRLF shell-script fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "airs-crlf-"));
    try {
      writeFileSync(path.join(dir, "bad.sh"), "#!/bin/sh\r\nexit 0\r\n");
      writeFileSync(path.join(dir, "good.sh"), "#!/bin/sh\nexit 0\n");
      expect(findCrlfFiles(["bad.sh", "good.sh"], dir)).toEqual(["bad.sh"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
