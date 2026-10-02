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
const UUID$5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
			if (!UUID$5.test(ctx.orgId) || !UUID$5.test(ctx.userId)) throw new Error("withTenant requires valid uuid orgId and userId");
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
function isAccessError(value) {
	return value instanceof AccessError;
}
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
const UUID$4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
	if (!UUID$4.test(orgId)) throw new AccessError("invalid_input");
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
const CLASSIFICATIONS$1 = [
	"public",
	"restricted",
	"sensitive"
];
const SHARE_RULES = [
	"no_sharing",
	"view_only",
	"operational"
];
/** The only transitions the server will ever perform. Everything else denies. */
const ALLOWED_TRANSITIONS = {
	draft: [
		"scheduled",
		"active",
		"closed"
	],
	scheduled: ["active", "closed"],
	active: [
		"paused",
		"closing",
		"closed"
	],
	paused: [
		"active",
		"closing",
		"closed"
	],
	closing: ["closed"],
	closed: ["archived"],
	archived: []
};
function canTransition(from, to) {
	return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
/** Statuses in which owner metadata edits are still accepted. */
const EDITABLE_STATUSES = [
	"draft",
	"scheduled",
	"active",
	"paused"
];
const ACCESS_LEVELS = [
	"view_only",
	"operational",
	"incident_command"
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
const UUID$3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertUuid$2(value, label) {
	if (!UUID$3.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function assertOneOf$1(value, allowed, label) {
	if (!allowed.includes(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function text$2(value, label, max, required = false) {
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
/**
* Resolves the acting organization's relationship to an incident room.
* RLS already hides rooms the organization may not see; this adds the explicit
* relationship + liveness check so a denial is auditable rather than an empty
* result, and so a restricted participant is demoted to view-only.
*/
async function resolveIncidentAccess(q, ctx, incidentId) {
	assertUuid$2(incidentId, "incident id");
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
async function updateIncident(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "update",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if (!EDITABLE_STATUSES.includes(incident.status)) throw new AccessError("incident_state_invalid");
		if (Number(input.expectedVersion) !== incident.version) throw new AccessError("incident_stale_version");
		const next = {
			name: input.name == null ? incident.name : text$2(input.name, "name", 200, true),
			description: input.description == null ? incident.description : text$2(input.description, "description", 4e3) ?? "",
			externalNumber: input.externalNumber === void 0 ? incident.externalNumber : text$2(input.externalNumber, "external number", 120),
			geographicDescription: input.geographicDescription === void 0 ? incident.geographicDescription : text$2(input.geographicDescription, "geographic description", 500),
			classification: input.classification == null ? incident.classification : assertOneOf$1(String(input.classification), CLASSIFICATIONS$1, "classification"),
			defaultShareRule: input.defaultShareRule == null ? incident.defaultShareRule : assertOneOf$1(String(input.defaultShareRule), SHARE_RULES, "share rule"),
			tempDataRetentionHours: input.tempDataRetentionHours == null ? incident.tempDataRetentionHours : Number(input.tempDataRetentionHours)
		};
		if (!Number.isInteger(next.tempDataRetentionHours) || next.tempDataRetentionHours < 1 || next.tempDataRetentionHours > 8760) throw new AccessError("invalid_input", "invalid retention window");
		const updated = (await q.query(`UPDATE airs.incident_rooms r
            SET name = $2, description = $3, external_number = $4, geographic_description = $5,
                classification = $6, default_share_rule = $7, temp_data_retention_hours = $8,
                updated_by_account = $9, updated_at = now(), version = version + 1
          WHERE r.id = $1 AND r.version = $10
        RETURNING ${ROOM_COLUMNS}`, [
			incidentId,
			next.name,
			next.description,
			next.externalNumber,
			next.geographicDescription,
			next.classification,
			next.defaultShareRule,
			next.tempDataRetentionHours,
			ctx.accountId,
			incident.version
		]))[0];
		if (!updated) throw new AccessError("incident_stale_version");
		await auditLifecycle(q, ctx, {
			action: "incident.updated",
			incidentId,
			priorState: incident.status,
			newState: updated.status,
			extra: {
				from_version: incident.version,
				to_version: updated.version
			}
		});
		return updated;
	});
}
async function transition(ctx, q, incident, to, auditAction, extraSql = "", extraParams = [], extra) {
	if (!canTransition(incident.status, to)) {
		await recordAudit(q, {
			orgId: ctx.orgId,
			actorUserId: ctx.userId,
			action: "incident.invalid_transition",
			resourceType: "incident_room",
			resourceId: incident.id,
			outcome: "deny",
			detail: {
				prior_state: incident.status,
				new_state: to,
				actor_org_id: ctx.orgId
			},
			ipAddress: ctx.meta.ipAddress ?? null,
			correlationId: ctx.meta.correlationId ?? null
		});
		throw new AccessError("incident_state_invalid");
	}
	const updated = (await q.query(`UPDATE airs.incident_rooms r
        SET status = $2, updated_by_account = $3, updated_at = now(), version = version + 1
            ${extraSql}
      WHERE r.id = $1 AND r.version = $4
    RETURNING ${ROOM_COLUMNS}`, [
		incident.id,
		to,
		ctx.accountId,
		incident.version,
		...extraParams
	]))[0];
	if (!updated) throw new AccessError("incident_stale_version");
	await auditLifecycle(q, ctx, {
		action: auditAction,
		incidentId: incident.id,
		priorState: incident.status,
		newState: to,
		extra
	});
	return updated;
}
async function activateIncident(token, orgId, incidentId, expectedVersion, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "activate",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if (Number(expectedVersion) !== incident.version) throw new AccessError("incident_stale_version");
		const hours = incident.tempDataRetentionHours;
		return transition(ctx, q, incident, "active", "incident.activated", `, activated_at = coalesce(activated_at, now()),
           temp_data_expires_at = coalesce(temp_data_expires_at, now() + ($5 || ' hours')::interval)`, [String(hours)]);
	});
}
async function pauseIncident(token, orgId, incidentId, expectedVersion, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "pause",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if (Number(expectedVersion) !== incident.version) throw new AccessError("incident_stale_version");
		return transition(ctx, q, incident, "paused", "incident.paused");
	});
}
async function beginClosure(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "begin_closure",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if (Number(input.expectedVersion) !== incident.version) throw new AccessError("incident_stale_version");
		const reason = text$2(input.reason, "closure reason", 1e3, true);
		const room = await transition(ctx, q, incident, "closing", "incident.closure_started", ", closing_started_at = now(), closure_reason = $5", [reason], { closure_reason: reason });
		const expired = await q.query(`UPDATE airs.incident_participants
            SET invitation_status = 'expired', participation_status = 'expired',
                token_hash = NULL, updated_at = now()
          WHERE incident_id = $1 AND invitation_status = 'pending'
        RETURNING id, partner_org_id AS partner`, [incidentId]);
		for (const row of expired) await auditLifecycle(q, ctx, {
			action: "incident.invitation_expired",
			incidentId,
			targetOrgId: row.partner,
			participantId: row.id,
			priorState: "pending",
			newState: "expired"
		});
		return room;
	});
}
async function closeIncident(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "close",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if (Number(input.expectedVersion) !== incident.version) throw new AccessError("incident_stale_version");
		const reason = text$2(input.reason, "closure reason", 1e3) ?? incident.closureReason ?? null;
		if (!reason) throw new AccessError("invalid_input", "closure reason is required");
		const revoked = await q.query(`UPDATE airs.incident_participants
            SET participation_status = 'revoked', revoked_at = now(),
                token_hash = NULL, reason = coalesce(reason, 'incident closed'),
                updated_at = now()
          WHERE incident_id = $1
            AND participation_status IN ('active','restricted','suspended','pending_approval','invited')
        RETURNING id, partner_org_id AS partner, participation_status AS prior`, [incidentId]);
		const expired = await q.query(`UPDATE airs.incident_participants
            SET invitation_status = 'expired', token_hash = NULL, updated_at = now()
          WHERE incident_id = $1 AND invitation_status = 'pending'
        RETURNING id, partner_org_id AS partner`, [incidentId]);
		const geo = (await q.query(`SELECT * FROM airs.terminate_incident_geography($1)`, [incidentId]))[0] ?? {
			areas_completed: 0,
			features_archived: 0,
			positions_expired: 0
		};
		const obs = (await q.query(`SELECT * FROM airs.terminate_incident_observations($1)`, [incidentId]))[0] ?? {
			shares_revoked: 0,
			observations_closed: 0
		};
		const room = await transition(ctx, q, incident, "closed", "incident.closed", `, closed_at = now(), closure_reason = $5, closed_by_account = $3,
           temp_data_expires_at = now() + (temp_data_retention_hours || ' hours')::interval`, [reason], {
			closure_reason: reason,
			revoked_participants: revoked.length,
			expired_invitations: expired.length,
			operating_areas_completed: Number(geo.areas_completed),
			map_features_archived: Number(geo.features_archived),
			positions_expired: Number(geo.positions_expired),
			observation_shares_revoked: Number(obs.shares_revoked),
			observations_closed: Number(obs.observations_closed)
		});
		for (const row of revoked) await auditLifecycle(q, ctx, {
			action: "incident.participant_revoked",
			incidentId,
			targetOrgId: row.partner,
			participantId: row.id,
			priorState: row.prior,
			newState: "revoked",
			extra: { cause: "incident_closed" }
		});
		return room;
	});
}
async function readIncidentAudit(token, orgId, incidentId, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "read_audit",
		meta,
		audit: false
	}, async (_ctx, q) => q.query(`SELECT a.id::text AS id, a.action, a.outcome,
                to_json(a.occurred_at)#>>'{}' AS "occurredAt",
                a.actor_user_id AS "actorUserId", u.display_name AS "actorName",
                a.detail::text AS detail
           FROM airs.audit_events a
           LEFT JOIN airs.users u ON u.id = a.actor_user_id
          WHERE a.resource_type = 'incident_room' AND a.resource_id = $1
          ORDER BY a.occurred_at DESC, a.id DESC
          LIMIT 200`, [incidentId]));
}
//#endregion
//#region src/lib/incidents/trust.server.ts
/** Throws unless an approved relationship makes the partner eligible. */
async function assertInvitationEligibility(q, orgId, partnerOrgId) {
	if (((await q.query(`SELECT status FROM airs.trusted_agencies WHERE org_id = $1 AND partner_org_id = $2`, [orgId, partnerOrgId]))[0]?.status ?? null) !== "approved") throw new AccessError("partner_not_eligible");
	return "trusted";
}
//#endregion
//#region src/lib/incidents/participation.server.ts
const P = `
  p.id, p.incident_id AS "incidentId", p.org_id AS "orgId",
  p.partner_org_id AS "partnerOrgId", airs.related_org_name(p.partner_org_id) AS "partnerOrgName",
  p.invitation_status AS "invitationStatus", p.participation_status AS "participationStatus",
  p.access_level AS "accessLevel", p.requires_approval AS "requiresApproval",
  to_json(p.invited_at)#>>'{}' AS "invitedAt",
  to_json(p.invitation_expires_at)#>>'{}' AS "invitationExpiresAt",
  to_json(p.accepted_at)#>>'{}' AS "acceptedAt",
  to_json(p.approved_at)#>>'{}' AS "approvedAt",
  to_json(p.expires_at)#>>'{}' AS "expiresAt",
  to_json(p.restricted_at)#>>'{}' AS "restrictedAt",
  to_json(p.revoked_at)#>>'{}' AS "revokedAt",
  to_json(p.removed_at)#>>'{}' AS "removedAt",
  p.reason
`;
const UUID$2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuidOrThrow(value, label) {
	if (!UUID$2.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function futureTimestamp(value, label) {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new AccessError("invalid_input", `invalid ${label}`);
	const iso = new Date(value).toISOString();
	if (Date.parse(iso) <= Date.now()) throw new AccessError("invalid_input", `${label} is in the past`);
	return iso;
}
async function listParticipants(token, orgId, incidentId, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "view_participants",
		meta,
		audit: false
	}, async (_ctx, q) => q.query(`SELECT ${P} FROM airs.incident_participants p
          WHERE p.incident_id = $1 ORDER BY p.invited_at`, [incidentId]));
}
async function invitePartner(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: "invite_partner",
		meta,
		audit: false
	}, async (ctx, q, { incident }) => {
		if ([
			"closing",
			"closed",
			"archived"
		].includes(incident.status)) throw new AccessError("incident_state_invalid");
		const partnerOrgId = uuidOrThrow(input.partnerOrgId, "partner organization");
		if (partnerOrgId === ctx.orgId) throw new AccessError("invalid_input", "self invitation");
		const accessLevel = input.accessLevel;
		if (!ACCESS_LEVELS.includes(accessLevel)) throw new AccessError("invalid_input", "unknown access level");
		const invitationExpiresAt = futureTimestamp(input.invitationExpiresAt, "invitation expiration");
		const participationExpiresAt = input.participationExpiresAt ? futureTimestamp(input.participationExpiresAt, "participation expiration") : null;
		const eligibility = await assertInvitationEligibility(q, ctx.orgId, partnerOrgId);
		const raw = randomToken(32);
		const tokenHash = await hashToken(raw);
		const participant = (await q.query(`INSERT INTO airs.incident_participants
           (incident_id, org_id, partner_org_id, access_level, requires_approval, token_hash,
            invited_by_org_id, invited_by_user, invitation_expires_at, expires_at, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$2,$7,$8,$9,$10)
         ON CONFLICT (incident_id, partner_org_id) DO UPDATE
            SET access_level = EXCLUDED.access_level,
                requires_approval = EXCLUDED.requires_approval,
                token_hash = EXCLUDED.token_hash,
                invitation_status = 'pending',
                participation_status = 'invited',
                invited_by_user = EXCLUDED.invited_by_user,
                invited_at = now(),
                invitation_expires_at = EXCLUDED.invitation_expires_at,
                expires_at = EXCLUDED.expires_at,
                accepted_at = NULL, approved_at = NULL, revoked_at = NULL,
                removed_at = NULL, restricted_at = NULL,
                reason = EXCLUDED.reason, updated_at = now()
          WHERE airs.incident_participants.participation_status <> 'removed'
         RETURNING ${P.replace(/p\./g, "airs.incident_participants.")}`, [
			incidentId,
			ctx.orgId,
			partnerOrgId,
			accessLevel,
			input.requiresApproval !== false,
			tokenHash,
			ctx.userId,
			invitationExpiresAt,
			participationExpiresAt,
			input.reason ?? null
		]))[0];
		if (!participant) throw new AccessError("incident_state_invalid");
		await recordAudit(q, {
			orgId: ctx.orgId,
			actorUserId: ctx.userId,
			action: "incident.partner_invited",
			resourceType: "incident_room",
			resourceId: incidentId,
			outcome: "allow",
			detail: {
				actor_org_id: ctx.orgId,
				target_org_id: partnerOrgId,
				participant_id: participant.id,
				access_level: accessLevel,
				eligibility,
				prior_state: null,
				new_state: "invited"
			},
			ipAddress: meta.ipAddress ?? null,
			correlationId: meta.correlationId ?? null
		});
		return {
			participant,
			invitationToken: raw
		};
	});
}
const OWNER_ACTION_MAP = {
	revoke_invitation: {
		incidentAction: "invite_partner",
		audit: "incident.invitation_revoked"
	},
	approve_partner: {
		incidentAction: "approve_partner",
		audit: "incident.participant_approved"
	},
	restrict_partner: {
		incidentAction: "restrict_partner",
		audit: "incident.participant_restricted"
	},
	revoke_partner: {
		incidentAction: "revoke_partner",
		audit: "incident.participant_revoked"
	},
	remove_partner: {
		incidentAction: "remove_partner",
		audit: "incident.participant_removed"
	}
};
async function ownerParticipantAction(token, orgId, incidentId, participantId, action, meta, reason) {
	const mapped = OWNER_ACTION_MAP[action];
	if (!mapped) throw new AccessError("invalid_input", "unknown participant action");
	return withIncidentAction({
		token,
		orgId,
		incidentId,
		action: mapped.incidentAction,
		meta,
		audit: false
	}, async (ctx, q) => {
		uuidOrThrow(participantId, "participant id");
		const row = (await q.query(`SELECT p.id, p.partner_org_id AS "partnerOrgId",
                p.invitation_status AS "invitationStatus",
                p.participation_status AS "participationStatus",
                p.requires_approval AS "requiresApproval"
           FROM airs.incident_participants p
          WHERE p.id = $1 AND p.incident_id = $2 AND p.org_id = $3`, [
			participantId,
			incidentId,
			ctx.orgId
		]))[0];
		if (!row) throw new AccessError("incident_not_found");
		let sql;
		const params = [participantId];
		switch (action) {
			case "revoke_invitation":
				if (row.invitationStatus !== "pending") throw new AccessError("incident_state_invalid");
				sql = `SET invitation_status = 'revoked', participation_status = 'revoked',
                     token_hash = NULL, revoked_at = now(), reason = $2, updated_at = now()`;
				params.push(reason ?? null);
				break;
			case "approve_partner":
				if (row.participationStatus !== "pending_approval") throw new AccessError("incident_state_invalid");
				sql = `SET participation_status = 'active', approved_at = now(),
                     approved_by_user = $2, updated_at = now()`;
				params.push(ctx.userId);
				break;
			case "restrict_partner":
				if (!["active", "restricted"].includes(row.participationStatus)) throw new AccessError("incident_state_invalid");
				sql = `SET participation_status = 'restricted', restricted_at = now(),
                     reason = $2, updated_at = now()`;
				params.push(reason ?? null);
				break;
			case "revoke_partner":
				if (["revoked", "removed"].includes(row.participationStatus)) throw new AccessError("incident_state_invalid");
				sql = `SET participation_status = 'revoked', invitation_status =
                       CASE WHEN invitation_status = 'pending' THEN 'revoked' ELSE invitation_status END,
                     revoked_at = now(), token_hash = NULL, reason = $2, updated_at = now()`;
				params.push(reason ?? null);
				break;
			default:
				sql = `SET participation_status = 'removed', removed_at = now(),
                     revoked_at = coalesce(revoked_at, now()), token_hash = NULL,
                     reason = $2, updated_at = now()`;
				params.push(reason ?? null);
		}
		const result = (await q.query(`UPDATE airs.incident_participants p ${sql} WHERE p.id = $1 RETURNING ${P}`, params))[0];
		await recordAudit(q, {
			orgId: ctx.orgId,
			actorUserId: ctx.userId,
			action: mapped.audit,
			resourceType: "incident_room",
			resourceId: incidentId,
			outcome: "allow",
			detail: {
				actor_org_id: ctx.orgId,
				target_org_id: row.partnerOrgId,
				participant_id: participantId,
				prior_state: row.participationStatus,
				new_state: result.participationStatus,
				reason: reason ?? null
			},
			ipAddress: meta.ipAddress ?? null,
			correlationId: meta.correlationId ?? null
		});
		return result;
	});
}
async function listPendingInvitations(token, orgId, meta) {
	return withAuthorized({
		token,
		orgId,
		permission: "incident.read",
		action: "incident.list_invitations",
		resourceType: "incident_participant",
		audit: false,
		meta
	}, async (_ctx, q) => q.query(`SELECT participant_id AS "participantId", incident_id AS "incidentId",
                incident_name AS "incidentName", incident_type AS "incidentType",
                incident_status AS "incidentStatus", owner_org_id AS "ownerOrgId",
                owner_org_name AS "ownerOrgName", access_level AS "accessLevel",
                requires_approval AS "requiresApproval",
                to_json(invited_at)#>>'{}' AS "invitedAt",
                to_json(invitation_expires_at)#>>'{}' AS "invitationExpiresAt",
                to_json(expires_at)#>>'{}' AS "expiresAt"
           FROM airs.pending_incident_invitations()
          ORDER BY invited_at DESC`));
}
const PARTNER_AUDIT = {
	accept: "incident.invitation_accepted",
	decline: "incident.invitation_declined",
	withdraw: "incident.participant_withdrew"
};
/**
* Partner-side participation change. The acting organization may only touch a
* row that names it as the partner; the assigned incident, access level and
* expirations are never read from the request.
*/
async function partnerParticipationAction(token, orgId, participantId, action, meta) {
	return withAuthorized({
		token,
		orgId,
		permission: "incident.read",
		action: `incident.${action}`,
		resourceType: "incident_participant",
		resourceId: participantId,
		audit: false,
		meta
	}, async (ctx, q) => {
		uuidOrThrow(participantId, "participant id");
		const row = (await q.query(`SELECT p.id, p.incident_id AS "incidentId", p.org_id AS "orgId",
                p.invitation_status AS "invitationStatus",
                p.participation_status AS "participationStatus",
                p.requires_approval AS "requiresApproval",
                (p.invitation_expires_at <= now()) AS expired
           FROM airs.incident_participants p
          WHERE p.id = $1 AND p.partner_org_id = $2`, [participantId, ctx.orgId]))[0];
		if (!row) throw new AccessError("forbidden");
		let sql;
		let newStatus;
		if (action === "accept") {
			if (row.invitationStatus !== "pending") throw new AccessError("participation_inactive");
			if (row.expired) throw new AccessError("participation_inactive");
			newStatus = row.requiresApproval ? "pending_approval" : "active";
			sql = `SET invitation_status = 'accepted', participation_status = $3,
                   accepted_at = now(), accepted_by_user = $4,
                   approved_at = CASE WHEN $3 = 'active' THEN now() ELSE NULL END,
                   updated_at = now()`;
		} else if (action === "decline") {
			if (row.invitationStatus !== "pending") throw new AccessError("participation_inactive");
			newStatus = "declined";
			sql = `SET invitation_status = 'declined', participation_status = $3,
                   updated_at = now()`;
		} else {
			if (![
				"active",
				"restricted",
				"pending_approval"
			].includes(row.participationStatus)) throw new AccessError("participation_inactive");
			newStatus = "removed";
			sql = `SET participation_status = $3, removed_at = now(), updated_at = now()`;
		}
		const params = [
			participantId,
			ctx.orgId,
			newStatus
		];
		if (action === "accept") params.push(ctx.userId);
		const updated = await q.query(`UPDATE airs.incident_participants p ${sql}
          WHERE p.id = $1 AND p.partner_org_id = $2
        RETURNING p.participation_status AS "participationStatus"`, params);
		if (!updated[0]) throw new AccessError("forbidden");
		await recordAudit(q, {
			orgId: ctx.orgId,
			actorUserId: ctx.userId,
			action: PARTNER_AUDIT[action],
			resourceType: "incident_room",
			resourceId: row.incidentId,
			outcome: "allow",
			detail: {
				actor_org_id: ctx.orgId,
				target_org_id: ctx.orgId,
				owner_org_id: row.orgId,
				participant_id: participantId,
				prior_state: row.participationStatus,
				new_state: updated[0].participationStatus
			},
			ipAddress: meta.ipAddress ?? null,
			correlationId: meta.correlationId ?? null
		});
		return {
			participantId,
			participationStatus: updated[0].participationStatus,
			incidentId: row.incidentId
		};
	});
}
//#endregion
//#region src/lib/incidents/ics.server.ts
const ICS_COMMAND_MODES = ["single", "unified"];
const ICS_OPERATIONAL_CONDITIONS = [
	"nominal",
	"elevated",
	"emergency",
	"recovery"
];
const RESOURCE_REQUEST_KINDS = [
	"personnel",
	"law_enforcement",
	"fire_ems",
	"aviation",
	"uas",
	"counter_uas",
	"communications",
	"public_works",
	"medical",
	"logistics",
	"specialty_team",
	"other"
];
const RESOURCE_REQUEST_PRIORITIES = [
	"immediate",
	"high",
	"routine"
];
const RESOURCE_REQUEST_STATUSES = [
	"draft",
	"requested",
	"acknowledged",
	"partially_filled",
	"filled",
	"denied",
	"cancelled"
];
const UUID$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text$1 = (value, label, max, required = false) => {
	if (value == null || value === "") {
		if (required) throw new AccessError("invalid_input", `${label} is required`);
		return "";
	}
	if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
	const v = value.trim();
	if (required && !v) throw new AccessError("invalid_input", `${label} is required`);
	if (v.length > max) throw new AccessError("invalid_input", `${label} is too long`);
	return v;
};
const oneOf = (value, allowed, label) => {
	if (!allowed.includes(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
};
const maybeTime = (value, label) => {
	if (!value) return null;
	if (Number.isNaN(Date.parse(value))) throw new AccessError("invalid_input", `invalid ${label}`);
	return new Date(value).toISOString();
};
const assertUuid$1 = (value, label) => {
	if (!UUID$1.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
};
async function audit(q, ctx, incidentId, action, detail) {
	await recordAudit(q, {
		orgId: ctx.orgId,
		actorUserId: ctx.userId,
		action,
		resourceType: "incident_room",
		resourceId: incidentId,
		outcome: "allow",
		detail,
		ipAddress: ctx.meta.ipAddress ?? null,
		correlationId: ctx.meta.correlationId ?? null
	});
}
async function saveIcsProfile(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId: assertUuid$1(incidentId, "incident id"),
		action: "update",
		meta,
		audit: false
	}, async (ctx, q, access) => {
		const mode = oneOf(input.commandMode, ICS_COMMAND_MODES, "command mode");
		const operationalCondition = oneOf(input.operationalCondition ?? "nominal", ICS_OPERATIONAL_CONDITIONS, "operational condition");
		const start = maybeTime(input.operationalPeriodStart, "operational period start");
		const end = maybeTime(input.operationalPeriodEnd, "operational period end");
		if (start && end && Date.parse(end) <= Date.parse(start)) throw new AccessError("invalid_input", "operational period end must follow start");
		const rows = await q.query(`INSERT INTO airs.incident_ics_profiles
        (incident_id, org_id, command_mode, incident_commander, command_post_name, command_post_description,
         operational_period_start, operational_period_end, situation_summary, safety_message, operational_condition, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        ON CONFLICT (incident_id) DO UPDATE SET command_mode=EXCLUDED.command_mode,
          incident_commander=EXCLUDED.incident_commander, command_post_name=EXCLUDED.command_post_name,
          command_post_description=EXCLUDED.command_post_description, operational_period_start=EXCLUDED.operational_period_start,
          operational_period_end=EXCLUDED.operational_period_end, situation_summary=EXCLUDED.situation_summary,
          safety_message=EXCLUDED.safety_message, operational_condition=EXCLUDED.operational_condition, updated_by_account=EXCLUDED.updated_by_account,
          version=airs.incident_ics_profiles.version+1
        RETURNING incident_id AS "incidentId", command_mode AS "commandMode", incident_commander AS "incidentCommander",
          command_post_name AS "commandPostName", command_post_description AS "commandPostDescription",
          to_json(operational_period_start)#>>'{}' AS "operationalPeriodStart", to_json(operational_period_end)#>>'{}' AS "operationalPeriodEnd",
          situation_summary AS "situationSummary", safety_message AS "safetyMessage", operational_condition AS "operationalCondition", version, to_json(updated_at)#>>'{}' AS "updatedAt"`, [
			incidentId,
			access.incident.orgId,
			mode,
			text$1(input.incidentCommander, "incident commander", 200),
			text$1(input.commandPostName, "command post name", 200),
			text$1(input.commandPostDescription, "command post description", 500),
			start,
			end,
			text$1(input.situationSummary, "situation summary", 4e3),
			text$1(input.safetyMessage, "safety message", 2e3),
			operationalCondition,
			ctx.accountId
		]);
		await audit(q, ctx, incidentId, "incident.ics.profile.update", {
			command_mode: mode,
			operational_condition: operationalCondition
		});
		return rows[0];
	});
}
async function addIcsObjective(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId: assertUuid$1(incidentId, "incident id"),
		action: "update",
		meta,
		audit: false
	}, async (ctx, q, access) => {
		const sequence = Math.max(1, Math.min(999, Math.trunc(input.sequenceNo ?? 1)));
		const rows = await q.query(`INSERT INTO airs.incident_ics_objectives
        (incident_id, org_id, sequence_no, objective, operational_period_label, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$6)
        RETURNING id, incident_id AS "incidentId", sequence_no AS "sequenceNo", objective, status,
          operational_period_label AS "operationalPeriodLabel", to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`, [
			incidentId,
			access.incident.orgId,
			sequence,
			text$1(input.objective, "objective", 1e3, true),
			text$1(input.operationalPeriodLabel, "operational period label", 120) || null,
			ctx.accountId
		]);
		await audit(q, ctx, incidentId, "incident.ics.objective.create", {
			objective_id: rows[0].id,
			sequence_no: sequence
		});
		return rows[0];
	});
}
async function addIncidentResourceRequest(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId: assertUuid$1(incidentId, "incident id"),
		action: "update",
		meta,
		audit: false
	}, async (ctx, q, access) => {
		const kind = oneOf(input.resourceKind, RESOURCE_REQUEST_KINDS, "resource request kind");
		const priority = oneOf(input.priority ?? "routine", RESOURCE_REQUEST_PRIORITIES, "resource request priority");
		const quantity = Math.max(1, Math.min(9999, Math.trunc(input.quantity ?? 1)));
		const requestNumber = `REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
		const rows = await q.query(`INSERT INTO airs.incident_resource_requests
        (incident_id, org_id, request_number, requested_by, requested_from, resource_kind, quantity, description,
         priority, needed_at, staging_location, notes, created_by_account, updated_by_account)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING id, incident_id AS "incidentId", request_number AS "requestNumber", requested_by AS "requestedBy",
          requested_from AS "requestedFrom", resource_kind AS "resourceKind", quantity, description, priority, status,
          to_json(needed_at)#>>'{}' AS "neededAt", staging_location AS "stagingLocation", notes,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`, [
			incidentId,
			access.incident.orgId,
			requestNumber,
			text$1(input.requestedBy, "requested by", 200),
			text$1(input.requestedFrom, "requested from", 200),
			kind,
			quantity,
			text$1(input.description, "request description", 1500, true),
			priority,
			maybeTime(input.neededAt, "needed at"),
			text$1(input.stagingLocation, "staging location", 300),
			text$1(input.notes, "request notes", 1500),
			ctx.accountId
		]);
		await audit(q, ctx, incidentId, "incident.resource_request.create", {
			request_id: rows[0].id,
			request_number: requestNumber,
			resource_kind: kind,
			quantity
		});
		return rows[0];
	});
}
async function setIncidentResourceRequestStatus(token, orgId, incidentId, input, meta) {
	return withIncidentAction({
		token,
		orgId,
		incidentId: assertUuid$1(incidentId, "incident id"),
		action: "update",
		meta,
		audit: false
	}, async (ctx, q) => {
		const status = oneOf(input.status, RESOURCE_REQUEST_STATUSES, "resource request status");
		const rows = await q.query(`UPDATE airs.incident_resource_requests SET status=$3, updated_by_account=$4
        WHERE id=$1 AND incident_id=$2 RETURNING id, incident_id AS "incidentId", request_number AS "requestNumber",
          requested_by AS "requestedBy", requested_from AS "requestedFrom", resource_kind AS "resourceKind", quantity,
          description, priority, status, to_json(needed_at)#>>'{}' AS "neededAt", staging_location AS "stagingLocation", notes,
          to_json(created_at)#>>'{}' AS "createdAt", to_json(updated_at)#>>'{}' AS "updatedAt"`, [
			assertUuid$1(input.requestId, "request id"),
			incidentId,
			status,
			ctx.accountId
		]);
		if (!rows[0]) throw new AccessError("resource_request_not_found");
		await audit(q, ctx, incidentId, "incident.resource_request.status", {
			request_id: input.requestId,
			status
		});
		return rows[0];
	});
}
//#endregion
//#region src/lib/resources/model.ts
const READINESS_STATUSES = [
	"available",
	"assigned",
	"deploying",
	"deployed",
	"airborne",
	"returning",
	"charging",
	"degraded",
	"offline",
	"restricted",
	"inactive",
	"maintenance",
	"unavailable",
	"out_of_service",
	"retired"
];
const SENSOR_STATUSES = [
	"available",
	"assigned",
	"deployed",
	"degraded",
	"offline",
	"maintenance",
	"unavailable",
	"out_of_service",
	"retired"
];
/** Explicit category -> readiness-status validation model. Default deny. */
const CATEGORY_STATUSES = {
	aircraft: [
		"available",
		"assigned",
		"deploying",
		"deployed",
		"airborne",
		"returning",
		"charging",
		"degraded",
		"maintenance",
		"unavailable",
		"out_of_service",
		"retired"
	],
	ground_vehicle: [
		"available",
		"assigned",
		"deploying",
		"deployed",
		"degraded",
		"maintenance",
		"unavailable",
		"out_of_service",
		"retired"
	],
	dock: [
		"available",
		"degraded",
		"offline",
		"maintenance",
		"out_of_service",
		"retired"
	],
	launch_site: [
		"available",
		"restricted",
		"inactive",
		"unavailable",
		"retired"
	],
	portable_trailer: [
		"available",
		"assigned",
		"deploying",
		"deployed",
		"degraded",
		"maintenance",
		"unavailable",
		"out_of_service",
		"retired"
	],
	remote_id_receiver: SENSOR_STATUSES,
	radar: SENSOR_STATUSES,
	rf_detector: SENSOR_STATUSES,
	adsb_receiver: SENSOR_STATUSES,
	weather_station: SENSOR_STATUSES,
	camera: SENSOR_STATUSES,
	counter_uas: SENSOR_STATUSES,
	other: SENSOR_STATUSES
};
function statusAllowedForCategory(category, status) {
	return (CATEGORY_STATUSES[category] ?? []).includes(status);
}
const SHARING_CLASSIFICATIONS = [
	"participating_orgs",
	"public_safety_only",
	"law_enforcement_sensitive",
	"aviation_personnel_only",
	"incident_command_only",
	"originating_org_only",
	"named_recipients"
];
const OPERATIONAL_ROLES = [
	"rpic",
	"visual_observer",
	"airspace_supervisor",
	"dfr_operator",
	"sensor_operator",
	"incident_commander",
	"intel_analyst",
	"counter_uas_operator",
	"dispatcher",
	"other"
];
const ASSIGNMENT_STATUSES = [
	"proposed",
	"assigned",
	"deploying",
	"active",
	"released",
	"cancelled",
	"completed"
];
const ACTIVE_ASSIGNMENT_STATUSES = [
	"proposed",
	"assigned",
	"deploying",
	"active"
];
/** Detail category grouping used by the UI and by the service layer. */
function detailKindFor(category) {
	if (category === "aircraft") return "aircraft";
	if (category === "ground_vehicle" || category === "portable_trailer") return "vehicle";
	if (category === "dock") return "dock";
	if (category === "launch_site") return "launch_site";
	return "sensor";
}
//#endregion
//#region src/lib/resources/disclosure.ts
const DISCLOSURE_PROFILES = [
	"summary",
	"operational",
	"aviation",
	"incident_command",
	"full",
	"custom"
];
/**
* The complete server-controlled field vocabulary. A key that is not in this
* table cannot be disclosed by any profile, custom list, query parameter,
* header or body value — there is no path from a request to a column name.
*/
const FIELD_DEFS = {
	resourceId: {
		source: "resource",
		column: "id"
	},
	displayName: {
		source: "resource",
		column: "displayName"
	},
	category: {
		source: "resource",
		column: "category"
	},
	callsign: {
		source: "resource",
		column: "callsign"
	},
	readinessStatus: {
		source: "resource",
		column: "readinessStatus"
	},
	originatingOrganization: {
		source: "extra",
		column: "ownerOrgName"
	},
	description: {
		source: "resource",
		column: "description"
	},
	operationalStatus: {
		source: "resource",
		column: "operationalStatus"
	},
	lifecycleStatus: {
		source: "resource",
		column: "lifecycleStatus"
	},
	assignmentStatus: {
		source: "extra",
		column: "assignmentStatus"
	},
	currentIncidentRole: {
		source: "extra",
		column: "currentIncidentRole"
	},
	broadAvailability: {
		source: "extra",
		column: "broadAvailability"
	},
	serviceStatus: {
		source: "detail",
		column: "service_status"
	},
	operationalLimitations: {
		source: "detail",
		column: "operational_limitations",
		kinds: ["launch_site"]
	},
	vehicleType: {
		source: "detail",
		column: "vehicle_type",
		kinds: ["vehicle"]
	},
	vehicleIdentifier: {
		source: "detail",
		column: "vehicle_identifier",
		kinds: ["vehicle"]
	},
	assignedUnit: {
		source: "detail",
		column: "assigned_unit",
		kinds: ["vehicle"]
	},
	supportedEquipment: {
		source: "detail",
		column: "supported_equipment",
		kinds: ["vehicle"]
	},
	dockName: {
		source: "detail",
		column: "dock_name",
		kinds: ["dock"]
	},
	connectivityStatus: {
		source: "detail",
		column: "connectivity_status",
		kinds: ["dock", "sensor"]
	},
	powerStatus: {
		source: "detail",
		column: "power_status",
		kinds: ["dock"]
	},
	siteName: {
		source: "detail",
		column: "site_name",
		kinds: ["launch_site"]
	},
	owningOrganizationLabel: {
		source: "detail",
		column: "owning_organization",
		kinds: ["launch_site"]
	},
	supportedCategories: {
		source: "detail",
		column: "supported_categories",
		kinds: ["launch_site"]
	},
	sensorCategory: {
		source: "detail",
		column: "sensor_category",
		kinds: ["sensor"]
	},
	mounting: {
		source: "detail",
		column: "mounting",
		kinds: ["sensor"]
	},
	detectionCategory: {
		source: "detail",
		column: "detection_category",
		kinds: ["sensor"]
	},
	agencyIdentifier: {
		source: "detail",
		column: "agency_identifier",
		kinds: ["sensor"]
	},
	manufacturer: {
		source: "detail",
		column: "manufacturer",
		kinds: [
			"aircraft",
			"dock",
			"sensor"
		]
	},
	model: {
		source: "detail",
		column: "model",
		kinds: [
			"aircraft",
			"dock",
			"sensor"
		]
	},
	aircraftType: {
		source: "detail",
		column: "aircraft_type",
		kinds: ["aircraft"]
	},
	thermalCapable: {
		source: "detail",
		column: "thermal_capable",
		kinds: ["aircraft"]
	},
	parachuteEquipped: {
		source: "detail",
		column: "parachute_equipped",
		kinds: ["aircraft"]
	},
	dockCompatible: {
		source: "detail",
		column: "dock_compatible",
		kinds: ["aircraft"]
	},
	maxApprovedAltitudeFt: {
		source: "detail",
		column: "max_approved_altitude_ft",
		kinds: ["aircraft"]
	},
	supportedAircraftType: {
		source: "detail",
		column: "supported_aircraft_type",
		kinds: ["dock"]
	},
	batteryReadiness: {
		source: "detail",
		column: "battery_readiness",
		kinds: ["aircraft"]
	},
	qualificationType: {
		source: "qualification",
		column: "qualificationType"
	},
	qualificationCurrent: {
		source: "qualification",
		column: "isCurrent"
	},
	locationDescription: {
		source: "detail",
		column: "location_description",
		kinds: ["launch_site"]
	},
	qualificationExpiresOn: {
		source: "qualification",
		column: "expiresOn"
	},
	assignmentWindow: {
		source: "extra",
		column: "assignmentWindow"
	},
	sharedUntil: {
		source: "extra",
		column: "sharedUntil"
	},
	personDisplayName: {
		source: "personnel",
		column: "displayName"
	},
	personCallsign: {
		source: "personnel",
		column: "callsign"
	},
	personAvailabilityStatus: {
		source: "personnel",
		column: "availabilityStatus"
	},
	personOperationalRoles: {
		source: "personnel",
		column: "operationalRoles"
	},
	personOperationalStatus: {
		source: "personnel",
		column: "operationalStatus"
	},
	serialNumber: {
		source: "detail",
		column: "serial_number",
		sensitive: true,
		kinds: ["aircraft"]
	},
	faaRegistration: {
		source: "detail",
		column: "faa_registration",
		sensitive: true,
		kinds: ["aircraft"]
	},
	remoteId: {
		source: "detail",
		column: "remote_id",
		sensitive: true,
		kinds: ["aircraft"]
	},
	restrictedNotes: {
		source: "resource",
		column: "restrictedNotes",
		sensitive: true
	},
	detailRestrictedNotes: {
		source: "detail",
		column: "restricted_notes",
		sensitive: true
	},
	maintenanceStatus: {
		source: "detail",
		column: "maintenance_status",
		sensitive: true,
		kinds: ["aircraft", "sensor"]
	},
	personDutyContact: {
		source: "personnel",
		column: "dutyContact",
		sensitive: true
	},
	personEmployeeIdentifier: {
		source: "personnel",
		column: "employeeIdentifier",
		sensitive: true
	},
	personQualificationSummary: {
		source: "personnel",
		column: "qualificationSummary",
		sensitive: true
	},
	qualificationRestrictions: {
		source: "qualification",
		column: "restrictions",
		sensitive: true
	},
	qualificationIssuer: {
		source: "qualification",
		column: "issuingOrganization",
		sensitive: true
	},
	qualificationVerification: {
		source: "qualification",
		column: "verificationStatus",
		sensitive: true
	}
};
const FIELD_KEYS = Object.keys(FIELD_DEFS);
/** Widened view of the literal table above, for lookup by key. */
const FIELD_DEF = FIELD_DEFS;
FIELD_KEYS.filter((k) => FIELD_DEF[k].sensitive === true);
const SUMMARY = [
	"resourceId",
	"displayName",
	"category",
	"callsign",
	"readinessStatus",
	"originatingOrganization",
	"personDisplayName",
	"personCallsign",
	"personAvailabilityStatus"
];
const OPERATIONAL_ADDS = [
	"description",
	"operationalStatus",
	"lifecycleStatus",
	"assignmentStatus",
	"currentIncidentRole",
	"broadAvailability",
	"serviceStatus",
	"operationalLimitations",
	"vehicleType",
	"vehicleIdentifier",
	"assignedUnit",
	"supportedEquipment",
	"dockName",
	"connectivityStatus",
	"powerStatus",
	"siteName",
	"owningOrganizationLabel",
	"supportedCategories",
	"sensorCategory",
	"mounting",
	"detectionCategory",
	"agencyIdentifier",
	"personOperationalRoles",
	"personOperationalStatus"
];
const AVIATION_ADDS = [
	"manufacturer",
	"model",
	"aircraftType",
	"thermalCapable",
	"parachuteEquipped",
	"dockCompatible",
	"maxApprovedAltitudeFt",
	"supportedAircraftType",
	"batteryReadiness",
	"qualificationType",
	"qualificationCurrent"
];
const INCIDENT_COMMAND_ADDS = [
	"locationDescription",
	"qualificationExpiresOn",
	"assignmentWindow",
	"sharedUntil"
];
/** Cumulative allow-lists. Anything absent is denied — there is no wildcard. */
const PROFILE_FIELDS = {
	summary: SUMMARY,
	operational: [...SUMMARY, ...OPERATIONAL_ADDS],
	aviation: [
		...SUMMARY,
		...OPERATIONAL_ADDS,
		...AVIATION_ADDS
	],
	incident_command: [
		...SUMMARY,
		...OPERATIONAL_ADDS,
		...AVIATION_ADDS,
		...INCIDENT_COMMAND_ADDS
	],
	full: FIELD_KEYS,
	custom: FIELD_KEYS.filter((k) => !FIELD_DEF[k].sensitive)
};
/** Keys an originating organization may put in a custom approved profile. */
const CUSTOM_SELECTABLE_FIELDS = PROFILE_FIELDS.custom;
function isFieldKey(value) {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(FIELD_DEFS, value);
}
function isDisclosureProfile(value) {
	return typeof value === "string" && DISCLOSURE_PROFILES.includes(value);
}
/**
* Resolves the effective, ordered set of disclosable keys. Default deny:
*  - an unknown profile collapses to `summary`
*  - `full` collapses to `incident_command` unless owner or named recipient
*  - custom keys outside CUSTOM_SELECTABLE_FIELDS are dropped, not rejected
*    loudly, so a partner cannot probe key names through error text
*/
function resolveDisclosedFields(req) {
	if (req.owner) return [...FIELD_KEYS];
	const profile = isDisclosureProfile(req.profile) ? req.profile : "summary";
	if (profile === "full") return req.namedRecipient === true ? [...FIELD_KEYS] : [...PROFILE_FIELDS.incident_command];
	if (profile === "custom") {
		const allowed = new Set(CUSTOM_SELECTABLE_FIELDS);
		const chosen = (req.customFieldKeys ?? []).filter((k) => isFieldKey(k) && allowed.has(k));
		const merged = new Set([...SUMMARY, ...chosen]);
		return FIELD_KEYS.filter((k) => merged.has(k));
	}
	return [...PROFILE_FIELDS[profile]];
}
//#endregion
//#region src/lib/resources/resources.server.ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertUuid(value, label) {
	if (typeof value !== "string" || !UUID.test(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function assertOneOf(value, allowed, label) {
	if (typeof value !== "string" || !allowed.includes(value)) throw new AccessError("invalid_input", `invalid ${label}`);
	return value;
}
function text(value, label, max, required = false) {
	if (value == null || value === "") {
		if (required) throw new AccessError("invalid_input", `${label} is required`);
		return null;
	}
	if (typeof value !== "string") throw new AccessError("invalid_input", `invalid ${label}`);
	const trimmed = value.trim();
	if (required && !trimmed) throw new AccessError("invalid_input", `${label} is required`);
	if (trimmed.length > max) throw new AccessError("invalid_input", `${label} is too long`);
	return trimmed;
}
function timestamp(value, label) {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new AccessError("invalid_input", `invalid ${label}`);
	return new Date(value).toISOString();
}
const COLUMNS$1 = `
  r.id, r.org_id AS "orgId", r.category, r.display_name AS "displayName", r.callsign,
  r.description, r.readiness_status AS "readinessStatus",
  r.operational_status AS "operationalStatus",
  r.sharing_classification AS "sharingClassification",
  r.lifecycle_status AS "lifecycleStatus", r.restricted_notes AS "restrictedNotes",
  to_json(r.retired_at)#>>'{}' AS "retiredAt", to_json(r.restored_at)#>>'{}' AS "restoredAt",
  r.version, to_json(r.created_at)#>>'{}' AS "createdAt",
  to_json(r.updated_at)#>>'{}' AS "updatedAt"
`;
/** Base-row columns that carry a disclosure field key. */
const RESOURCE_FIELD_BY_COLUMN = new Map(Object.keys(FIELD_DEF).filter((k) => FIELD_DEF[k].source === "resource").map((k) => [FIELD_DEF[k].column, k]));
/**
* Applies a disclosure profile to a row the database has already released.
* Withheld properties are DELETED from the payload rather than nulled, so a
* partner cannot distinguish "empty" from "withheld", and cannot infer the
* existence or length of a value it is not entitled to.
*/
function applyDisclosure(row, detail, keys) {
	const allowed = new Set(keys);
	const out = {};
	for (const [column, value] of Object.entries(row)) {
		const key = RESOURCE_FIELD_BY_COLUMN.get(column);
		if (key && !allowed.has(key)) continue;
		out[column] = value;
	}
	if (!allowed.has("restrictedNotes")) {
		delete out.sharingClassification;
		delete out.retiredAt;
		delete out.restoredAt;
	}
	let projectedDetail = null;
	if (detail) {
		projectedDetail = {};
		for (const key of keys) {
			const def = FIELD_DEF[key];
			if (def.source !== "detail") continue;
			if (!(def.column in detail)) continue;
			projectedDetail[def.column] = detail[def.column];
		}
	}
	return {
		row: out,
		detail: projectedDetail,
		disclosedFields: keys.filter((k) => allowed.has(k))
	};
}
/** Validates a caller-proposed profile. Unknown values fail closed. */
function assertDisclosureProfile(value) {
	return assertOneOf(value, DISCLOSURE_PROFILES, "disclosure profile");
}
/**
* Validates a custom key list. Keys are matched against the server-side
* vocabulary; sensitive keys are rejected outright so a custom profile can
* never become a back door to the full authorized record.
*/
function assertCustomFieldKeys(values) {
	const keys = values ?? [];
	if (keys.length > 64) throw new AccessError("invalid_input", "too many disclosure fields");
	const out = [];
	for (const key of keys) {
		if (!isFieldKey(key) || FIELD_DEF[key].sensitive) throw new AccessError("invalid_input", "unknown disclosure field");
		if (!out.includes(key)) out.push(key);
	}
	return out;
}
/** Reads the disclosure the database says the active organization is entitled to. */
async function effectiveDisclosure(q, resourceId) {
	const row = (await q.query(`SELECT * FROM airs.effective_disclosure($1)`, [resourceId]))[0];
	if (!row) return {
		profile: "summary",
		customFieldKeys: [],
		namedRecipient: false
	};
	return {
		profile: DISCLOSURE_PROFILES.includes(row.profile) ? row.profile : "summary",
		customFieldKeys: row.custom_field_keys ?? [],
		namedRecipient: row.named_recipient === true
	};
}
const DETAIL_TABLES = {
	aircraft: "resource_aircraft",
	vehicle: "resource_vehicles",
	dock: "resource_docks",
	launch_site: "resource_launch_sites",
	sensor: "resource_sensors"
};
async function loadDetail(q, resource) {
	const table = DETAIL_TABLES[detailKindFor(resource.category)];
	return (await q.query(`SELECT * FROM airs.${table} WHERE resource_id = $1`, [resource.id]))[0] ?? null;
}
async function fetchResource(q, id) {
	const row = (await q.query(`SELECT ${COLUMNS$1} FROM airs.resources r WHERE r.id = $1`, [assertUuid(id, "resource id")]))[0];
	if (!row) throw new AccessError("resource_not_found");
	return row;
}
/** Ownership is the only path to any write. Never inferred from the request. */
function assertOwner(ctx, row) {
	if (row.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
}
async function readResource(token, orgId, resourceId, meta) {
	return withAuthorized({
		token,
		orgId,
		permission: "resource.read",
		action: "resource.read",
		resourceType: "resource",
		resourceId,
		audit: false,
		meta
	}, async (ctx, q) => {
		const row = await fetchResource(q, resourceId);
		const owner = row.orgId === ctx.orgId;
		const detail = await loadDetail(q, row);
		if (owner) return {
			...row,
			relationship: "owner",
			detail,
			disclosureProfile: "full"
		};
		const entitlement = await effectiveDisclosure(q, row.id);
		const projected = applyDisclosure(row, detail, resolveDisclosedFields({
			profile: entitlement.profile,
			customFieldKeys: entitlement.customFieldKeys,
			owner: false,
			namedRecipient: entitlement.namedRecipient
		}));
		return {
			...projected.row,
			relationship: "partner",
			detail: projected.detail,
			disclosureProfile: entitlement.profile,
			disclosedFields: projected.disclosedFields
		};
	});
}
async function setResourceStatus(token, orgId, input, meta) {
	const resourceId = assertUuid(input.resourceId, "resource id");
	const status = assertOneOf(input.readinessStatus, READINESS_STATUSES, "readiness status");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.set_status",
		action: "resource.status_changed",
		resourceType: "resource",
		resourceId,
		detail: { status },
		meta
	}, async (ctx, q) => {
		const current = await fetchResource(q, resourceId);
		assertOwner(ctx, current);
		if (current.lifecycleStatus === "retired") {
			await recordAudit(q, {
				orgId: ctx.orgId,
				actorUserId: ctx.userId,
				action: "resource.invalid_status_transition",
				resourceType: "resource",
				resourceId,
				outcome: "deny",
				detail: {
					reason: "retired",
					requested: status
				}
			});
			throw new AccessError("resource_retired");
		}
		if (!statusAllowedForCategory(current.category, status)) {
			await recordAudit(q, {
				orgId: ctx.orgId,
				actorUserId: ctx.userId,
				action: "resource.invalid_status_transition",
				resourceType: "resource",
				resourceId,
				outcome: "deny",
				detail: {
					category: current.category,
					requested: status
				}
			});
			throw new AccessError("invalid_status_for_category");
		}
		const rows = await q.query(`UPDATE airs.resources
            SET readiness_status = $2, updated_by_account = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND org_id = $4
          RETURNING ${COLUMNS$1.replaceAll("r.", "")}`, [
			resourceId,
			status,
			ctx.accountId,
			ctx.orgId
		]);
		if (!rows[0]) throw new AccessError("resource_not_found");
		return {
			...rows[0],
			relationship: "owner"
		};
	});
}
const SHARE_COLUMNS = `
  s.id, s.resource_id AS "resourceId", s.org_id AS "orgId", s.incident_id AS "incidentId",
  s.classification, to_json(s.shared_at)#>>'{}' AS "sharedAt",
  to_json(s.expires_at)#>>'{}' AS "expiresAt", to_json(s.revoked_at)#>>'{}' AS "revokedAt",
  s.revocation_reason AS "revocationReason",
  s.disclosure_profile AS "disclosureProfile",
  s.custom_field_keys AS "customFieldKeys"
`;
async function shareResource(token, orgId, input, meta) {
	const resourceId = assertUuid(input.resourceId, "resource id");
	const incidentId = assertUuid(input.incidentId, "incident id");
	const classification = input.classification ? assertOneOf(input.classification, SHARING_CLASSIFICATIONS, "classification") : "participating_orgs";
	const expiresAt = timestamp(input.expiresAt, "expiry");
	const named = (input.namedRecipientOrgIds ?? []).map((v) => assertUuid(v, "recipient org id"));
	const profile = input.disclosureProfile ? assertDisclosureProfile(input.disclosureProfile) : "summary";
	const customKeys = profile === "custom" ? assertCustomFieldKeys(input.customFieldKeys) : [];
	if (profile === "full" && classification !== "named_recipients") throw new AccessError("invalid_input", "full disclosure requires named recipients");
	if (profile === "custom" && customKeys.length === 0) throw new AccessError("invalid_input", "custom disclosure requires at least one field");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.share",
		action: "resource.shared",
		resourceType: "resource",
		resourceId,
		detail: {
			incidentId,
			classification,
			disclosureProfile: profile
		},
		meta
	}, async (ctx, q) => {
		const current = await fetchResource(q, resourceId);
		assertOwner(ctx, current);
		if (current.lifecycleStatus === "retired") throw new AccessError("resource_retired");
		const room = await q.query(`SELECT status FROM airs.incident_rooms WHERE id = $1`, [incidentId]);
		if (!room[0]) throw new AccessError("incident_not_found");
		if ([
			"closed",
			"archived",
			"closing"
		].includes(room[0].status)) throw new AccessError("incident_closed");
		const rows = await q.query(`INSERT INTO airs.resource_shares
           (resource_id, org_id, incident_id, classification, named_recipient_org_ids,
            shared_by_account, expires_at, disclosure_profile, custom_field_keys)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (resource_id, incident_id) DO UPDATE
           SET classification = EXCLUDED.classification,
               named_recipient_org_ids = EXCLUDED.named_recipient_org_ids,
               expires_at = EXCLUDED.expires_at,
               shared_by_account = EXCLUDED.shared_by_account,
               disclosure_profile = EXCLUDED.disclosure_profile,
               custom_field_keys = EXCLUDED.custom_field_keys,
               revoked_at = NULL, revocation_reason = NULL
           WHERE airs.resource_shares.revoked_at IS NULL
         RETURNING ${SHARE_COLUMNS.replaceAll("s.", "")}`, [
			resourceId,
			ctx.orgId,
			incidentId,
			classification,
			named,
			ctx.accountId,
			expiresAt,
			profile,
			customKeys
		]);
		if (!rows[0]) throw new AccessError("share_revoked");
		return rows[0];
	});
}
//#endregion
//#region src/lib/resources/assignments.server.ts
const COLUMNS = `
  a.id, a.incident_id AS "incidentId", a.org_id AS "orgId",
  a.assignment_type AS "assignmentType", a.resource_id AS "resourceId",
  a.person_id AS "personId", a.assigned_role AS "assignedRole", a.status,
  to_json(a.starts_at)#>>'{}' AS "startsAt", to_json(a.ends_at)#>>'{}' AS "endsAt",
  a.visibility_classification AS "visibilityClassification",
  a.release_reason AS "releaseReason", to_json(a.released_at)#>>'{}' AS "releasedAt",
  to_json(a.created_at)#>>'{}' AS "createdAt", to_json(a.updated_at)#>>'{}' AS "updatedAt",
  a.disclosure_profile AS "disclosureProfile", a.custom_field_keys AS "customFieldKeys"
`;
/**
* Field-level disclosure for an assignment owned by ANOTHER organization.
* A partner sees the record exists (RLS already allowed the row) but only the
* fields the originating organization's profile releases. Withheld properties
* are deleted from the payload, never blanked.
*/
function discloseAssignment(row) {
	const profile = DISCLOSURE_PROFILES.includes(String(row.disclosureProfile)) ? row.disclosureProfile : "summary";
	const keys = new Set(resolveDisclosedFields({
		profile,
		customFieldKeys: row.customFieldKeys ?? [],
		owner: false
	}));
	const out = {
		id: row.id,
		incidentId: row.incidentId,
		orgId: row.orgId,
		assignmentType: row.assignmentType,
		resourceId: row.resourceId,
		personId: row.personId,
		label: keys.has("personDisplayName") || keys.has("displayName") ? row.label : null,
		assignedRole: keys.has("currentIncidentRole") ? row.assignedRole : null,
		status: keys.has("assignmentStatus") ? row.status : "shared",
		endsAt: keys.has("assignmentWindow") ? row.endsAt : null,
		visibilityClassification: row.visibilityClassification,
		releaseReason: null,
		releasedAt: row.releasedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		ownerOrgName: row.ownerOrgName ?? null,
		disclosureProfile: profile,
		disclosedFields: [...keys]
	};
	if (keys.has("assignmentWindow")) out.startsAt = row.startsAt;
	if (keys.has("qualificationType") && row.assignmentType === "person") out.currentQualifications = row.currentQualifications ?? [];
	return out;
}
/** Reads the room and refuses any write against a closed or archived one. */
async function assertOpenRoom(q, incidentId) {
	const rows = await q.query(`SELECT status FROM airs.incident_rooms WHERE id = $1`, [incidentId]);
	if (!rows[0]) throw new AccessError("incident_not_found");
	if (["closed", "archived"].includes(rows[0].status)) throw new AccessError("incident_closed");
}
async function listIncidentAssignments(token, orgId, incidentId, meta) {
	const inc = assertUuid(incidentId, "incident id");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.read",
		action: "assignment.list",
		resourceType: "assignment",
		resourceId: inc,
		audit: false,
		meta
	}, async (ctx, q) => (await q.query(`SELECT ${COLUMNS},
                COALESCE(r.display_name, p.display_name) AS label,
                CASE WHEN a.assignment_type = 'person'
                     THEN airs.assignment_current_qualifications(a.id) END
                  AS "currentQualifications",
                CASE WHEN a.org_id = $2 THEN NULL ELSE airs.related_org_name(a.org_id) END
                  AS "ownerOrgName"
           FROM airs.incident_assignments a
           LEFT JOIN airs.resources r ON r.id = a.resource_id AND r.org_id = a.org_id
           LEFT JOIN airs.personnel_profiles p ON p.id = a.person_id AND p.org_id = a.org_id
          WHERE a.incident_id = $1
            AND (
              a.org_id = $2
              OR a.assignment_type <> 'resource'
              OR (
                a.resource_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM airs.resource_shares s
                  JOIN airs.incident_rooms r ON r.id = s.incident_id
                  WHERE s.resource_id = a.resource_id AND s.incident_id = a.incident_id
                    AND s.org_id <> $2 AND s.revoked_at IS NULL
                    AND (s.expires_at IS NULL OR s.expires_at > now())
                    AND s.classification <> 'originating_org_only'
                    AND (s.classification <> 'named_recipients' OR $2 = ANY (s.named_recipient_org_ids))
                    AND r.status NOT IN ('closed','archived')
                    AND (r.org_id = $2 OR airs.has_incident_access(s.incident_id))
                )
              )
            )
          ORDER BY a.created_at DESC`, [inc, ctx.orgId])).map((row) => row.orgId === ctx.orgId ? row : discloseAssignment(row)));
}
async function assignToIncident(token, orgId, input, meta) {
	const incidentId = assertUuid(input.incidentId, "incident id");
	const type = assertOneOf(input.assignmentType, ["resource", "person"], "assignment type");
	const resourceId = type === "resource" ? assertUuid(String(input.resourceId), "resource id") : null;
	const personId = type === "person" ? assertUuid(String(input.personId), "person id") : null;
	const role = input.assignedRole ? assertOneOf(input.assignedRole, OPERATIONAL_ROLES, "assigned role") : null;
	const visibility = input.visibilityClassification ? assertOneOf(input.visibilityClassification, SHARING_CLASSIFICATIONS, "visibility") : "participating_orgs";
	const profile = input.disclosureProfile ? assertDisclosureProfile(input.disclosureProfile) : "summary";
	const customKeys = profile === "custom" ? assertCustomFieldKeys(input.customFieldKeys) : [];
	if (profile === "full") throw new AccessError("invalid_input", "assignments cannot disclose the full record");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.assign_incident",
		action: type === "resource" ? "assignment.resource_assigned" : "assignment.person_assigned",
		resourceType: "assignment",
		resourceId: resourceId ?? personId,
		detail: {
			incidentId,
			type,
			disclosureProfile: profile
		},
		meta
	}, async (ctx, q) => {
		await assertOpenRoom(q, incidentId);
		if (resourceId) {
			const owned = await q.query(`SELECT lifecycle_status AS "lifecycleStatus" FROM airs.resources
            WHERE id = $1 AND org_id = $2`, [resourceId, ctx.orgId]);
			if (!owned[0]) throw new AccessError("tenant_mismatch");
			if (owned[0].lifecycleStatus === "retired") throw new AccessError("resource_retired");
		} else if (!(await q.query(`SELECT id FROM airs.personnel_profiles WHERE id = $1 AND org_id = $2`, [personId, ctx.orgId]))[0]) throw new AccessError("tenant_mismatch");
		return (await q.query(`INSERT INTO airs.incident_assignments
           (incident_id, org_id, assignment_type, resource_id, person_id, assigned_role,
            status, starts_at, ends_at, visibility_classification, assigned_by_account,
            disclosure_profile, custom_field_keys)
         VALUES ($1,$2,$3,$4,$5,$6,'assigned',COALESCE($7::timestamptz, now()),$8::timestamptz,
                 $9,$10,$11,$12)
         RETURNING ${COLUMNS.replaceAll("a.", "")}`, [
			incidentId,
			ctx.orgId,
			type,
			resourceId,
			personId,
			role,
			timestamp(input.startsAt, "start time"),
			timestamp(input.endsAt, "end time"),
			visibility,
			ctx.accountId,
			profile,
			customKeys
		]))[0];
	});
}
/** Release / complete / cancel. Takes effect immediately for every reader. */
async function endAssignment(token, orgId, input, meta) {
	const assignmentId = assertUuid(input.assignmentId, "assignment id");
	const status = assertOneOf(input.status, [
		"released",
		"completed",
		"cancelled"
	], "status");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.release_incident",
		action: `assignment.${status}`,
		resourceType: "assignment",
		resourceId: assignmentId,
		detail: { reason: text(input.reason, "reason", 500) },
		meta
	}, async (ctx, q) => {
		const rows = await q.query(`UPDATE airs.incident_assignments
            SET status = $2, released_by_account = $3, released_at = now(),
                release_reason = COALESCE($4, release_reason)
          WHERE id = $1 AND org_id = $5 AND status NOT IN ('released','cancelled','completed')
          RETURNING ${COLUMNS.replaceAll("a.", "")}`, [
			assignmentId,
			status,
			ctx.accountId,
			text(input.reason, "reason", 500),
			ctx.orgId
		]);
		if (!rows[0]) throw new AccessError((await q.query(`SELECT status FROM airs.incident_assignments WHERE id = $1 AND org_id = $2`, [assignmentId, ctx.orgId]))[0] ? "assignment_terminated" : "assignment_not_found");
		return rows[0];
	});
}
/** Progress an assignment through its active states (assigned -> deploying -> active). */
async function setAssignmentStatus(token, orgId, input, meta) {
	const assignmentId = assertUuid(input.assignmentId, "assignment id");
	const status = assertOneOf(input.status, ASSIGNMENT_STATUSES, "status");
	if (!ACTIVE_ASSIGNMENT_STATUSES.includes(status)) throw new AccessError("invalid_input", "use endAssignment for terminal states");
	return withAuthorized({
		token,
		orgId,
		permission: "resource.assign_incident",
		action: "assignment.status_changed",
		resourceType: "assignment",
		resourceId: assignmentId,
		detail: { status },
		meta
	}, async (ctx, q) => {
		const rows = await q.query(`UPDATE airs.incident_assignments SET status = $2
          WHERE id = $1 AND org_id = $3 AND status NOT IN ('released','cancelled','completed')
          RETURNING ${COLUMNS.replaceAll("a.", "")}`, [
			assignmentId,
			status,
			ctx.orgId
		]);
		if (!rows[0]) throw new AccessError("assignment_terminated");
		return rows[0];
	});
}
//#endregion
//#region src/lib/map/model.ts
const OPERATING_AREA_STATUSES = [
	"proposed",
	"approved",
	"active",
	"suspended",
	"completed",
	"cancelled"
];
const LOCATION_KINDS = ["fixed", "temporary"];
/** Manual entry only. This stage has no telemetry, tracking or live feed. */
const POSITION_SOURCES = [
	"manual",
	"planned",
	"last_known"
];
const PRECISION_POLICIES = [
	"withheld",
	"area_only",
	"generalized",
	"approximate",
	"exact"
];
function isFiniteLngLat(value) {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}
/**
* Structural validation of untrusted GeoJSON. Returns null when the value is
* not a geometry this system stores; callers turn that into `invalid_geometry`.
* PostGIS validity (self-intersection etc.) is still checked in the database.
*/
function parseGeometry(value) {
	if (!value || typeof value !== "object") return null;
	const g = value;
	if (g.type === "Point") return isFiniteLngLat(g.coordinates) ? {
		type: "Point",
		coordinates: g.coordinates
	} : null;
	if (g.type === "LineString") {
		const coords = g.coordinates;
		if (!Array.isArray(coords) || coords.length < 2 || coords.length > 512) return null;
		if (!coords.every(isFiniteLngLat)) return null;
		return {
			type: "LineString",
			coordinates: coords
		};
	}
	if (g.type === "Polygon") {
		const rings = g.coordinates;
		if (!Array.isArray(rings) || rings.length < 1 || rings.length > 8) return null;
		const parsed = [];
		for (const ring of rings) {
			if (!Array.isArray(ring) || ring.length < 4 || ring.length > 512) return null;
			if (!ring.every(isFiniteLngLat)) return null;
			const first = ring[0];
			const last = ring[ring.length - 1];
			if (first[0] !== last[0] || first[1] !== last[1]) return null;
			parsed.push(ring);
		}
		return {
			type: "Polygon",
			coordinates: parsed
		};
	}
	return null;
}
function parsePolygon(value) {
	const geom = parseGeometry(value);
	return geom && geom.type === "Polygon" ? geom : null;
}
function parsePoint(value) {
	const geom = parseGeometry(value);
	return geom && geom.type === "Point" ? geom : null;
}
//#endregion
//#region src/lib/map/map.server.ts
const CLASSIFICATIONS = [
	"participating_orgs",
	"public_safety_only",
	"law_enforcement_sensitive",
	"aviation_personnel_only",
	"incident_command_only",
	"originating_org_only",
	"named_recipients"
];
/** Terminal states an operating area can never leave. */
const TERMINAL = ["completed", "cancelled"];
/**
* Turns a database row into a payload. A withheld geometry is DELETED rather
* than nulled, matching the Stage 6 field-disclosure rule: a partner cannot
* distinguish "no geography recorded" from "geography withheld".
*/
function envelope(policy, geojson) {
	const precision = PRECISION_POLICIES.includes(policy) ? policy : "withheld";
	if (precision === "withheld" || !geojson) return { precision };
	try {
		const parsed = parseGeometry(JSON.parse(geojson));
		return parsed ? {
			precision,
			geometry: parsed
		} : { precision: "withheld" };
	} catch {
		return { precision: "withheld" };
	}
}
/** Owner-plane columns are stripped from partner payloads by construction. */
function ownerOnly(row, isOwner, keys) {
	if (isOwner) return row;
	for (const key of keys) delete row[key];
	return row;
}
function assertPrecision(value, fallback) {
	if (value == null || value === "") return fallback;
	return assertOneOf(value, PRECISION_POLICIES, "precision policy");
}
function geometryOrThrow(value, kind) {
	const parsed = kind === "polygon" ? parsePolygon(value) : kind === "point" ? parsePoint(value) : parseGeometry(value);
	if (!parsed) throw new AccessError("invalid_geometry");
	return parsed;
}
function integer(value, label, min, max) {
	if (value == null || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new AccessError("invalid_input", `invalid ${label}`);
	return n;
}
const AREA_SELECT = `
  a.id, a.org_id AS "orgId", a.incident_id AS "incidentId", a.name, a.purpose,
  a.altitude_floor_ft AS "altitudeFloorFt", a.altitude_ceiling_ft AS "altitudeCeilingFt",
  to_json(a.starts_at)#>>'{}' AS "startsAt", to_json(a.ends_at)#>>'{}' AS "endsAt",
  a.status, a.version, a.classification, a.precision_policy AS "declaredPrecision",
  to_json(a.approved_at)#>>'{}' AS "approvedAt",
  to_json(a.created_at)#>>'{}' AS "createdAt",
  to_json(a.updated_at)#>>'{}' AS "updatedAt",
  airs.related_org_name(a.org_id) AS "ownerOrgName",
  (a.org_id = $1) AS "isOwner",
  p.policy AS "policy",
  public.ST_AsGeoJSON(airs.apply_precision(a.area, p.policy)) AS "geojson"
`;
const AREA_FROM = `
  FROM airs.operating_areas a
  CROSS JOIN LATERAL (
    SELECT airs.resolve_precision(a.precision_policy,
                                  airs.incident_geo_profile(a.incident_id),
                                  a.org_id = $1) AS policy
  ) p
`;
function toArea(row) {
	const { isOwner, policy, geojson, ...rest } = row;
	return ownerOnly({
		...rest,
		relationship: isOwner ? "owner" : "partner",
		...envelope(policy, geojson)
	}, isOwner, ["classification", "declaredPrecision"]);
}
const LOCATION_SELECT = `
  l.id, l.org_id AS "orgId", l.resource_id AS "resourceId",
  r.display_name AS "resourceName", r.category AS "resourceCategory",
  l.incident_id AS "incidentId", l.location_kind AS "locationKind",
  l.position_source AS "positionSource", l.note,
  l.altitude_ft AS "altitudeFt", l.accuracy_meters AS "accuracyMeters",
  to_json(l.reported_at)#>>'{}' AS "reportedAt",
  to_json(l.expires_at)#>>'{}' AS "expiresAt",
  airs.location_freshness(l.reported_at, l.expires_at) AS "freshness",
  l.precision_policy AS "declaredPrecision",
  airs.related_org_name(l.org_id) AS "ownerOrgName",
  (l.org_id = $1) AS "isOwner",
  p.policy AS "policy",
  public.ST_AsGeoJSON(airs.apply_precision(l.geom, p.policy)) AS "geojson"
`;
const LOCATION_FROM = `
  FROM airs.resource_locations l
  JOIN airs.resources r ON r.id = l.resource_id
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT d.profile FROM airs.effective_disclosure(l.resource_id) d LIMIT 1),
                    'summary') AS profile
  ) e
  CROSS JOIN LATERAL (
    SELECT airs.resolve_precision(l.precision_policy, e.profile, l.org_id = $1) AS policy
  ) p
`;
function toLocation(row) {
	const { isOwner, policy, geojson, ...rest } = row;
	return ownerOnly({
		...rest,
		relationship: isOwner ? "owner" : "partner",
		...envelope(policy, geojson)
	}, isOwner, ["declaredPrecision"]);
}
/** Confirms the active organization owns a room before it may place geography in it. */
async function assertOwnsRoom(ctx, q, incidentId) {
	const room = (await q.query(`SELECT org_id AS "orgId", status FROM airs.incident_rooms WHERE id = $1`, [incidentId]))[0];
	if (!room) throw new AccessError("incident_not_found");
	if (room.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
	if (room.status === "closed" || room.status === "archived") throw new AccessError("incident_closed");
	return room;
}
async function createOperatingArea(token, orgId, input, meta) {
	const incidentId = assertUuid(input.incidentId, "incident id");
	const name = text(input.name, "name", 160, true);
	const purpose = text(input.purpose, "purpose", 2e3) ?? "";
	const area = geometryOrThrow(input.area, "polygon");
	const floor = integer(input.altitudeFloorFt, "altitude floor", 0, 18e3) ?? 0;
	const ceiling = integer(input.altitudeCeilingFt, "altitude ceiling", 0, 18e3) ?? 400;
	if (ceiling < floor) throw new AccessError("invalid_altitude_block");
	const startsAt = timestamp(input.startsAt, "start time");
	const endsAt = timestamp(input.endsAt, "end time");
	if (startsAt && endsAt && endsAt <= startsAt) throw new AccessError("invalid_time_window");
	const classification = input.classification ? assertOneOf(input.classification, CLASSIFICATIONS, "classification") : "participating_orgs";
	const precision = assertPrecision(input.precisionPolicy, "exact");
	return withAuthorized({
		token,
		orgId,
		permission: "map.operating_area.propose",
		action: "map.operating_area.proposed",
		resourceType: "operating_area",
		detail: {
			incidentId,
			floor,
			ceiling,
			precision,
			classification
		},
		meta
	}, async (ctx, q) => {
		await assertOwnsRoom(ctx, q, incidentId);
		const rows = await q.query(`INSERT INTO airs.operating_areas
           (org_id, incident_id, name, purpose, area, altitude_floor_ft, altitude_ceiling_ft,
            starts_at, ends_at, classification, precision_policy, created_by_account)
         VALUES ($1,$2,$3,$4,
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($5), 4326),
                 $6,$7, COALESCE($8::timestamptz, now()), $9,$10,$11,$12)
         RETURNING id`, [
			ctx.orgId,
			incidentId,
			name,
			purpose,
			JSON.stringify(area),
			floor,
			ceiling,
			startsAt,
			endsAt,
			classification,
			precision,
			ctx.accountId
		]);
		return readArea(q, ctx.orgId, rows[0].id);
	});
}
async function readArea(q, orgId, id) {
	const rows = await q.query(`SELECT ${AREA_SELECT} ${AREA_FROM} WHERE a.id = $2`, [orgId, id]);
	if (!rows[0]) throw new AccessError("operating_area_not_found");
	return toArea(rows[0]);
}
/**
* Approval is a distinct permission from proposal: an agency may let dispatch
* draft an operating volume without letting it authorize one.
*/
async function setOperatingAreaStatus(token, orgId, areaId, status, expectedVersion, meta) {
	const id = assertUuid(areaId, "operating area id");
	const next = assertOneOf(status, OPERATING_AREA_STATUSES, "operating area status");
	if (next === "proposed") throw new AccessError("operating_area_state_invalid");
	const expected = integer(expectedVersion, "expected version", 1, 2e9);
	const needsApproval = next === "approved" || next === "active";
	return withAuthorized({
		token,
		orgId,
		permission: needsApproval ? "map.operating_area.approve" : "map.operating_area.propose",
		action: `map.operating_area.${next}`,
		resourceType: "operating_area",
		resourceId: id,
		detail: { status: next },
		meta
	}, async (ctx, q) => {
		const row = (await q.query(`SELECT status, version, org_id AS "orgId" FROM airs.operating_areas WHERE id = $1`, [id]))[0];
		if (!row) throw new AccessError("operating_area_not_found");
		if (row.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
		if (TERMINAL.includes(row.status)) throw new AccessError("operating_area_state_invalid");
		if (Number(row.version) !== expected) throw new AccessError("version_conflict");
		const approve = needsApproval;
		if (!(await q.query(`UPDATE airs.operating_areas
            SET status = $3,
                approved_at = CASE WHEN $4 THEN COALESCE(approved_at, now()) ELSE approved_at END,
                approved_by_account = CASE WHEN $4 THEN COALESCE(approved_by_account, $5)
                                           ELSE approved_by_account END,
                version = version + 1
          WHERE id = $2 AND org_id = $1 AND version = $6
        RETURNING id`, [
			ctx.orgId,
			id,
			next,
			approve,
			ctx.accountId,
			expected
		]))[0]) throw new AccessError("version_conflict");
		return readArea(q, ctx.orgId, id);
	});
}
/**
* Records a MANUAL position. There is no telemetry, tracking feed or automatic
* update in this stage: a position is a dated operator statement, it supersedes
* the previous one rather than editing it, and it ages visibly.
*/
async function reportResourceLocation(token, orgId, input, meta) {
	const resourceId = assertUuid(input.resourceId, "resource id");
	const kind = assertOneOf(input.locationKind, LOCATION_KINDS, "location kind");
	const point = geometryOrThrow(input.point, "point");
	const incidentId = kind === "temporary" && input.incidentId ? assertUuid(input.incidentId, "incident id") : null;
	const altitudeFt = integer(input.altitudeFt, "altitude", -1e3, 18e3);
	const accuracyMeters = integer(input.accuracyMeters, "accuracy", 0, 1e5);
	const source = input.positionSource ? assertOneOf(input.positionSource, POSITION_SOURCES, "position source") : "manual";
	const note = text(input.note, "note", 1e3) ?? "";
	const precision = assertPrecision(input.precisionPolicy, "approximate");
	const validForHours = kind === "temporary" ? integer(input.validForHours, "validity", 1, 72) ?? 4 : null;
	return withAuthorized({
		token,
		orgId,
		permission: "map.position.report",
		action: "map.location.reported",
		resourceType: "resource_location",
		resourceId,
		detail: {
			locationKind: kind,
			positionSource: source,
			precision,
			validForHours
		},
		meta
	}, async (ctx, q) => {
		const res = (await q.query(`SELECT org_id AS "orgId", lifecycle_status AS lifecycle
           FROM airs.resources WHERE id = $1`, [resourceId]))[0];
		if (!res) throw new AccessError("resource_not_found");
		if (res.orgId !== ctx.orgId) throw new AccessError("tenant_mismatch");
		if (res.lifecycle === "retired") throw new AccessError("resource_retired");
		if (incidentId) await assertOwnsRoom(ctx, q, incidentId);
		await q.query(`UPDATE airs.resource_locations SET superseded_at = now()
          WHERE resource_id = $1 AND org_id = $2 AND location_kind = $3 AND superseded_at IS NULL`, [
			resourceId,
			ctx.orgId,
			kind
		]);
		const rows = await q.query(`INSERT INTO airs.resource_locations
           (org_id, resource_id, incident_id, location_kind, geom, altitude_ft, accuracy_meters,
            position_source, note, precision_policy, reported_at, expires_at, reported_by_account)
         VALUES ($1,$2,$3,$4,
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($5), 4326),
                 $6,$7,$8,$9,$10, now(),
                 CASE WHEN $11::int IS NULL THEN NULL ELSE now() + ($11 || ' hours')::interval END,
                 $12)
         RETURNING id`, [
			ctx.orgId,
			resourceId,
			incidentId,
			kind,
			JSON.stringify(point),
			altitudeFt,
			accuracyMeters,
			source,
			note,
			precision,
			validForHours,
			ctx.accountId
		]);
		const view = await q.query(`SELECT ${LOCATION_SELECT} ${LOCATION_FROM} WHERE l.id = $2`, [ctx.orgId, rows[0].id]);
		if (!view[0]) throw new AccessError("resource_not_found");
		return toLocation(view[0]);
	});
}
//#endregion
//#region scripts/run-anconison-exercise.ts
const id = (s) => {
	const h = createHash("sha256").update("anconison-helene-2024:" + s).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const orgs = Array.from({ length: 7 }, (_, i) => id("org:" + i));
const rehearsal = process.argv.includes("--rehearsal");
const ownerUrl = process.env.DATABASE_URL;
if (process.env.AIRS_EXERCISE_RUN !== "anconison-simulated-only") throw Error("Explicit exercise run flag required");
if (rehearsal && !["127.0.0.1", "localhost"].includes(new URL(ownerUrl).hostname)) throw Error("Fast rehearsal requires disposable localhost database");
const owner = new pg.Client({ connectionString: ownerUrl });
const tokens = [], hashes = [], participantIds = [];
const resourceIds = [
	1,
	2,
	3,
	6
].map((i) => ({
	i,
	id: id("resource:" + i)
}));
const meta = { userAgent: "AIRS EXERCISE gauntlet: simulated participants; NO external delivery" };
const started = Date.now(), results = [];
let incidentId = "", activated = false, completed = false, stage = "preflight";
const emit = (event, detail = {}) => console.log(JSON.stringify({
	event,
	at: (/* @__PURE__ */ new Date()).toISOString(),
	stage,
	detail
}));
function check(label, condition, detail) {
	if (!condition) throw Error("CHECK FAILED: " + label);
	results.push({
		check: label,
		outcome: "passed",
		detail
	});
	emit("check.passed", {
		label,
		detail
	});
}
async function denied(label, fn, codes = [
	"incident_not_found",
	"participation_inactive",
	"forbidden",
	"tenant_mismatch",
	"resource_not_found"
]) {
	let code = "";
	try {
		await fn();
	} catch (e) {
		if (!isAccessError(e)) throw e;
		code = e.code;
	}
	check(label, codes.includes(code), { code });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function room() {
	return (await readIncident(tokens[0], orgs[0], incidentId, meta)).incident;
}
async function gate() {
	if (Date.now() - started > 1800 * 1e3) throw Error("Maximum exercise duration reached");
	let current = await room();
	while (current.status === "paused") {
		emit("exercise.paused");
		await sleep(rehearsal ? 20 : 3e3);
		if (Date.now() - started > 1800 * 1e3) throw Error("Pause exceeded maximum duration");
		current = await room();
	}
	if (current.status !== "active") throw Error("OPERATOR_STOP: incident is " + current.status);
}
async function step(label, fn) {
	stage = label;
	await gate();
	emit("step.started");
	await fn();
	emit("step.completed");
	for (let n = 0; n < (rehearsal ? 1 : 10); n++) {
		await sleep(rehearsal ? 20 : 2e3);
		await gate();
	}
}
async function setup() {
	await owner.connect();
	if (!(await owner.query("SELECT pg_try_advisory_lock(hashtext('airs-anconison-exercise-run')) AS locked")).rows[0].locked) throw Error("Another exercise runner is active");
	const rows = (await owner.query("SELECT id,status FROM airs.incident_rooms WHERE org_id=$1 AND name='EXERCISE ONLY — Anconison Helene coordination gauntlet'", [orgs[0]])).rows;
	if (rows.length !== 1 || rows[0].status !== "draft") throw Error("Exactly one unstarted exercise draft is required; refusing restart");
	incidentId = rows[0].id;
	if ((await owner.query("SELECT count(*)::int AS n FROM airs.organizations WHERE id=ANY($1::uuid[]) AND slug LIKE 'exercise-helene-%'", [orgs])).rows[0].n !== 7) throw Error("Exercise organization validation failed");
	await owner.query("BEGIN");
	for (let i = 0; i < 7; i++) {
		if ((await owner.query("SELECT email FROM airs.accounts WHERE id=$1", [id("account:" + i)])).rows[0]?.email !== `helene-${i}@simulation.invalid`) throw Error("Synthetic account mismatch");
		const token = randomBytes(32).toString("base64url"), hash = createHash("sha256").update(token).digest("hex");
		tokens[i] = token;
		hashes.push(hash);
		await owner.query("INSERT INTO airs.sessions(account_id,token_hash,active_org_id,expires_at,user_agent) VALUES($1,$2,$3,now()+interval '40 minutes',$4)", [
			id("account:" + i),
			hash,
			orgs[i],
			meta.userAgent
		]);
		if (i) await owner.query("INSERT INTO airs.trusted_agencies(org_id,partner_org_id,status,note,approved_at) VALUES($1,$2,'approved','EXERCISE fixture eligibility only; no incident access granted',now()) ON CONFLICT(org_id,partner_org_id) DO NOTHING", [orgs[0], orgs[i]]);
	}
	for (const r of resourceIds) await owner.query("INSERT INTO airs.resources(id,org_id,category,display_name,description,readiness_status,operational_status,sharing_classification,restricted_notes) VALUES($1,$2,$3,$4,'Fictional resource for isolated Helene exercise','available','unknown','originating_org_only',$5) ON CONFLICT(id) DO NOTHING", [
		r.id,
		orgs[r.i],
		r.i === 2 || r.i === 3 ? "aircraft" : "ground_vehicle",
		`EXERCISE ${[
			"",
			"Rescue vehicle",
			"Crewed aircraft",
			"UAS",
			"",
			"",
			"Communications vehicle"
		][r.i]}`,
		"EXERCISE_OWNER_ONLY_CANARY_" + r.i
	]);
	await owner.query("COMMIT");
	const appUrl = new URL(ownerUrl);
	appUrl.username = "airs_app";
	process.env.DATABASE_URL = appUrl.toString();
	process.env.PGPASSWORD = process.env.APP_DB_PASSWORD;
	process.env.AUTH_DRIVER = "local";
	const roles = await getDatabase().withContext({}, (q) => q.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
	check("Restricted application role", roles[0].current_user === "airs_app" && !roles[0].rolsuper && !roles[0].rolbypassrls);
	emit("fixtures.ready", {
		incidentId,
		agencies: 7,
		syntheticSessions: 7,
		externalDelivery: false,
		operatorFixtures: "trusted eligibility and four fictional resource records"
	});
}
async function main() {
	await setup();
	for (let i = 1; i < 7; i++) await denied("Uninvited agency " + i + " cannot read", () => readIncident(tokens[i], orgs[i], incidentId, meta));
	await saveIcsProfile(tokens[0], orgs[0], incidentId, {
		commandMode: "single",
		incidentCommander: "Anconison exercise command",
		commandPostName: "EXERCISE coordination post",
		situationSummary: "Historical Helene context, western NC. All agency responses, positions and resources are fictional. Paced exercise running.",
		safetyMessage: "EXERCISE ONLY. No dispatch, external invitations, real flight authorization or live emergency activity.",
		operationalCondition: "elevated"
	}, meta);
	const original = await room();
	await activateIncident(tokens[0], orgs[0], incidentId, original.version, meta);
	activated = true;
	emit("exercise.started", { incidentId });
	await step("Anconison opens command and exercise map", async () => {
		await denied("Stale incident version rejected", () => updateIncident(tokens[0], orgs[0], incidentId, {
			expectedVersion: original.version,
			description: "Stale update must not persist"
		}, meta), ["incident_stale_version"]);
		await addIcsObjective(tokens[0], orgs[0], incidentId, { objective: "EXERCISE: coordinate fictional rescue, aviation, UAS and communications resources while verifying agency data boundaries." }, meta);
		const area = await createOperatingArea(tokens[0], orgs[0], {
			incidentId,
			name: "EXERCISE ONLY — fictional western NC sector",
			purpose: "Illustrative test geometry only; not an actual operation or airspace authorization",
			area: {
				type: "Polygon",
				coordinates: [[
					[-82.65, 35.5],
					[-82.45, 35.5],
					[-82.45, 35.68],
					[-82.65, 35.68],
					[-82.65, 35.5]
				]]
			},
			classification: "participating_orgs",
			precisionPolicy: "generalized"
		}, meta);
		await setOperatingAreaStatus(tokens[0], orgs[0], area.id, "active", area.version, meta);
	});
	await step("Invite six fictional agencies through AIRS", async () => {
		for (let i = 1; i < 7; i++) {
			participantIds[i] = (await invitePartner(tokens[0], orgs[0], incidentId, {
				partnerOrgId: orgs[i],
				accessLevel: i === 3 ? "view_only" : "operational",
				requiresApproval: i === 1,
				invitationExpiresAt: new Date(Date.now() + (i === 5 ? rehearsal ? 1e3 : 9e4 : 1200 * 1e3)).toISOString(),
				reason: "EXERCISE ONLY: simulated internal inbox; no email or external delivery"
			}, meta)).participant.id;
			const inbox = await listPendingInvitations(tokens[i], orgs[i], meta);
			check("Agency " + i + " sees its invitation", inbox.some((p) => p.participantId === participantIds[i]));
			await denied("Invited agency " + i + " cannot read protected room", () => readIncident(tokens[i], orgs[i], incidentId, meta));
		}
	});
	await step("Blue Ridge accepts; approval is still required", async () => {
		check("Acceptance waits for approval", (await partnerParticipationAction(tokens[1], orgs[1], participantIds[1], "accept", meta)).participationStatus === "pending_approval");
		await denied("Pending approval cannot read", () => readIncident(tokens[1], orgs[1], incidentId, meta));
		await denied("Duplicate acceptance rejected", () => partnerParticipationAction(tokens[1], orgs[1], participantIds[1], "accept", meta), ["participation_inactive"]);
	});
	await step("Command approves rescue; logistics declines", async () => {
		await ownerParticipantAction(tokens[0], orgs[0], incidentId, participantIds[1], "approve_partner", meta);
		check("Approved rescue can read", (await readIncident(tokens[1], orgs[1], incidentId, meta)).incident.id === incidentId);
		await partnerParticipationAction(tokens[4], orgs[4], participantIds[4], "decline", meta);
		await denied("Declined logistics cannot read", () => readIncident(tokens[4], orgs[4], incidentId, meta));
		const req = await addIncidentResourceRequest(tokens[0], orgs[0], incidentId, {
			requestedFrom: "Foothills Logistics — Exercise",
			resourceKind: "logistics",
			description: "EXERCISE: transport support; simulated agency reports unavailable",
			priority: "routine"
		}, meta);
		await setIncidentResourceRequestStatus(tokens[0], orgs[0], incidentId, {
			requestId: req.id,
			status: "denied"
		}, meta);
	});
	await step("UAS joins with view-only incident access", async () => {
		await partnerParticipationAction(tokens[3], orgs[3], participantIds[3], "accept", meta);
		await ownerParticipantAction(tokens[0], orgs[0], incidentId, participantIds[3], "restrict_partner", meta, "EXERCISE view-only scope");
		await denied("View-only partner cannot edit command", () => saveIcsProfile(tokens[3], orgs[3], incidentId, {
			commandMode: "single",
			incidentCommander: "Unauthorized overwrite"
		}, meta));
	});
	await step("Delayed aviation and communications respond", async () => {
		for (const i of [2, 6]) await partnerParticipationAction(tokens[i], orgs[i], participantIds[i], "accept", meta);
	});
	const assigned = [], requestIds = [];
	for (const i of [
		1,
		2,
		6
	]) await step("Deploy simulated " + {
		1: "rescue",
		2: "aviation",
		6: "communications"
	}[i], async () => {
		const resourceId = id("resource:" + i);
		const req = await addIncidentResourceRequest(tokens[0], orgs[0], incidentId, {
			requestedFrom: [
				"",
				"Blue Ridge Rescue — Exercise",
				"Mountain Air Support — Exercise",
				"",
				"",
				"",
				"Ridge Communications — Exercise"
			][i],
			requestedBy: "Anconison exercise command",
			resourceKind: i === 2 ? "aviation" : i === 6 ? "communications" : "specialty_team",
			description: "EXERCISE: fictional coordination support",
			priority: i === 2 ? "high" : "routine"
		}, meta);
		requestIds.push(req.id);
		await shareResource(tokens[i], orgs[i], {
			resourceId,
			incidentId,
			classification: "participating_orgs",
			disclosureProfile: "summary"
		}, meta);
		const a = await assignToIncident(tokens[i], orgs[i], {
			incidentId,
			assignmentType: "resource",
			resourceId,
			assignedRole: "other",
			disclosureProfile: "summary"
		}, meta);
		assigned.push({
			i,
			id: a.id
		});
		await setAssignmentStatus(tokens[i], orgs[i], {
			assignmentId: a.id,
			status: "active"
		}, meta);
		await reportResourceLocation(tokens[i], orgs[i], {
			resourceId,
			locationKind: "temporary",
			point: {
				type: "Point",
				coordinates: [-82.58 + i * .012, 35.55 + i * .012]
			},
			precisionPolicy: "approximate",
			note: "EXERCISE ONLY: fictional reported position",
			positionSource: "manual",
			validForHours: 1
		}, meta);
		await setIncidentResourceRequestStatus(tokens[0], orgs[0], incidentId, {
			requestId: req.id,
			status: "filled"
		}, meta);
		const disclosed = await readResource(tokens[0], orgs[0], resourceId, meta);
		check("Resource " + i + " ownership preserved", disclosed.orgId === orgs[i]);
		check("Resource " + i + " owner-only notes withheld", !JSON.stringify(disclosed).includes("EXERCISE_OWNER_ONLY_CANARY"));
	});
	await step("Verify cross-agency resource boundaries", async () => {
		await denied("Partner cannot change another agency resource", () => setResourceStatus(tokens[3], orgs[3], {
			resourceId: id("resource:2"),
			readinessStatus: "unavailable"
		}, meta));
		check("Observer sees three assignments", (await listIncidentAssignments(tokens[0], orgs[0], incidentId, meta)).length === 3);
	});
	await step("Communications reconnects and then loses access", async () => {
		const before = await readIncident(tokens[6], orgs[6], incidentId, meta);
		await sleep(rehearsal ? 10 : 2e3);
		const after = await readIncident(tokens[6], orgs[6], incidentId, meta);
		check("Repeated read retains same incident", before.incident.id === after.incident.id);
		await ownerParticipantAction(tokens[0], orgs[0], incidentId, participantIds[6], "revoke_partner", meta, "EXERCISE access revocation");
		await denied("Revoked agency cannot read", () => readIncident(tokens[6], orgs[6], incidentId, meta));
	});
	await step("Verify unanswered medical invitation expiration", async () => {
		if (rehearsal) {
			await sleep(1100);
			await owner.query("SET ROLE airs_maintenance");
			try {
				await owner.query("SELECT * FROM airs.run_incident_expiration(gen_random_uuid())");
			} finally {
				await owner.query("RESET ROLE");
			}
		}
		await denied("Expired invitation cannot be accepted", () => partnerParticipationAction(tokens[5], orgs[5], participantIds[5], "accept", meta), ["participation_inactive"]);
		await denied("Unanswered agency cannot read", () => readIncident(tokens[5], orgs[5], incidentId, meta));
		emit("expiration.observation", {
			status: (await listParticipants(tokens[0], orgs[0], incidentId, meta)).find((r) => r.id === participantIds[5])?.invitationStatus,
			note: "Access expiration is checked at read/accept time; scheduled maintenance materializes expired status."
		});
	});
	for (const concurrency of [
		2,
		5,
		10
	]) await step("Bounded service-read check " + concurrency, async () => {
		const timings = [];
		let errors = 0, total = 0;
		const active = /* @__PURE__ */ new Set();
		const until = Date.now() + (rehearsal ? 300 : 6e4);
		let lastGate = 0, peak = 0;
		while (Date.now() < until) {
			if (Date.now() - lastGate > 5e3) {
				await gate();
				lastGate = Date.now();
			}
			if (active.size >= concurrency) await Promise.race(active);
			const t = Date.now();
			const p = readIncident(tokens[1], orgs[1], incidentId, meta).then(() => {
				timings.push(Date.now() - t);
			}).catch(() => {
				errors++;
			}).finally(() => {
				active.delete(p);
			});
			active.add(p);
			peak = Math.max(peak, active.size);
			total++;
			await sleep(250);
			if (errors > 0) throw Error("Service read error; bounded load stopped");
		}
		await Promise.all(active);
		timings.sort((a, b) => a - b);
		const p95 = timings[Math.max(0, Math.ceil(timings.length * .95) - 1)] ?? 0;
		check("Service reads with concurrency cap " + concurrency, errors === 0 && p95 <= 2e3, {
			requests: total,
			errors,
			p95Ms: p95,
			concurrencyCap: concurrency,
			observedPeak: peak,
			rateCeiling: 4,
			scope: "internal authenticated service + RLS; not HTTP load or capacity proof"
		});
	});
	await step("Release simulated assignments", async () => {
		for (const a of assigned) await endAssignment(tokens[a.i], orgs[a.i], {
			assignmentId: a.id,
			status: "completed",
			reason: "EXERCISE complete"
		}, meta);
	});
	stage = "Close exercise and verify access ends";
	await gate();
	const closing = await beginClosure(tokens[0], orgs[0], incidentId, {
		expectedVersion: (await room()).version,
		reason: "EXERCISE completed; no real-world response was conducted"
	}, meta);
	await sleep(rehearsal ? 20 : 2e4);
	await closeIncident(tokens[0], orgs[0], incidentId, { expectedVersion: closing.version }, meta);
	for (const i of [
		1,
		2,
		3,
		6
	]) await denied("Closed incident denies former agency " + i, () => readIncident(tokens[i], orgs[i], incidentId, meta));
	check("Owner retains lifecycle history", (await readIncidentAudit(tokens[0], orgs[0], incidentId, meta)).some((e) => e.action === "incident.closed"));
	completed = true;
	emit("exercise.completed", {
		incidentId,
		checks: results.length,
		results,
		notProven: [
			"HTTP/browser load and reconnection",
			"maximum production capacity",
			"restore",
			"rollback",
			"alert delivery"
		]
	});
}
try {
	await main();
} catch (e) {
	emit("exercise.failed", {
		message: e instanceof Error ? e.message : "unknown",
		...rehearsal && e instanceof Error ? { stack: e.stack } : {},
		results
	});
	process.exitCode = 1;
	await owner.query("ROLLBACK").catch(() => {});
	if (activated && !completed) try {
		const r = await room();
		if (r.status === "active") await pauseIncident(tokens[0], orgs[0], incidentId, r.version, meta);
	} catch {}
} finally {
	for (const hash of hashes) await owner.query("UPDATE airs.sessions SET revoked_at=now() WHERE token_hash=$1", [hash]).catch(() => {});
	await getDatabase().close().catch(() => {});
	await owner.end().catch(() => {});
}
//#endregion
export {};
