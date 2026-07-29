import { describe, expect, it } from "vitest";
import { authorize, permissionsForRoles } from "../src/lib/rbac/authorize";
import { ROLE_KEYS, ROLE_PERMISSIONS, PERMISSION_KEYS } from "../src/lib/rbac/roles";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const P = (roles: any[], orgId = ORG_A) => ({ userId: "u1", orgId, roles });

describe("default deny", () => {
  it("denies with no principal", () => {
    expect(authorize(null, { resourceOrgId: ORG_A, permission: "incident.read" })).toEqual({
      allowed: false,
      reason: "no_principal",
    });
  });

  it("denies a user with no roles for every permission", () => {
    for (const permission of PERMISSION_KEYS) {
      expect(authorize(P([]), { resourceOrgId: ORG_A, permission }).allowed).toBe(false);
    }
  });
});

describe("tenant isolation", () => {
  it("denies cross-tenant access even for an agency admin", () => {
    expect(
      authorize(P(["agency_admin"]), { resourceOrgId: ORG_B, permission: "incident.read" }),
    ).toEqual({ allowed: false, reason: "tenant_mismatch" });
  });

  it("allows cross-tenant read only through an active share", () => {
    expect(
      authorize(P(["partner_agency_user"]), {
        resourceOrgId: ORG_B,
        permission: "incident.read",
        sharedWithPrincipalOrg: true,
      }),
    ).toEqual({ allowed: true, reason: "active_share" });
  });

  it("denies writes on shared resources", () => {
    expect(
      authorize(P(["incident_commander"]), {
        resourceOrgId: ORG_B,
        permission: "incident.update",
        sharedWithPrincipalOrg: true,
      }).allowed,
    ).toBe(false);
  });
});

describe("role model", () => {
  it("defines all nine roles", () => {
    expect(ROLE_KEYS).toHaveLength(9);
  });

  it("only grants permissions from the declared catalogue", () => {
    for (const role of ROLE_KEYS) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSION_KEYS).toContain(p);
    }
  });

  it("restricts the system auditor to audit reads", () => {
    expect([...permissionsForRoles(["system_auditor"])]).toEqual(["audit.read"]);
    expect(
      authorize(P(["system_auditor"]), { resourceOrgId: ORG_A, permission: "incident.read" })
        .allowed,
    ).toBe(false);
  });

  it("lets an airspace supervisor approve operations in its own tenant", () => {
    expect(
      authorize(P(["airspace_supervisor"]), {
        resourceOrgId: ORG_A,
        permission: "airspace.approve",
      }),
    ).toEqual({ allowed: true, reason: "role_permission" });
  });
});