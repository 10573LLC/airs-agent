// Test isolation support (Stage 8 closure).
//
// Strategy: **deterministic fixture cleanup keyed by a unique run identifier.**
//
// Transaction-per-test is not usable here: the enforcement suites exercise the
// real service chain, which acquires its own pooled connections as the
// unprivileged `airs_app` role, so a fixture transaction opened on the admin
// connection would be invisible to the code under test. Instead every
// integration suite:
//
//   1. tags every account it creates with a per-run token
//      (`<suite>.<name>.<RUN>@example.test`) and creates its throwaway
//      organizations with the same token in the slug;
//   2. calls `cleanupRunFixtures()` from `afterAll`, which deletes every row
//      reachable from those accounts, users and organizations in
//      foreign-key-safe order.
//
// `afterAll` runs even when tests inside the file fail, so cleanup also happens
// after a failed run. Nothing outside the run's own fixtures is touched: the
// deletes are always bounded by the run's account ids, user ids or org ids.
// Mutations of *shared* demo rows (the trusted-agency pairing between the two
// demo organizations) are restored via `ensureTrustedAgency()`, which reports
// whether it created the row so `afterAll` can remove only what it added.
import type { Client } from "pg";

export interface RunFixtureScope {
  /** SQL LIKE pattern matching every account email created by this run. */
  emailLike: string;
  /** Throwaway organizations created by this run (never the demo orgs). */
  orgIds?: string[];
  /** Trusted-agency pairs to remove because this run created them. */
  trustedPairs?: Array<{ orgId: string; partnerOrgId: string }>;
}

/**
 * Approves a trusted-agency pairing for a test run and reports whether the row
 * had to be created. Pre-existing pairings are left exactly as they were so a
 * suite never mutates shared demo state it did not establish.
 */
export async function ensureTrustedAgency(
  admin: Client,
  orgId: string,
  partnerOrgId: string,
): Promise<{ created: boolean }> {
  const existing = await admin.query(
    `SELECT 1 FROM airs.trusted_agencies WHERE org_id = $1 AND partner_org_id = $2`,
    [orgId, partnerOrgId],
  );
  if (existing.rowCount && existing.rowCount > 0) return { created: false };
  await admin.query(
    `INSERT INTO airs.trusted_agencies (org_id, partner_org_id, status, approved_at)
     VALUES ($1,$2,'approved', now())
     ON CONFLICT (org_id, partner_org_id) DO NOTHING`,
    [orgId, partnerOrgId],
  );
  return { created: true };
}

/**
 * Removes every row created by one test run. Safe to call twice and safe to
 * call when the run never got as far as creating fixtures.
 */
