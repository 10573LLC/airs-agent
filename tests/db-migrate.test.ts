// Portable migration runner: path selection, ordering, safety and redaction.
import { describe, expect, it } from "vitest";

import {
  MIGRATION_FILES,
  NO_PATH_ERROR,
  planMigration,
  redact,
} from "../scripts/lib/migrate-plan.mjs";

const URL_ = "postgres://airs_owner:s3cr3t@localhost:5432/airs";

describe("migration runner planning", () => {
  it("uses the local psql client when it is available", () => {
    const plan = planMigration({ hasLocalPsql: true, dockerDbRunning: true, databaseUrl: URL_ });
    expect(plan.mode).toBe("psql");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].command).toBe("psql");
    expect(plan.steps[0].args).toContain("ON_ERROR_STOP=1");
  });

  it("falls back to docker compose exec when local psql is absent", () => {
    const plan = planMigration({ hasLocalPsql: false, dockerDbRunning: true });
    expect(plan.mode).toBe("docker");
    for (const step of plan.steps) {
      expect(step.args.slice(0, 5)).toEqual(["compose", "exec", "-T", "db", "psql"]);
      expect(step.args).toContain("ON_ERROR_STOP=1");
      expect(step.stdinFile).toBe(step.file);
    }
  });

  it("preserves migration order on the docker path", () => {
    const plan = planMigration({ hasLocalPsql: false, dockerDbRunning: true });
    expect(plan.steps.map((s) => s.file)).toEqual(MIGRATION_FILES);
    expect(MIGRATION_FILES[0]).toBe("db/migrations/0001_init.sql");
    expect(MIGRATION_FILES.at(-1)).toBe("db/migrations/0011_platform_administration.sql");
  });

  it("stops on SQL errors: every docker step carries ON_ERROR_STOP and runs separately", () => {
    const plan = planMigration({ hasLocalPsql: false, dockerDbRunning: true });
    expect(plan.steps).toHaveLength(MIGRATION_FILES.length);
    expect(plan.steps.every((s) => s.args.includes("ON_ERROR_STOP=1"))).toBe(true);
  });

  it("fails safely when neither psql nor a running database is available", () => {
    const plan = planMigration({ hasLocalPsql: false, dockerDbRunning: false });
    expect(plan.mode).toBe("none");
    expect(plan.steps).toEqual([]);
    expect(plan.error).toBe(NO_PATH_ERROR);
    expect(plan.error).toMatch(/docker compose up -d db/);
    expect(plan.error).not.toMatch(/down -v/);
  });

  it("requires DATABASE_URL for the local psql path", () => {
    const plan = planMigration({ hasLocalPsql: true, dockerDbRunning: false });
    expect(plan.mode).toBe("none");
    expect(plan.error).toMatch(/DATABASE_URL/);
  });

  it("never leaks passwords or database URLs in printable output", () => {
    const message = redact(`connect failed for ${URL_} password=hunter2`);
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("localhost:5432/airs");
    expect(redact(NO_PATH_ERROR)).not.toMatch(/postgres:\/\/\S*:\S*@/);
    const plan = planMigration({ hasLocalPsql: false, dockerDbRunning: true });
    expect(JSON.stringify(plan)).not.toContain("s3cr3t");
  });
});
