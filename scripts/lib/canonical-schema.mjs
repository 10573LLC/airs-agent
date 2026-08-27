// AIRS Agent - canonical cumulative schema description (the schema that must
// exist AFTER migration 0012), expressed as concrete, individually probeable
// database objects.
//
// Why this file exists
// --------------------
// The legacy repair path used to probe "what migration N once created". That is
// wrong for a cumulative schema: some objects an early migration created were
// intentionally superseded, and some objects were never canonical at all. A
// database can therefore be complete and still fail a historical probe.
//
// Rules:
//   * every entry below is an object the CURRENT (post-0013) schema must have;
//   * SUPERSEDED_OBJECTS records objects that must NOT be required, with the
//     reason and the current equivalent - they are never recreated;
//   * `version` is the migration that owns the object today, and doubles as the
//     reconciliation unit: repairing a missing object replays that migration's
//     canonical definition idempotently, nothing else.

/**
 * Objects a historical probe once demanded that the current schema does not
 * have and must never regain. Each entry must name its current equivalent.
 */
export const SUPERSEDED_OBJECTS = [
  {
    id: "airs.has_permission",
    version: "0003",
    equivalent: "airs.current_org_id() / airs.current_account_id() + src/lib/rbac/authorize.ts",
    reason:
      "Permission evaluation was never moved into the database. 0003 ships airs.ctx() and " +
      "airs.current_account_id(); 0004 adds airs.current_org_id(). RLS predicates compare the " +
      "session org/account GUCs, and permission checks are enforced server-side by the TypeScript " +
      "RBAC model (src/lib/rbac/roles.ts). A SQL has_permission() would be a second, divergent " +
      "authorization source of truth and is deliberately absent.",
  },
  {
    id: "airs.disclosure_profiles",
    version: "0008",
    equivalent: "airs.disclosure_fields + airs.disclosure_profile_fields (+ the profile CHECK constraints)",
    reason:
      "Stage 6 models disclosure as a field catalogue plus a profile->field mapping, not as a " +
      "profiles table. Profiles are a closed vocabulary enforced by CHECK constraints on " +
      "airs.resource_shares.disclosure_profile and airs.incident_assignments.disclosure_profile and " +
      "seeded through airs.disclosure_profile_fields. A disclosure_profiles table never existed in " +
      "any applied migration.",
  },
];

const fn = (name) =>
  `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='airs' AND p.proname='${name}')`;
const table = (name) => `to_regclass('airs.${name}') IS NOT NULL`;
const policy = (name) => `EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='airs' AND tablename='${name}')`;
const forced = (name) => `(SELECT relforcerowsecurity FROM pg_class WHERE oid = 'airs.${name}'::regclass)`;
const index = (name) => `to_regclass('airs.${name}') IS NOT NULL`;
const column = (t, c) =>
  `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='airs' AND table_name='${t}' AND column_name='${c}')`;

/**
 * The canonical post-0013 object inventory. `requires` names prerequisite
 * object ids: reconciliation refuses to create an object whose prerequisites
 * are neither present nor part of the same plan.
 */