export async function cleanupRunFixtures(
  admin: Client,
  scope: RunFixtureScope,
): Promise<void> {
  const orgIds = scope.orgIds?.filter(Boolean) ?? [];

  const accounts = (
    await admin.query<{ id: string }>(`SELECT id FROM airs.accounts WHERE email LIKE $1`, [
      scope.emailLike,
    ])
  ).rows.map((r) => r.id);

  const users = (
    await admin.query<{ id: string }>(
      `SELECT id FROM airs.users WHERE account_id = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
      [accounts, orgIds],
    )
  ).rows.map((r) => r.id);

  if (accounts.length === 0 && orgIds.length === 0 && (scope.trustedPairs?.length ?? 0) === 0) {
    return;
  }

  const observations = (
    await admin.query<{ id: string }>(
      `SELECT id FROM airs.observations
        WHERE created_by_account = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
      [accounts, orgIds],
    )
  ).rows.map((r) => r.id);

  const incidentRooms = (
    await admin.query<{ id: string }>(
      `SELECT id FROM airs.incident_rooms
        WHERE created_by_account = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
      [accounts, orgIds],
    )
  ).rows.map((r) => r.id);

  const a = [accounts, orgIds, users, observations, incidentRooms] as const;
  const run = (sql: string, params: unknown[]) => admin.query(sql, params);

  // Several planes are append-only by trigger (audit events, observation
  // annotations). The fixture owner suspends trigger firing for the duration of
  // the cleanup only; application code never runs in this mode.
  await admin.query(`SET session_replication_role = replica`);
  try {
  // Awareness plane (children first — several reference accounts NO ACTION).
  await run(
    `DELETE FROM airs.observation_shares
      WHERE observation_id = ANY($1::uuid[]) OR shared_by_account = ANY($2::uuid[])
         OR revoked_by_account = ANY($2::uuid[]) OR org_id = ANY($3::uuid[])
         OR partner_org_id = ANY($3::uuid[]) OR incident_id = ANY($4::uuid[])`,
    [a[3], a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.observation_relationships
      WHERE observation_id = ANY($1::uuid[]) OR related_observation_id = ANY($1::uuid[])
         OR created_by_account = ANY($2::uuid[]) OR invalidated_by_account = ANY($2::uuid[])
         OR org_id = ANY($3::uuid[])`,
    [a[3], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.observation_information_gaps
      WHERE observation_id = ANY($1::uuid[]) OR created_by_account = ANY($2::uuid[])
         OR resolved_by_account = ANY($2::uuid[]) OR org_id = ANY($3::uuid[])`,
    [a[3], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.observation_evidence_references
      WHERE observation_id = ANY($1::uuid[]) OR created_by_account = ANY($2::uuid[])
         OR removed_by_account = ANY($2::uuid[]) OR org_id = ANY($3::uuid[])`,
    [a[3], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.observation_annotations
      WHERE observation_id = ANY($1::uuid[]) OR author_account = ANY($2::uuid[])
         OR org_id = ANY($3::uuid[])`,
    [a[3], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.observations
      WHERE id = ANY($1::uuid[]) OR created_by_account = ANY($2::uuid[])
         OR updated_by_account = ANY($2::uuid[]) OR reviewed_by_account = ANY($2::uuid[])
         OR verified_by_account = ANY($2::uuid[]) OR closed_by_account = ANY($2::uuid[])
         OR org_id = ANY($3::uuid[]) OR incident_id = ANY($4::uuid[])`,
    [a[3], a[0], a[1], a[4]],
  );

  // Resource + geography planes.
  await run(
    `DELETE FROM airs.resource_locations
      WHERE reported_by_account = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])
         OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.resource_shares
      WHERE shared_by_account = ANY($1::uuid[]) OR revoked_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[]) OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.incident_assignments
      WHERE assigned_by_account = ANY($1::uuid[]) OR released_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[]) OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.shifts
      WHERE created_by_account = ANY($1::uuid[]) OR updated_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[]) OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.qualifications
      WHERE created_by_account = ANY($1::uuid[]) OR verified_by_account = ANY($1::uuid[])
         OR revoked_by_account = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
    [a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.personnel_profiles
      WHERE account_id = ANY($1::uuid[]) OR created_by_account = ANY($1::uuid[])
         OR updated_by_account = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])
         OR user_id = ANY($3::uuid[])`,
    [a[0], a[1], a[2]],
  );
  await run(
    `DELETE FROM airs.resources
      WHERE created_by_account = ANY($1::uuid[]) OR updated_by_account = ANY($1::uuid[])
         OR retired_by_account = ANY($1::uuid[]) OR restored_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[])`,
    [a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.operating_areas
      WHERE created_by_account = ANY($1::uuid[]) OR approved_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[]) OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );
  await run(
    `DELETE FROM airs.map_features
      WHERE created_by_account = ANY($1::uuid[]) OR updated_by_account = ANY($1::uuid[])
         OR org_id = ANY($2::uuid[]) OR incident_id = ANY($3::uuid[])`,
    [a[0], a[1], a[4]],
  );

  // Incident plane.
  await run(
    `DELETE FROM airs.incident_participants
      WHERE incident_id = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])
         OR partner_org_id = ANY($2::uuid[]) OR invited_by_org_id = ANY($2::uuid[])
         OR invited_by_user = ANY($3::uuid[]) OR accepted_by_user = ANY($3::uuid[])
         OR approved_by_user = ANY($3::uuid[])`,
    [a[4], a[1], a[2]],
  );
  await run(
    `DELETE FROM airs.incident_rooms
      WHERE id = ANY($1::uuid[]) OR created_by_account = ANY($2::uuid[])
         OR updated_by_account = ANY($2::uuid[]) OR closed_by_account = ANY($2::uuid[])
         OR org_id = ANY($3::uuid[])`,
    [a[4], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.incident_shares
      WHERE granted_by = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])
         OR partner_org_id = ANY($2::uuid[])`,
    [a[2], a[1]],
  );
  await run(`DELETE FROM airs.incidents WHERE created_by = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`, [
    a[2],
    a[1],
  ]);

  // Identity plane and its evidence.
  await run(
    `DELETE FROM airs.invitations
      WHERE email LIKE $1 OR invited_by = ANY($2::uuid[])
         OR accepted_account_id = ANY($3::uuid[]) OR org_id = ANY($4::uuid[])`,
    [scope.emailLike, a[2], a[0], a[1]],
  );
  await run(
    `DELETE FROM airs.audit_events
      WHERE actor_user_id = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])
         OR resource_id::text = ANY($3::uuid[]::text[])
         OR resource_id::text = ANY($4::uuid[]::text[])`,
    [a[2], a[1], a[3], a[4]],
  );
  await run(
    `DELETE FROM airs.user_roles
      WHERE user_id = ANY($1::uuid[]) OR granted_by = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
    [a[2], a[1]],
  );
  await run(
    `DELETE FROM airs.trusted_agencies
      WHERE org_id = ANY($1::uuid[]) OR partner_org_id = ANY($1::uuid[])
         OR requested_by = ANY($2::uuid[]) OR approved_by = ANY($2::uuid[])`,
    [a[1], a[2]],
  );
  for (const pair of scope.trustedPairs ?? []) {
    await run(`DELETE FROM airs.trusted_agencies WHERE org_id = $1 AND partner_org_id = $2`, [
      pair.orgId,
      pair.partnerOrgId,
    ]);
  }
  await run(
    `DELETE FROM airs.memberships
      WHERE account_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[]) OR org_id = ANY($3::uuid[])
         OR invited_by = ANY($2::uuid[])`,
    [a[0], a[2], a[1]],
  );
  await run(`DELETE FROM airs.sessions WHERE account_id = ANY($1::uuid[])`, [a[0]]);
    await run(`DELETE FROM airs.users WHERE id = ANY($1::uuid[])`, [a[2]]);
    await run(`DELETE FROM airs.accounts WHERE id = ANY($1::uuid[])`, [a[0]]);
    await run(`DELETE FROM airs.organizations WHERE id = ANY($1::uuid[])`, [a[1]]);
  } finally {
    await admin.query(`SET session_replication_role = origin`);
  }
}