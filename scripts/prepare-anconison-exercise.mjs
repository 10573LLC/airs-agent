import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
//#region src/lib/audit.server.ts
const FORBIDDEN_DETAIL_KEYS = /pass|secret|token|credential|authorization|cookie/i;
function sanitizeDetail(detail = {}) {
	const out = {};
	for (const [key, value] of Object.entries(detail)) {
		if (FORBIDDEN_DETAIL_KEYS.test(key)) continue;
		out[key] = typeof value === "string" && value.length > 512 ? value.slice(0, 512) : value;
	}
	return out;
}
async function recordAudit(q, event) {
	const detail = sanitizeDetail(event.detail);
	if (event.correlationId) detail.correlation_id = event.correlationId;
	await q.query(`INSERT INTO airs.audit_events
       (org_id, actor_user_id, action, resource_type, resource_id, outcome, detail, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [
		event.orgId,
		event.actorUserId ?? null,
		event.action,
		event.resourceType,
		event.resourceId ?? null,
		event.outcome,
		JSON.stringify(detail),
		event.ipAddress ?? null
	]);
}
//#endregion
//#region src/lib/adapters/postgres.server.ts
const UUID$2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUC = /^airs\.[a-z_]+$/;
function createPostgresAdapter(connectionString) {
	let poolPromise;
	async function getPool() {
		if (!poolPromise) poolPromise = import("pg").then((pg) => {
			return new (pg.default?.Pool ?? pg.Pool)({
				connectionString,
				max: 10,
				connectionTimeoutMillis: 3e3,
				statement_timeout: 15e3,
				idle_in_transaction_session_timeout: 15e3
			});
		});
		return poolPromise;
	}
	return {
		async withContext(settings, fn) {
			const client = await (await getPool()).connect();
			try {
				await client.query("BEGIN");
				for (const [name, value] of Object.entries(settings)) {
					if (value == null || value === "") continue;
					if (!GUC.test(name)) throw new Error(`Refusing to set non-airs GUC: ${name}`);
					await client.query("SELECT set_config($1, $2, true)", [name, value]);
				}
				const result = await fn({ query: async (sql, params) => (await client.query(sql, params ?? [])).rows });
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		async withTenant(ctx, fn) {
			if (!UUID$2.test(ctx.orgId) || !UUID$2.test(ctx.userId)) throw new Error("withTenant requires valid uuid orgId and userId");
			const client = await (await getPool()).connect();
			try {
				await client.query("BEGIN");
				await client.query("SELECT set_config('airs.org_id', $1, true)", [ctx.orgId]);
				await client.query("SELECT set_config('airs.user_id', $1, true)", [ctx.userId]);
				const result = await fn({ query: async (sql, params) => (await client.query(sql, params ?? [])).rows });
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		async close() {
			if (poolPromise) await (await poolPromise).end();
		}
	};
}
//#endregion
//#region src/lib/adapters/index.server.ts
let db;
function getDatabase() {
	if (db) return db;
	const driver = process.env.DB_DRIVER ?? "postgres";
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");
	switch (driver) {
		case "postgres":
			db = createPostgresAdapter(url);
			return db;
		default: throw new Error(`Unsupported DB_DRIVER: ${driver}`);
	}
}
//#endregion
//#region src/lib/rbac/roles.ts
const ROLE_PERMISSIONS = {
	agency_admin: [
		"org.manage",
		"user.manage",
		"incident.read",
		"incident.archive",
		"incident.view_participants",
		"airspace.read",
		"aircraft.manage",
		"retention.manage",
		"audit.read",
		"resource.create",
		"resource.read",
		"resource.update",
		"resource.retire",
		"resource.restore",
		"resource.set_status",
		"resource.share",
		"resource.revoke_share",
		"personnel.readiness_manage",
		"personnel.schedule_manage",
		"qualification.manage",
		"qualification.verify",
		"qualification.revoke",
		"map.read",
		"map.feature.manage",
		"map.precision.manage",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.review",
		"observation.close",
		"observation.reopen",
		"observation.share",
		"observation.revoke_share",
		"observation.link",
		"observation.evidence_reference_manage"
	],
	airspace_supervisor: [
		"incident.read",
		"incident.view_participants",
		"airspace.read",
		"airspace.approve",
		"airspace.propose",
		"aircraft.manage",
		"resource.read",
		"resource.update",
		"resource.set_status",
		"resource.share",
		"resource.revoke_share",
		"resource.assign_incident",
		"resource.release_incident",
		"personnel.readiness_manage",
		"personnel.schedule_manage",
		"qualification.verify",
		"map.read",
		"map.feature.manage",
		"map.operating_area.propose",
		"map.operating_area.approve",
		"map.position.report",
		"map.precision.manage",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.review",
		"observation.verify",
		"observation.reject",
		"observation.close",
		"observation.reopen",
		"observation.share",
		"observation.revoke_share",
		"observation.link",
		"observation.evidence_reference_manage"
	],
	rpic: [
		"incident.read",
		"airspace.read",
		"airspace.propose",
		"resource.read",
		"resource.set_status",
		"map.read",
		"map.position.report",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.evidence_reference_manage"
	],
	visual_observer: [
		"incident.read",
		"airspace.read",
		"resource.read",
		"map.read",
		"observation.create",
		"observation.read",
		"observation.update_own"
	],
	dispatcher: [
		"incident.create",
		"incident.read",
		"incident.update",
		"incident.activate",
		"incident.pause",
		"incident.resume",
		"incident.view_participants",
		"airspace.read",
		"resource.read",
		"resource.set_status",
		"resource.assign_incident",
		"resource.release_incident",
		"personnel.readiness_manage",
		"personnel.schedule_manage",
		"map.read",
		"map.position.report",
		"map.operating_area.propose",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.review",
		"observation.close",
		"observation.link",
		"observation.evidence_reference_manage"
	],
	incident_commander: [
		"incident.create",
		"incident.read",
		"incident.update",
		"incident.close",
		"incident.share",
		"incident.revoke_share",
		"incident.activate",
		"incident.pause",
		"incident.resume",
		"incident.archive",
		"incident.invite_partner",
		"incident.approve_partner",
		"incident.restrict_partner",
		"incident.remove_partner",
		"incident.view_participants",
		"airspace.read",
		"airspace.approve",
		"resource.read",
		"resource.set_status",
		"resource.share",
		"resource.revoke_share",
		"resource.assign_incident",
		"resource.release_incident",
		"map.read",
		"map.operating_area.propose",
		"map.operating_area.approve",
		"map.position.report",
		"map.precision.manage",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.review",
		"observation.verify",
		"observation.reject",
		"observation.close",
		"observation.reopen",
		"observation.share",
		"observation.revoke_share",
		"observation.link",
		"observation.evidence_reference_manage"
	],
	intel_analyst: [
		"incident.read",
		"incident.view_participants",
		"airspace.read",
		"resource.read",
		"map.read",
		"observation.create",
		"observation.read",
		"observation.update_own",
		"observation.review",
		"observation.verify",
		"observation.reject",
		"observation.link",
		"observation.evidence_reference_manage"
	],
	partner_agency_user: [
		"incident.read",
		"incident.view_participants",
		"airspace.read",
		"resource.read",
		"map.read",
		"observation.read"
	],
	system_auditor: ["audit.read"],
	platform_admin: [
		"org.manage",
		"user.manage",
		"audit.read",
		"retention.manage"
	]
};
//#endregion
//#region src/lib/rbac/authorize.ts
/** Permissions a partner org may exercise on a shared incident. Everything else is denied. */
const SHARED_PERMISSIONS = [
	"incident.read",
	"incident.view_participants",
	"airspace.read"
];
function permissionsForRoles(roles) {
	const out = /* @__PURE__ */ new Set();
	for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
	return out;
}
/** Default deny: every path must explicitly return allowed:true. */
function authorize(principal, request) {
	if (!principal || !principal.orgId || !principal.userId) return {
		allowed: false,
		reason: "no_principal"
	};
	const granted = permissionsForRoles(principal.roles);
	if (!(principal.orgId === request.resourceOrgId)) {
		if (!request.sharedWithPrincipalOrg) return {
			allowed: false,
			reason: "tenant_mismatch"
		};
		if (!SHARED_PERMISSIONS.includes(request.permission)) return {
			allowed: false,
			reason: "missing_permission"
		};
		if (!granted.has(request.permission)) return {
			allowed: false,
			reason: "missing_permission"
		};
		return {
			allowed: true,
			reason: "active_share"
		};
	}
	if (!granted.has(request.permission)) return {
		allowed: false,
		reason: "missing_permission"
	};
	return {
		allowed: true,
		reason: "role_permission"
	};
}
//#endregion
//#region src/lib/auth/errors.ts
const STATUS = {
	unauthenticated: 401,
	session_invalid: 401,
	no_active_org: 409,
	not_a_member: 403,
	membership_invited: 403,
	membership_suspended: 403,
	membership_revoked: 403,
	forbidden: 403,
	tenant_mismatch: 403,
	invitation_invalid: 400,
	invitation_expired: 400,
	invitation_revoked: 400,
	invitation_used: 400,
	invitation_wrong_recipient: 403,
	incident_not_found: 404,
	incident_state_invalid: 409,
	incident_stale_version: 409,
	partner_not_eligible: 403,
	participation_inactive: 403,
	invalid_input: 400,
	resource_not_found: 404,
	resource_retired: 409,
	invalid_status_for_category: 400,
	version_conflict: 409,
	incident_closed: 409,
	share_not_found: 404,
	share_revoked: 409,
	person_not_found: 404,
	qualification_not_found: 404,
	shift_conflict: 409,
	assignment_not_found: 404,
	assignment_terminated: 409,
	ics_objective_not_found: 404,
	ics_position_not_found: 404,
	resource_request_not_found: 404,
	authority_record_not_found: 404,
	threat_hypothesis_not_found: 404,
	invalid_geometry: 400,
	invalid_altitude_block: 400,
	invalid_time_window: 400,
	map_feature_not_found: 404,
	operating_area_not_found: 404,
	operating_area_state_invalid: 409,
	observation_not_found: 404,
	observation_state_invalid: 409,
	observation_stale_version: 409,
	observation_terminal: 409,
	observation_relationship_invalid: 400,
	observation_gap_not_found: 404,
	observation_evidence_not_found: 404,
	observation_share_not_found: 404,
	observation_share_revoked: 409
};
var AccessError = class extends Error {
	code;
	status;
	constructor(code, message) {
		super(message ?? code);
		this.name = "AccessError";
		this.code = code;
		this.status = STATUS[code];
	}
};
//#endregion
//#region src/lib/auth/password.ts
const ITERATIONS = 21e4;
const KEY_LENGTH = 32;
function b64(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}
function unb64(value) {
	const raw = atob(value);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
	return out;
}
async function derive(password, salt, iterations) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({
		name: "PBKDF2",
		hash: "SHA-256",
		salt,
		iterations
	}, key, KEY_LENGTH * 8);
	return new Uint8Array(bits);
}
async function hashPassword(password) {
	if (password.length < 12) throw new Error("password must be at least 12 characters");
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt, ITERATIONS);
	return `pbkdf2$sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}
/** Constant-time comparison of two equal-length byte arrays. */
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}
async function verifyPassword(password, stored) {
	if (!stored) return false;
	const parts = stored.split("$");
	if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
	const iterations = Number(parts[2]);
	if (!Number.isInteger(iterations) || iterations < 1e4) return false;
	try {
		const expected = unb64(parts[4]);
		return timingSafeEqual(await derive(password, unb64(parts[3]), iterations), expected);
	} catch {
		return false;
	}
}
//#endregion
//#region src/lib/auth/tokens.ts
function randomToken(bytes = 32) {
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	let s = "";
	for (const b of raw) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hashToken(token) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
//#endregion
//#region src/lib/auth/local-adapter.server.ts
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS ?? 3600 * 8);
const RESET_TTL_SECONDS = 1800;
async function loadMemberships(accountId) {
	return getDatabase().withContext({ "airs.account_id": accountId }, async (q) => {
		return (await q.query(`SELECT m.id, m.org_id, o.name, o.slug, m.user_id, m.role_key, m.status
         FROM airs.memberships m
         JOIN airs.organizations o ON o.id = m.org_id
        WHERE m.account_id = $1
        ORDER BY o.name`, [accountId])).map((r) => ({
			membershipId: r.id,
			orgId: r.org_id,
			orgName: r.name,
			orgSlug: r.slug,
			userId: r.user_id,
			roleKey: r.role_key,
			status: r.status
		}));
	});
}
/**
* Writes an identity-plane audit event into every organization where the
* account holds an ACTIVE membership. Suspended/revoked/invited memberships are
* excluded, matching the audit_identity_insert policy (migration 0004).
*/
async function auditIdentityEvent(accountId, action, outcome, meta, detail = {}) {
	const db = getDatabase();
	const memberships = (await loadMemberships(accountId)).filter((m) => m.status === "active");
	if (memberships.length === 0) return;
	await db.withContext({ "airs.account_id": accountId }, async (q) => {
		for (const m of memberships) await recordAudit(q, {
			orgId: m.orgId,
			actorUserId: m.userId,
			action,
			resourceType: "session",
			outcome,
			detail,
			ipAddress: meta.ipAddress ?? null,
			correlationId: meta.correlationId ?? null
		});
	}).catch((error) => {
		console.error("identity audit write failed", error);
	});
}
function createLocalAuthAdapter() {
	const db = getDatabase();
	async function findAccountByEmail(email) {
		return db.withContext({ "airs.login_email": email }, async (q) => {
			return (await q.query(`SELECT id, email, display_name, password_hash, status, mfa_enrolled
           FROM airs.accounts WHERE lower(email) = lower($1)`, [email]))[0] ?? null;
		});
	}
	return {
		driver: "local",
		async signIn(email, password, meta) {
			const account = await findAccountByEmail(email);
			if (!account) return {
				ok: false,
				reason: "invalid_credentials"
			};
			if (!await verifyPassword(password, account.password_hash)) {
				await db.withContext({ "airs.login_email": email }, (q) => q.query(`UPDATE airs.accounts SET failed_login_count = failed_login_count + 1, updated_at = now()
              WHERE id = $1`, [account.id]));
				await auditIdentityEvent(account.id, "auth.sign_in_failed", "deny", meta, { reason: "invalid_credentials" });
				return {
					ok: false,
					reason: "invalid_credentials"
				};
			}
			if (account.status !== "active") {
				await auditIdentityEvent(account.id, "auth.sign_in_failed", "deny", meta, { reason: "account_disabled" });
				return {
					ok: false,
					reason: "account_disabled"
				};
			}
			const active = (await loadMemberships(account.id)).filter((m) => m.status === "active");
			const defaultOrg = active.length === 1 ? active[0].orgId : null;
			const token = randomToken();
			const tokenHash = await hashToken(token);
			const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1e3).toISOString();
			await db.withContext({ "airs.account_id": account.id }, async (q) => {
				await q.query(`INSERT INTO airs.sessions (account_id, token_hash, active_org_id, expires_at, ip_address, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6)`, [
					account.id,
					tokenHash,
					defaultOrg,
					expiresAt,
					meta.ipAddress ?? null,
					meta.userAgent ?? null
				]);
				await q.query(`UPDATE airs.accounts SET last_login_at = now(), failed_login_count = 0, updated_at = now()
            WHERE id = $1`, [account.id]);
			});
			await auditIdentityEvent(account.id, "auth.sign_in", "allow", meta, {
				driver: "local",
				organizations: active.length
			});
			return {
				ok: true,
				token,
				expiresAt
			};
		},
		async signOut(token, meta) {
			const tokenHash = await hashToken(token);
			const accountId = (await db.withContext({ "airs.session_token_hash": tokenHash }, (q) => q.query(`SELECT account_id FROM airs.sessions WHERE token_hash = $1`, [tokenHash])))[0]?.account_id;
			if (!accountId) return;
			await db.withContext({ "airs.account_id": accountId }, (q) => q.query(`UPDATE airs.sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]));
			await auditIdentityEvent(accountId, "auth.sign_out", "allow", meta);
		},
		async resolve(token) {
			if (!token || typeof token !== "string" || token.length < 16) return null;
			const tokenHash = await hashToken(token);
			const session = (await db.withContext({ "airs.session_token_hash": tokenHash }, (q) => q.query(`SELECT id, account_id, active_org_id, to_json(expires_at)#>>'{}' AS expires_at, to_json(revoked_at)#>>'{}' AS revoked_at
             FROM airs.sessions WHERE token_hash = $1`, [tokenHash])))[0];
			if (!session) return null;
			if (session.revoked_at) return null;
			if (new Date(session.expires_at).getTime() <= Date.now()) return null;
			const account = (await db.withContext({ "airs.account_id": session.account_id }, (q) => q.query(`SELECT id, email, display_name, password_hash, status, mfa_enrolled
             FROM airs.accounts WHERE id = $1`, [session.account_id])))[0];
			if (!account || account.status !== "active") return null;
			await db.withContext({ "airs.account_id": account.id }, (q) => q.query(`UPDATE airs.sessions SET last_seen_at = now() WHERE id = $1`, [session.id]));
			return {
				session: {
					sessionId: session.id,
					accountId: account.id,
					activeOrgId: session.active_org_id,
					expiresAt: session.expires_at
				},
				account: {
					accountId: account.id,
					email: account.email,
					displayName: account.display_name,
					mfaEnrolled: account.mfa_enrolled
				},
				memberships: await loadMemberships(account.id)
			};
		},
		async revokeAllSessions(accountId, meta) {
			const rows = await db.withContext({ "airs.account_id": accountId }, (q) => q.query(`UPDATE airs.sessions SET revoked_at = now()
            WHERE account_id = $1 AND revoked_at IS NULL RETURNING id`, [accountId]));
			if (rows.length) await auditIdentityEvent(accountId, "auth.session_revoked", "allow", meta);
			return rows.length;
		},
		async listSessions(accountId, currentToken) {
			const currentHash = currentToken ? await hashToken(currentToken) : null;
			return (await db.withContext({ "airs.account_id": accountId }, (q) => q.query(`SELECT id, token_hash, to_json(issued_at)#>>'{}' AS issued_at, to_json(last_seen_at)#>>'{}' AS last_seen_at,
                  to_json(expires_at)#>>'{}' AS expires_at, to_json(revoked_at)#>>'{}' AS revoked_at,
                  host(ip_address) AS ip_address, user_agent
             FROM airs.sessions WHERE account_id = $1 ORDER BY issued_at DESC`, [accountId]))).map((r) => ({
				sessionId: r.id,
				issuedAt: r.issued_at,
				lastSeenAt: r.last_seen_at,
				expiresAt: r.expires_at,
				revokedAt: r.revoked_at,
				current: currentHash !== null && r.token_hash === currentHash,
				ipAddress: r.ip_address,
				userAgent: r.user_agent
			}));
		},
		async revokeSession(accountId, sessionId, meta) {
			const rows = await db.withContext({ "airs.account_id": accountId }, (q) => q.query(`UPDATE airs.sessions SET revoked_at = now()
            WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING id`, [sessionId, accountId]));
			if (rows.length) await auditIdentityEvent(accountId, "auth.session_revoked", "allow", meta);
			return rows.length > 0;
		},
		async startPasswordReset(email) {
			const account = await findAccountByEmail(email);
			if (!account) return null;
			const token = randomToken();
			const tokenHash = await hashToken(token);
			await db.withContext({ "airs.login_email": email }, (q) => q.query(`UPDATE airs.accounts
              SET password_reset_token_hash = $2,
                  password_reset_expires_at = now() + ($3 || ' seconds')::interval,
                  updated_at = now()
            WHERE id = $1`, [
				account.id,
				tokenHash,
				String(RESET_TTL_SECONDS)
			]));
			return token;
		},
		async completePasswordReset(token, newPassword) {
			return applyPasswordReset(await hashToken(token), await hashPassword(newPassword));
		},
		async upsertIdentity({ email, displayName, password, externalIssuer, externalSubject }) {
			const existing = await findAccountByEmail(email);
			if (existing) return {
				accountId: existing.id,
				email: existing.email,
				displayName: existing.display_name,
				mfaEnrolled: existing.mfa_enrolled
			};
			const passwordHash = password ? await hashPassword(password) : null;
			const row = (await db.withContext({ "airs.login_email": email }, (q) => q.query(`INSERT INTO airs.accounts (email, display_name, password_hash, external_issuer, external_subject)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, email, display_name, mfa_enrolled`, [
				email,
				displayName,
				passwordHash,
				externalIssuer ?? null,
				externalSubject ?? null
			])))[0];
			return {
				accountId: row.id,
				email: row.email,
				displayName: row.display_name,
				mfaEnrolled: row.mfa_enrolled
			};
		}
	};
}
/**
* Consumes a password-reset token. The account row is located by the stored
* token hash; the row's own e-mail is then supplied as the login context so the
* update satisfies the accounts RLS policy.
*/
async function applyPasswordReset(tokenHash, passwordHash) {
	return getDatabase().withContext({ "airs.password_reset_hash": tokenHash }, async (q) => {
		const account = (await q.query(`SELECT id, email FROM airs.accounts
        WHERE password_reset_token_hash = $1 AND password_reset_expires_at > now()`, [tokenHash]))[0];
		if (!account) return false;
		await q.query("SELECT set_config('airs.login_email', $1, true)", [account.email]);
		await q.query(`UPDATE airs.accounts
          SET password_hash = $2, password_reset_token_hash = NULL,
              password_reset_expires_at = NULL, updated_at = now()
        WHERE id = $1`, [account.id, passwordHash]);
		await q.query("SELECT set_config('airs.account_id', $1, true)", [account.id]);
		await q.query(`UPDATE airs.sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [account.id]);
		return true;
	});
}
//#endregion
//#region src/lib/auth/oidc-config.server.ts
function authDriver() {
	const value = process.env.AUTH_DRIVER;
	if (value === "oidc" || value === "local") return value;
	if (!value && process.env.NODE_ENV !== "production") return "local";
	throw new Error("AUTH_DRIVER must explicitly be local or oidc");
}
function oidcConfig() {
	if (authDriver() !== "oidc") throw new Error("OIDC is not enabled");
	const required = (name) => {
		const value = process.env[name];
		if (!value || value.includes("CHANGE_ME") || value.includes("<")) throw new Error(`Missing ${name}`);
		return value;
	};
	const issuer = required("OIDC_ISSUER");
	if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(issuer)) throw new Error("OIDC_ISSUER must be a Cognito user pool issuer");
	const domain = new URL(required("OIDC_DOMAIN"));
	const origin = new URL(required("AIRS_PUBLIC_BASE_URL"));
	for (const url of [domain, origin]) if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("OIDC domain and public base URL must be HTTPS origins");
	const secret = required("SESSION_SECRET");
	if (secret.length < 32) throw new Error("SESSION_SECRET must have at least 32 characters");
	return {
		issuer,
		domain: domain.origin,
		origin: origin.origin,
		clientId: required("OIDC_CLIENT_ID"),
		clientSecret: required("OIDC_CLIENT_SECRET"),
		secret,
		redirectUri: `${origin.origin}/auth/callback`
	};
}
//#endregion
//#region src/lib/auth/oidc-adapter.server.ts
function createOidcAuthAdapter() {
	const { issuer } = oidcConfig();
	const sessions = createLocalAuthAdapter();
	return {
		...sessions,
		driver: "oidc",
		async resolve(token) {
			if (!token?.startsWith("oidc.")) return null;
			const resolved = await sessions.resolve(token);
			if (!resolved) return null;
			const bound = await getDatabase().withContext({ "airs.account_id": resolved.account.accountId }, (q) => q.query("SELECT external_issuer, external_subject FROM airs.accounts WHERE id = $1", [resolved.account.accountId]));
			return bound[0]?.external_issuer === issuer && bound[0]?.external_subject ? resolved : null;
		},
		async signIn() {
			return {
				ok: false,
				reason: "invalid_credentials"
			};
		},
		async startPasswordReset() {
			return null;
		},
		async completePasswordReset() {
			return false;
		},
		async upsertIdentity() {
			throw new AccessError("unauthenticated");
		}
	};
}
//#endregion
//#region src/lib/auth/index.server.ts
let adapter;
function getAuthAdapter() {
	if (adapter) return adapter;
	const driver = authDriver();
	switch (driver) {
		case "local":
			adapter = createLocalAuthAdapter();
			return adapter;
		case "oidc":
			adapter = createOidcAuthAdapter();
			return adapter;
		default: throw new Error(`Unsupported AUTH_DRIVER: ${driver}`);
	}
}
//#endregion
//#region src/lib/auth/authorize.server.ts
const UUID$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Resolves the session only. Used by endpoints that must work before an org is chosen. */
async function requireSession(token) {
	const ctx = await getAuthAdapter().resolve(token);
	if (!ctx) throw new AccessError("unauthenticated");
	return ctx;
}
/** Maps a membership status onto the deny code the UI renders. */
function denyCodeForStatus(status) {
	switch (status) {
		case "invited": return "membership_invited";
		case "suspended": return "membership_suspended";
		default: return "membership_revoked";
	}
}
/**
* Resolves + validates the active organization membership for a session.
* Throws AccessError on every failure path; never returns a partial result.
*/
function resolveMembership(ctx, requestedOrgId) {
	const orgId = requestedOrgId ?? ctx.session.activeOrgId;
	if (!orgId) throw new AccessError("no_active_org");
	if (!UUID$1.test(orgId)) throw new AccessError("invalid_input");
	const membership = ctx.memberships.find((m) => m.orgId === orgId);
	if (!membership) throw new AccessError("not_a_member");
	if (membership.status !== "active") throw new AccessError(denyCodeForStatus(membership.status));
	return membership;
}
/** Writes a deny audit event when the tenant and actor are already known. */
async function auditDeny(membership, opts, reason) {
	await getDatabase().withContext({
		"airs.org_id": membership.orgId,
		"airs.user_id": membership.userId
	}, (q) => recordAudit(q, {
		orgId: membership.orgId,
		actorUserId: membership.userId,
		action: opts.action,
		resourceType: opts.resourceType,
		resourceId: opts.resourceId ?? null,
		outcome: "deny",
		detail: {
			...opts.detail ?? {},
			reason
		},
		ipAddress: opts.meta?.ipAddress ?? null,
		correlationId: opts.meta?.correlationId ?? null
	})).catch(() => {});
}
/**
* Runs `fn` only if the full chain succeeds. The callback receives a query
* runner bound to a transaction whose airs.* GUCs were applied with SET LOCAL,
* so the tenant context cannot survive into the next borrower of the pooled
* connection.
*/
async function withAuthorized(opts, fn) {
	const auth = await requireSession(opts.token);
	const membership = resolveMembership(auth, opts.orgId);
	const decision = authorize({
		userId: membership.userId,
		orgId: membership.orgId,
		roles: [membership.roleKey]
	}, {
		resourceOrgId: membership.orgId,
		permission: opts.permission ?? "incident.read"
	});
	if (opts.permission !== null && !decision.allowed) {
		await auditDeny(membership, opts, decision.reason);
		throw new AccessError("forbidden");
	}
	const context = {
		accountId: auth.account.accountId,
		email: auth.account.email,
		displayName: auth.account.displayName,
		sessionId: auth.session.sessionId,
		userId: membership.userId,
		orgId: membership.orgId,
		orgSlug: membership.orgSlug,
		orgName: membership.orgName,
		roleKey: membership.roleKey,
		permissions: permissionsForRoles([membership.roleKey]),
		memberships: auth.memberships,
		meta: opts.meta ?? {}
	};
	const db = getDatabase();
	try {
		return await db.withContext({
			"airs.org_id": membership.orgId,
			"airs.user_id": membership.userId,
			"airs.account_id": auth.account.accountId
		}, async (q) => {
			const result = await fn(context, q);
			if (opts.audit !== false) await recordAudit(q, {
				orgId: membership.orgId,
				actorUserId: membership.userId,
				action: opts.action,
				resourceType: opts.resourceType,
				resourceId: opts.resourceId ?? null,
				outcome: "allow",
				detail: opts.detail ?? {},
				ipAddress: opts.meta?.ipAddress ?? null,
				correlationId: opts.meta?.correlationId ?? null
			});
			return result;
		});
	} catch (error) {
		if (error instanceof AccessError) await auditDeny(membership, opts, error.code);
		throw error;
	}
}
//#endregion
//#region src/lib/incidents/lifecycle.ts
const INCIDENT_TYPES = [
	"routine_dfr",
	"planned_event",
	"missing_person",
	"search_and_rescue",
	"fire",
	"critical_incident",
	"tactical_operation",
	"disaster",
	"infrastructure_incident",
	"unauthorized_uas_investigation",
	"counter_uas_coordination",
	"training",
	"mutual_aid",
	"other"
];
const CLASSIFICATIONS = [
	"public",
	"restricted",
	"sensitive"
];
const SHARE_RULES = [
	"no_sharing",
	"view_only",
	"operational"
];
/** Every distinct lifecycle action, each separately authorized server-side. */
const INCIDENT_ACTIONS = [
	"read",
	"view_participants",
	"update",
	"schedule",
	"activate",
	"pause",
	"resume",
	"begin_closure",
	"close",
	"archive",
	"invite_partner",
	"approve_partner",
	"restrict_partner",
	"revoke_partner",
	"remove_partner",
	"withdraw",
	"read_audit"
];
/** Organization-level permission each action additionally requires. */
const ACTION_PERMISSION = {
	read: "incident.read",
	view_participants: "incident.view_participants",
	update: "incident.update",
	schedule: "incident.update",
	activate: "incident.activate",
	pause: "incident.pause",
	resume: "incident.resume",
	begin_closure: "incident.close",
	close: "incident.close",
	archive: "incident.archive",
	invite_partner: "incident.invite_partner",
	approve_partner: "incident.approve_partner",
	restrict_partner: "incident.restrict_partner",
	revoke_partner: "incident.revoke_share",
	remove_partner: "incident.remove_partner",
	withdraw: "incident.read",
	read_audit: "incident.read"
};
/**
* Incident-level matrix. Membership role permissions are checked SEPARATELY:
* an action is permitted only when BOTH this matrix and the organization
* permission allow it. Default deny — anything absent is denied.
*/
const RELATIONSHIP_ACTIONS = {
	origin_admin: [...INCIDENT_ACTIONS],
	incident_command: [
		"read",
		"view_participants",
		"pause",
		"resume",
		"begin_closure",
		"withdraw",
		"read_audit"
	],
	operational: [
		"read",
		"view_participants",
		"withdraw"
	],
	view_only: ["read", "view_participants"]
};
function incidentLevelAllows(relationship, action) {
	return (RELATIONSHIP_ACTIONS[relationship] ?? []).includes(action);
}
/** Actions a partner organization may never perform, regardless of level. */
const OWNER_ONLY_ACTIONS = [
	"update",
	"schedule",
	"activate",
	"close",
	"archive",
	"invite_partner",
	"approve_partner",
	"restrict_partner",
	"revoke_partner",
	"remove_partner"
];
//#endregion
//#region src/lib/incidents/incidents.server.ts
const ROOM_COLUMNS = `
  r.id, r.org_id AS "orgId", r.name, r.incident_type AS "incidentType", r.description,
  r.external_number AS "externalNumber", r.geographic_description AS "geographicDescription",
  r.status, r.classification, r.default_share_rule AS "defaultShareRule",
  r.temp_data_retention_hours AS "tempDataRetentionHours",
  to_json(r.scheduled_start_at)#>>'{}' AS "scheduledStartAt",
  to_json(r.scheduled_expires_at)#>>'{}' AS "scheduledExpiresAt",
  to_json(r.activated_at)#>>'{}' AS "activatedAt",
  to_json(r.closing_started_at)#>>'{}' AS "closingStartedAt",
  to_json(r.closed_at)#>>'{}' AS "closedAt",
  r.closure_reason AS "closureReason",
  to_json(r.archived_at)#>>'{}' AS "archivedAt",
  to_json(r.temp_data_expires_at)#>>'{}' AS "tempDataExpiresAt",
  to_json(r.data_expired_at)#>>'{}' AS "dataExpiredAt",
  r.version, to_json(r.created_at)#>>'{}' AS "createdAt", to_json(r.updated_at)#>>'{}' AS "updatedAt"
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertUuid(value, label) {
	if (!UUID.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function assertOneOf(value, allowed, label) {
	if (!allowed.includes(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function text(value, label, max, required = false) {
	if (value == null || value === "") {
		if (required) throw new AccessError("invalid_input", `${label} is required`);
		return null;
	}
	if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
	const trimmed = value.trim();
	if (required && trimmed.length === 0) throw new AccessError("invalid_input", `${label} is required`);
	if (trimmed.length > max) throw new AccessError("invalid_input", `${label} is too long`);
	return trimmed;
}
function timestamp(value, label) {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new AccessError("invalid_input", `invalid ${label}`);
	return new Date(value).toISOString();
}
/**
* Resolves the acting organization's relationship to an incident room.
* RLS already hides rooms the organization may not see; this adds the explicit
* relationship + liveness check so a denial is auditable rather than an empty
* result, and so a restricted participant is demoted to view-only.
*/
async function resolveIncidentAccess(q, ctx, incidentId) {
	assertUuid(incidentId, "incident id");
	const incident = (await q.query(`SELECT ${ROOM_COLUMNS} FROM airs.incident_rooms r WHERE r.id = $1`, [incidentId]))[0];
	if (!incident) throw new AccessError("incident_not_found");
	if (incident.orgId === ctx.orgId) return {
		incident,
		relationship: "origin_admin",
		participantId: null
	};
	const row = (await q.query(`SELECT p.id, p.access_level AS "accessLevel", p.invitation_status AS "invitationStatus",
            p.participation_status AS "participationStatus",
            (p.expires_at IS NOT NULL AND p.expires_at <= now()) AS expired
       FROM airs.incident_participants p
      WHERE p.incident_id = $1 AND p.partner_org_id = $2`, [incidentId, ctx.orgId]))[0];
	if (!row) throw new AccessError("forbidden");
	if (incident.status === "closed" || incident.status === "archived") throw new AccessError("participation_inactive");
	if (row.invitationStatus !== "accepted" || row.expired) throw new AccessError("participation_inactive");
	if (row.participationStatus !== "active" && row.participationStatus !== "restricted") throw new AccessError("participation_inactive");
	return {
		incident,
		relationship: row.participationStatus === "restricted" ? "view_only" : row.accessLevel,
		participantId: row.id
	};
}
/** The full protected chain for one incident action. */
async function withIncidentAction(opts, fn) {
	return withAuthorized({
		token: opts.token,
		orgId: opts.orgId,
		permission: ACTION_PERMISSION[opts.action],
		action: `incident.${opts.action}`,
		resourceType: "incident_room",
		resourceId: opts.incidentId,
		detail: opts.detail,
		audit: opts.audit,
		meta: opts.meta
	}, async (ctx, q) => {
		const access = await resolveIncidentAccess(q, ctx, opts.incidentId);
		if (access.relationship !== "origin_admin" && OWNER_ONLY_ACTIONS.includes(opts.action)) throw new AccessError("forbidden");
		if (!incidentLevelAllows(access.relationship, opts.action)) throw new AccessError("forbidden");
		return fn(ctx, q, access);
	});
}
/** Lifecycle audit event carrying prior/new state and the affected target. */
async function auditLifecycle(q, ctx, input) {
	await recordAudit(q, {
		orgId: ctx.orgId,
		actorUserId: ctx.userId,
		action: input.action,
		resourceType: "incident_room",
		resourceId: input.incidentId,
		outcome: "allow",
		detail: {
			actor_org_id: ctx.orgId,
			incident_id: input.incidentId,
			prior_state: input.priorState ?? null,
			new_state: input.newState ?? null,
			target_org_id: input.targetOrgId ?? null,
			participant_id: input.participantId ?? null,
			...input.extra ?? {}
		},
		ipAddress: ctx.meta.ipAddress ?? null,
		correlationId: ctx.meta.correlationId ?? null
	});
}
async function createIncident(token, orgId, input, meta) {
	return withAuthorized({
		token,
		orgId,
		permission: "incident.create",
		action: "incident.create",
		resourceType: "incident_room",
		audit: false,
		meta
	}, async (ctx, q) => {
		const name = text(input.name, "name", 200, true);
		const incidentType = assertOneOf(String(input.incidentType), INCIDENT_TYPES, "incident type");
		const classification = assertOneOf(String(input.classification ?? "restricted"), CLASSIFICATIONS, "classification");
		const shareRule = assertOneOf(String(input.defaultShareRule ?? "no_sharing"), SHARE_RULES, "share rule");
		const retention = Number(input.tempDataRetentionHours ?? 72);
		if (!Number.isInteger(retention) || retention < 1 || retention > 8760) throw new AccessError("invalid_input", "invalid retention window");
		const incident = (await q.query(`INSERT INTO airs.incident_rooms
           (org_id, name, incident_type, description, external_number, geographic_description,
            classification, default_share_rule, temp_data_retention_hours,
            scheduled_start_at, scheduled_expires_at, created_by_account, updated_by_account)
         VALUES ($1,$2,$3,coalesce($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING ${ROOM_COLUMNS.replace(/r\./g, "")}`, [
			ctx.orgId,
			name,
			incidentType,
			text(input.description, "description", 4e3),
			text(input.externalNumber, "external number", 120),
			text(input.geographicDescription, "geographic description", 500),
			classification,
			shareRule,
			retention,
			timestamp(input.scheduledStartAt, "scheduled start"),
			timestamp(input.scheduledExpiresAt, "scheduled expiration"),
			ctx.accountId
		]))[0];
		await auditLifecycle(q, ctx, {
			action: "incident.created",
			incidentId: incident.id,
			newState: incident.status,
			extra: {
				incident_type: incidentType,
				classification
			}
		});
		return incident;
	});
}
async function readIncident(token, orgId, incidentId, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "read",
		meta,
		audit: false
	}, async (_ctx, _q, access) => access);
}
//#endregion
//#region scripts/prepare-anconison-exercise.ts
const names = [
	"Anconison Agency",
	"Blue Ridge Rescue",
	"Mountain Air Support",
	"Piedmont UAS",
	"Foothills Logistics",
	"Valley Medical",
	"Ridge Communications"
];
const key = "anconison-helene-2024";
const id = (label) => {
	const h = createHash("sha256").update("anconison-helene-2024:" + label).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
const sessionHashes = [];
const roomName = "EXERCISE ONLY — Anconison Helene coordination gauntlet";
async function membership(orgId, accountId, email, name, role) {
	const userId = id("user:" + orgId + ":" + email);
	await owner.query(`INSERT INTO airs.users(id,org_id,account_id,email_address,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
		userId,
		orgId,
		accountId,
		email,
		name
	]);
	const existing = await owner.query("SELECT id FROM airs.users WHERE org_id=$1 AND account_id=$2", [orgId, accountId]);
	if (existing.rows.length !== 1) throw Error("Fixture user conflict");
	const user = existing.rows[0].id;
	await owner.query(`INSERT INTO airs.memberships(org_id,account_id,user_id,role_key,status,activated_at) VALUES($1,$2,$3,$4,'active',now()) ON CONFLICT DO NOTHING`, [
		orgId,
		accountId,
		user,
		role
	]);
	const check = await owner.query("SELECT role_key,status FROM airs.memberships WHERE org_id=$1 AND account_id=$2", [orgId, accountId]);
	if (check.rows[0]?.role_key !== role || check.rows[0]?.status !== "active") throw Error("Existing fixture membership differs; manual review required");
	await owner.query("INSERT INTO airs.user_roles(org_id,user_id,role_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [
		orgId,
		user,
		role
	]);
}
async function main() {
	if (process.env.AIRS_EXERCISE_PREPARE !== "anconison-simulated-only") throw Error("Explicit exercise prepare flag required");
	if (!process.env.APP_DB_PASSWORD) throw Error("Application database credential missing");
	await owner.connect();
	await owner.query("BEGIN");
	await owner.query("SELECT pg_advisory_xact_lock(hashtext('airs-anconison-exercise-prepare'))");
	const observer = (await owner.query("SELECT a.id FROM airs.accounts a WHERE lower(a.email)='admin@airsagent.com' AND a.status='active' AND EXISTS(SELECT 1 FROM airs.memberships m JOIN airs.organizations o ON o.id=m.org_id WHERE m.account_id=a.id AND m.status='active' AND o.org_kind='platform')")).rows[0];
	if (!observer) throw Error("Verified platform administrator is required");
	for (const [i, name] of names.entries()) {
		const orgId = id("org:" + i), slug = `exercise-helene-${i}`;
		await owner.query("INSERT INTO airs.organizations(id,slug,name,agency_type) VALUES($1,$2,$3,'other') ON CONFLICT DO NOTHING", [
			orgId,
			slug,
			name + " — Exercise"
		]);
		const check = (await owner.query("SELECT id,name FROM airs.organizations WHERE slug=$1", [slug])).rows[0];
		if (check?.id !== orgId || check?.name !== name + " — Exercise") throw Error("Exercise organization collision");
		await owner.query("INSERT INTO airs.retention_policies(org_id) VALUES($1) ON CONFLICT DO NOTHING", [orgId]);
		const email = `helene-${i}@simulation.invalid`, accountId = id("account:" + i);
		await owner.query("INSERT INTO airs.accounts(id,email,display_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [
			accountId,
			email,
			name + " simulated controller"
		]);
		await membership(orgId, accountId, email, name + " simulated controller", "incident_commander");
	}
	await membership(id("org:0"), observer.id, "admin@airsagent.com", "Anconison exercise observer", "incident_commander");
	await owner.query(`INSERT INTO airs.audit_events(org_id,action,resource_type,outcome,detail) VALUES($1,'exercise.fixtures_prepared','exercise','allow',$2::jsonb)`, [id("org:0"), JSON.stringify({
		exercise: key,
		simulatedAgencies: 7,
		externalDelivery: false,
		observerRole: "incident_commander",
		started: false
	})]);
	await owner.query("COMMIT");
	const token = randomBytes(32).toString("base64url"), hash = createHash("sha256").update(token).digest("hex");
	sessionHashes.push(hash);
	await owner.query("INSERT INTO airs.sessions(account_id,token_hash,active_org_id,expires_at,user_agent) VALUES($1,$2,$3,now()+interval '15 minutes','AIRS exercise fixture controller: simulated authentication')", [
		id("account:0"),
		hash,
		id("org:0")
	]);
	const appUrl = new URL(process.env.DATABASE_URL);
	appUrl.username = "airs_app";
	process.env.DATABASE_URL = appUrl.toString();
	process.env.PGPASSWORD = process.env.APP_DB_PASSWORD;
	process.env.AUTH_DRIVER = "local";
	const role = await getDatabase().withContext({}, (q) => q.query("SELECT current_user,rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user"));
	if (role[0].current_user !== "airs_app" || role[0].rolbypassrls || role[0].rolsuper) throw Error("Exercise must use restricted application role");
	const existing = (await owner.query("SELECT id FROM airs.incident_rooms WHERE org_id=$1 AND name=$2", [id("org:0"), roomName])).rows;
	if (existing.length > 1) throw Error("Duplicate exercise incident");
	const meta = { userAgent: "AIRS EXERCISE preparation — simulated controller, no external delivery" };
	const room = existing.length ? (await readIncident(token, id("org:0"), existing[0].id, meta)).incident : await createIncident(token, id("org:0"), {
		name: roomName,
		incidentType: "training",
		classification: "restricted",
		defaultShareRule: "no_sharing",
		description: "EXERCISE ONLY. Historical context: Hurricane Helene, western North Carolina, September–October 2024. All participating agencies and activity are simulated. No real emergency response. Prepared and waiting for observer; scenario has not started.",
		geographicDescription: "Western North Carolina — historical Helene exercise context",
		tempDataRetentionHours: 24
	}, meta);
	if (room.status !== "draft") throw Error("Exercise already progressed; refusing to restart");
	console.log("AIRS_EXERCISE_PREPARED:" + JSON.stringify({
		incidentId: room.id,
		observerOrgId: id("org:0"),
		agencies: names.map((name, i) => ({
			id: id("org:" + i),
			name: name + " — Exercise"
		})),
		status: room.status,
		started: false,
		observerUrl: `https://app.airsagent.com/incidents/${room.id}/command`
	}));
}
try {
	await main();
} catch (e) {
	await owner.query("ROLLBACK").catch(() => {});
	console.error("Exercise preparation failed:", e instanceof Error ? e.message : "unknown");
	process.exitCode = 1;
} finally {
	for (const hash of sessionHashes) await owner.query("UPDATE airs.sessions SET revoked_at=now() WHERE token_hash=$1", [hash]).catch(() => {});
	await getDatabase().close().catch(() => {});
	await owner.end().catch(() => {});
}
//#endregion
export {};
