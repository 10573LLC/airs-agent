// Fails if the TypeScript role model and the PostgreSQL seed data drift apart.
// Parses db/migrations/0002_roles_seed.sql (the file that produces the database
// rows) and compares it field by field with src/lib/rbac/roles.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PERMISSION_KEYS,
  ROLE_KEYS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RoleKey,
} from "../src/lib/rbac/roles";

// The role model is seeded by 0002 and extended by later migrations, so every
// migration that touches roles/permissions is parsed here.
const SEED_FILES = [
  "db/migrations/0002_roles_seed.sql",
  "db/migrations/0005_incident_rooms.sql",
  "db/migrations/0007_resource_registry.sql",
];
const sources = SEED_FILES.map((f) => readFileSync(join(process.cwd(), f), "utf8"));

function blocks(afterMarker: string): string {
  return sources
    .map((sql) => {
      const start = sql.indexOf(afterMarker);
      if (start === -1) return "";
      const end = sql.indexOf("ON CONFLICT", start);
      return sql.slice(start, end === -1 ? undefined : end);
    })
    .join("\n");
}

const rolesBlock = blocks("INSERT INTO airs.roles");
const permissionsBlock = blocks("INSERT INTO airs.permissions");
const grantsBlock = blocks("INSERT INTO airs.role_permissions");

const sqlRoles = new Map<string, string>(
  [...rolesBlock.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'[^']*'\s*\)/g)].map((m) => [
    m[1],
    m[2],
  ]),
);
const sqlPermissions = [
  ...permissionsBlock.matchAll(/\(\s*'([a-z_.]+)'\s*,\s*'[^']*'\s*\)/g),
].map((m) => m[1]);
const sqlGrants = [...grantsBlock.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_.]+)'\s*\)/g)].map(
  (m) => `${m[1]}:${m[2]}`,
);

describe("role model parity between TypeScript and PostgreSQL seed", () => {
  it("declares exactly nine roles on both sides", () => {
    expect(ROLE_KEYS).toHaveLength(9);
    expect([...sqlRoles.keys()].sort()).toEqual([...ROLE_KEYS].sort());
  });

  it("uses identical human-readable role names", () => {
    for (const key of ROLE_KEYS) {
      expect(sqlRoles.get(key), `role name for ${key}`).toBe(ROLE_LABELS[key as RoleKey]);
    }
  });

  it("declares identical permission keys", () => {
    expect(sqlPermissions.sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("declares identical role -> permission assignments", () => {
    const tsGrants = ROLE_KEYS.flatMap((role) =>
      ROLE_PERMISSIONS[role as RoleKey].map((p: PermissionKey) => `${role}:${p}`),
    ).sort();
    expect([...new Set(sqlGrants)].sort()).toEqual(tsGrants);
  });

  it("grants no permission that is not declared", () => {
    for (const grant of sqlGrants) {
      const [role, permission] = grant.split(":");
      expect(ROLE_KEYS).toContain(role);
      expect(PERMISSION_KEYS).toContain(permission);
    }
  });
});