export const CANONICAL_OBJECTS = [
  // ---- 0001 tenancy foundation ------------------------------------------
  { version: "0001", id: "airs.organizations", label: "organizations table", probe: table("organizations") },
  { version: "0001", id: "airs.users", label: "users table", probe: table("users") },
  { version: "0001", id: "airs.memberships", label: "memberships table", probe: table("memberships") },
  { version: "0001", id: "airs.permissions", label: "permissions table", probe: table("permissions") },
  { version: "0001", id: "airs.roles", label: "roles table", probe: table("roles") },
  { version: "0001", id: "airs.role_permissions", label: "role_permissions table", probe: table("role_permissions") },
  { version: "0001", id: "airs.current_user_id", label: "current_user_id function", probe: fn("current_user_id") },
  {
    version: "0001",
    id: "rls:organizations",
    label: "forced RLS on organizations",
    probe: `(SELECT relrowsecurity FROM pg_class WHERE oid = 'airs.organizations'::regclass)`,
  },

  // ---- 0002 role model ----------------------------------------------------
  { version: "0002", id: "seed:roles", label: "10 roles seeded", probe: "(SELECT count(*) FROM airs.roles) >= 10" },
  { version: "0002", id: "seed:role_permissions", label: "role_permissions seeded", probe: "(SELECT count(*) FROM airs.role_permissions) > 0" },
  { version: "0002", id: "seed:agency_admin", label: "agency_admin role key", probe: "EXISTS (SELECT 1 FROM airs.roles WHERE key = 'agency_admin')" },

  // ---- 0003 authentication ------------------------------------------------
  // NOTE: airs.has_permission is intentionally NOT probed. See SUPERSEDED_OBJECTS.
  { version: "0003", id: "airs.accounts", label: "accounts table", probe: table("accounts") },
  { version: "0003", id: "airs.sessions", label: "sessions table", probe: table("sessions") },
  { version: "0003", id: "airs.invitations", label: "invitations table", probe: table("invitations") },
  { version: "0003", id: "airs.audit_events", label: "audit_events table", probe: table("audit_events") },
  { version: "0003", id: "airs.ctx", label: "ctx() session-context function", probe: fn("ctx") },
  { version: "0003", id: "airs.current_account_id", label: "current_account_id function", probe: fn("current_account_id") },
  { version: "0003", id: "col:users.account_id", label: "users.account_id column", probe: column("users", "account_id") },

  // ---- 0004 org context guard ---------------------------------------------
  { version: "0004", id: "airs.current_org_id", label: "current_org_id function", probe: fn("current_org_id") },
  { version: "0004", id: "role:airs_app", label: "airs_app role", probe: "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_app')" },

  // ---- 0005 incident rooms -------------------------------------------------
  { version: "0005", id: "airs.incidents", label: "incidents table", probe: table("incidents") },
  { version: "0005", id: "airs.incident_participants", label: "incident_participants table", probe: table("incident_participants") },
  { version: "0005", id: "policy:incidents", label: "incidents RLS policy", probe: policy("incidents") },
  { version: "0005", id: "perm:incident", label: "incident permissions", probe: "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'incident.%') > 0" },

  // ---- 0006 maintenance plane ---------------------------------------------
  { version: "0006", id: "airs.expire_incident_state", label: "expire_incident_state function", probe: fn("expire_incident_state") },
  { version: "0006", id: "role:airs_maintenance", label: "airs_maintenance role", probe: "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airs_maintenance')" },

  // ---- 0007 resource registry ---------------------------------------------
  { version: "0007", id: "airs.resources", label: "resources table", probe: table("resources") },
  { version: "0007", id: "airs.resource_aircraft", label: "resource_aircraft table", probe: table("resource_aircraft") },
  { version: "0007", id: "airs.resource_vehicles", label: "resource_vehicles table", probe: table("resource_vehicles") },
  { version: "0007", id: "airs.resource_sensors", label: "resource_sensors table", probe: table("resource_sensors") },
  { version: "0007", id: "airs.personnel_profiles", label: "personnel_profiles table", probe: table("personnel_profiles") },
  { version: "0007", id: "airs.incident_assignments", label: "incident_assignments table", probe: table("incident_assignments") },
  { version: "0007", id: "airs.resource_shares", label: "resource_shares table", probe: table("resource_shares") },
  { version: "0007", id: "perm:resource", label: "resource permissions", probe: "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'resource.%') >= 6" },
  { version: "0007", id: "policy:resources", label: "resources RLS policy", probe: policy("resources") },
  { version: "0007", id: "rlsforce:resources", label: "forced RLS on resources", probe: forced("resources") },

  // ---- 0008 disclosure model (Stage 6) -------------------------------------
  {
    version: "0008",
    id: "airs.disclosure_fields",
    label: "disclosure_fields catalogue",
    probe: table("disclosure_fields"),
    requires: ["airs.resource_shares"],
    repairable: true,
  },
  {
    version: "0008",
    id: "airs.disclosure_profile_fields",
    label: "disclosure_profile_fields mapping",
    probe: table("disclosure_profile_fields"),
    requires: ["airs.disclosure_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "seed:disclosure_fields",
    label: "disclosure field catalogue seeded",
    probe: "(SELECT count(*) FROM airs.disclosure_fields) > 0",
    requires: ["airs.disclosure_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "seed:disclosure_profile_fields",
    label: "cumulative disclosure profiles seeded (summary/operational/full)",
    probe:
      "(SELECT count(DISTINCT profile) FROM airs.disclosure_profile_fields) >= 3 " +
      "AND EXISTS (SELECT 1 FROM airs.disclosure_profile_fields WHERE profile='summary')",
    requires: ["airs.disclosure_profile_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "seed:sensitive_fields",
    label: "sensitive disclosure fields flagged",
    probe: "(SELECT count(*) FROM airs.disclosure_fields WHERE sensitive) > 0",
    requires: ["airs.disclosure_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "airs.disclosure_allows",
    label: "disclosure_allows resolution function",
    probe: fn("disclosure_allows"),
    requires: ["airs.disclosure_profile_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "airs.effective_disclosure",
    label: "effective_disclosure resolution function",
    probe: fn("effective_disclosure"),
    requires: ["airs.resource_shares"],
    repairable: true,
  },
  {
    version: "0008",
    id: "airs.assignment_current_qualifications",
    label: "assignment_current_qualifications function",
    probe: fn("assignment_current_qualifications"),
    requires: ["airs.incident_assignments"],
    repairable: true,
  },
  {
    version: "0008",
    id: "airs.enforce_disclosure_keys",
    label: "enforce_disclosure_keys trigger function",
    probe: fn("enforce_disclosure_keys"),
    requires: ["airs.disclosure_fields"],
    repairable: true,
  },
  {
    version: "0008",
    id: "col:resource_shares.disclosure_profile",
    label: "resource_shares.disclosure_profile (partner narrowing)",
    probe: column("resource_shares", "disclosure_profile"),
    requires: ["airs.resource_shares"],
    repairable: true,
  },
  {
    version: "0008",
    id: "col:incident_assignments.disclosure_profile",
    label: "incident_assignments.disclosure_profile",
    probe: column("incident_assignments", "disclosure_profile"),
    requires: ["airs.incident_assignments"],
    repairable: true,
  },

  // ---- 0009 common operating picture (Stage 7) -----------------------------
  {
    version: "0009",
    id: "ext:postgis",
    label: "PostGIS extension",
    probe: "EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')",
    repairable: true,
  },
  { version: "0009", id: "type:geometry", label: "public.geometry type", probe: "to_regtype('public.geometry') IS NOT NULL", requires: ["ext:postgis"], repairable: true },
  { version: "0009", id: "airs.geographic_precisions", label: "geographic_precisions reference table", probe: table("geographic_precisions"), repairable: true },
  { version: "0009", id: "seed:geographic_precisions", label: "geographic precision reference data", probe: "(SELECT count(*) FROM airs.geographic_precisions) >= 4", requires: ["airs.geographic_precisions"], repairable: true },
  { version: "0009", id: "airs.disclosure_precisions", label: "disclosure_precisions mapping", probe: table("disclosure_precisions"), requires: ["airs.disclosure_profile_fields"], repairable: true },
  { version: "0009", id: "airs.map_features", label: "map_features table", probe: table("map_features"), requires: ["type:geometry", "airs.incidents"], repairable: true },
  { version: "0009", id: "airs.operating_areas", label: "operating_areas table", probe: table("operating_areas"), requires: ["type:geometry", "airs.incidents"], repairable: true },
  { version: "0009", id: "airs.resource_locations", label: "resource_locations table", probe: table("resource_locations"), requires: ["type:geometry", "airs.resources"], repairable: true },
  { version: "0009", id: "airs.resolve_precision", label: "resolve_precision function", probe: fn("resolve_precision"), requires: ["airs.geographic_precisions"], repairable: true },
  { version: "0009", id: "airs.apply_precision", label: "apply_precision function", probe: fn("apply_precision"), requires: ["type:geometry"], repairable: true },
  { version: "0009", id: "airs.location_freshness", label: "location_freshness function", probe: fn("location_freshness"), repairable: true },
  { version: "0009", id: "airs.incident_geo_profile", label: "incident_geo_profile function", probe: fn("incident_geo_profile"), requires: ["airs.incidents"], repairable: true },
  { version: "0009", id: "airs.terminate_incident_geography", label: "terminate_incident_geography function", probe: fn("terminate_incident_geography"), requires: ["airs.map_features"], repairable: true },
  { version: "0009", id: "perm:map", label: "map permissions", probe: "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'map.%') >= 6", repairable: true },
  { version: "0009", id: "policy:map_features", label: "map_features RLS policy", probe: policy("map_features"), requires: ["airs.map_features"], repairable: true },
  { version: "0009", id: "policy:operating_areas", label: "operating_areas RLS policy", probe: policy("operating_areas"), requires: ["airs.operating_areas"], repairable: true },
  { version: "0009", id: "policy:resource_locations", label: "resource_locations RLS policy", probe: policy("resource_locations"), requires: ["airs.resource_locations"], repairable: true },
  { version: "0009", id: "rlsforce:map_features", label: "forced RLS on map_features", probe: forced("map_features"), requires: ["airs.map_features"], repairable: true },
  { version: "0009", id: "rlsforce:resource_locations", label: "forced RLS on resource_locations", probe: forced("resource_locations"), requires: ["airs.resource_locations"], repairable: true },
  { version: "0009", id: "idx:map_features_geom_idx", label: "map_features spatial index", probe: index("map_features_geom_idx"), requires: ["airs.map_features"], repairable: true },
  { version: "0009", id: "idx:operating_areas_geom_idx", label: "operating_areas spatial index", probe: index("operating_areas_geom_idx"), requires: ["airs.operating_areas"], repairable: true },
  { version: "0009", id: "idx:resource_locations_geom_idx", label: "resource_locations spatial index", probe: index("resource_locations_geom_idx"), requires: ["airs.resource_locations"], repairable: true },

  // ---- 0010 awareness observations (Stage 8) -------------------------------
  { version: "0010", id: "airs.observations", label: "observations table", probe: table("observations"), requires: ["type:geometry", "airs.incidents"], repairable: true },
  { version: "0010", id: "airs.observation_annotations", label: "observation_annotations table", probe: table("observation_annotations"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_relationships", label: "observation_relationships table", probe: table("observation_relationships"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_information_gaps", label: "observation_information_gaps table", probe: table("observation_information_gaps"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_evidence_references", label: "observation_evidence_references table", probe: table("observation_evidence_references"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_shares", label: "observation_shares table", probe: table("observation_shares"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_freshness_thresholds", label: "observation_freshness_thresholds table", probe: table("observation_freshness_thresholds"), repairable: true },
  { version: "0010", id: "seed:observation_freshness_thresholds", label: "freshness thresholds seeded", probe: "(SELECT count(*) FROM airs.observation_freshness_thresholds) > 0", requires: ["airs.observation_freshness_thresholds"], repairable: true },
  { version: "0010", id: "airs.observation_freshness", label: "observation_freshness function", probe: fn("observation_freshness"), requires: ["airs.observation_freshness_thresholds"], repairable: true },
  { version: "0010", id: "airs.observation_precision", label: "observation_precision function (precision integration)", probe: fn("observation_precision"), requires: ["airs.resolve_precision", "airs.observations"], repairable: true },
  { version: "0010", id: "airs.observation_profile", label: "observation_profile function (disclosure integration)", probe: fn("observation_profile"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.has_observation_access", label: "has_observation_access function", probe: fn("has_observation_access"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.terminate_incident_observations", label: "terminate_incident_observations function", probe: fn("terminate_incident_observations"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "airs.expire_observation_state", label: "expire_observation_state function", probe: fn("expire_observation_state"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "perm:observation", label: "observation permissions", probe: "(SELECT count(*) FROM airs.permissions WHERE key LIKE 'observation.%') >= 10", repairable: true },
  { version: "0010", id: "policy:observations", label: "observations RLS policy", probe: policy("observations"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "policy:observation_shares", label: "observation_shares RLS policy", probe: policy("observation_shares"), requires: ["airs.observation_shares"], repairable: true },
  { version: "0010", id: "rlsforce:observations", label: "forced RLS on observations", probe: forced("observations"), requires: ["airs.observations"], repairable: true },
  { version: "0010", id: "idx:observations_geom_idx", label: "observations spatial index", probe: index("observations_geom_idx"), requires: ["airs.observations"], repairable: true },

  // ---- 0011 platform administration ---------------------------------------
  { version: "0011", id: "org:anconison-platform", label: "platform organization", probe: "EXISTS (SELECT 1 FROM airs.organizations WHERE slug = 'anconison-platform' AND org_kind = 'platform')" },
  { version: "0011", id: "role:platform_admin", label: "platform_admin role", probe: "EXISTS (SELECT 1 FROM airs.roles WHERE key = 'platform_admin')" },
  { version: "0011", id: "grants:platform_admin", label: "platform_admin grants", probe: "(SELECT count(*) FROM airs.role_permissions WHERE role_key = 'platform_admin') = 4" },
  {
    version: "0011",
    id: "guard:platform_admin_no_operational",
    label: "platform_admin has no operational permission",
    probe:
      "NOT EXISTS (SELECT 1 FROM airs.role_permissions WHERE role_key='platform_admin' AND (permission_key LIKE 'incident.%' OR permission_key LIKE 'resource.%' OR permission_key LIKE 'map.%' OR permission_key LIKE 'observation.%'))",
  },

  // ---- 0012 ASCII platform display name ------------------------------------
  {
    version: "0012",
    id: "value:platform_org_name",
    label: "ASCII platform display name",
    probe: "EXISTS (SELECT 1 FROM airs.organizations WHERE slug='anconison-platform' AND name='Anconison - AIRS Agent Platform')",
  },
  {
    version: "0012",
    id: "guard:no_em_dash",
    label: "no em dash or mojibake in the platform name",
    probe: "NOT EXISTS (SELECT 1 FROM airs.organizations WHERE slug='anconison-platform' AND (name LIKE '%—%' OR name LIKE '%?%'))",
  },


  // ---- 0013 agency systems profile --------------------------------------
  { version: "0013", id: "airs.agency_system_profiles", label: "agency systems profile table", probe: table("agency_system_profiles") },
  { version: "0013", id: "airs.agency_system_ecosystems", label: "agency systems ecosystem table", probe: table("agency_system_ecosystems") },
  { version: "0013", id: "airs.agency_system_components", label: "agency systems component table", probe: table("agency_system_components") },
  { version: "0013", id: "policy:agency_system_profiles", label: "agency systems profile RLS policy", probe: policy("agency_system_profiles"), requires: ["airs.agency_system_profiles"] },
  { version: "0013", id: "rlsforce:agency_system_profiles", label: "forced RLS on agency systems profile", probe: forced("agency_system_profiles"), requires: ["airs.agency_system_profiles"] },];

/** Versions whose canonical objects reconciliation is allowed to create. */
export const RECONCILABLE_VERSIONS = ["0008", "0009", "0010"];

/** Canonical objects grouped by owning migration. */
export function objectsByVersion(objects = CANONICAL_OBJECTS) {
  const map = new Map();
  for (const o of objects) {
    if (!map.has(o.version)) map.set(o.version, []);
    map.get(o.version).push(o);
  }
  return map;
}

/**
 * Derives the legacy-repair STATE_PROBES shape ([label, expr] pairs per
 * migration) from the canonical inventory, so the two can never drift and a
 * superseded object can never re-enter the probe set.
 */
export function deriveStateProbes(objects = CANONICAL_OBJECTS) {
  const out = {};
  for (const [version, list] of objectsByVersion(objects)) {
    out[version] = list.map((o) => [o.label, o.probe]);
  }
  return out;
}

/** Human explanation for a superseded object id, or null. */
export function supersededNote(id) {
  return SUPERSEDED_OBJECTS.find((s) => s.id === id) ?? null;
}
