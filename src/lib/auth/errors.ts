// Typed access failures. Every deny path in the server-side chain raises one
// of these; the transport layer maps `status` onto HTTP and `code` onto a UI
// state. No message ever contains credentials or tenant data.

export type AccessCode =
  | "unauthenticated"
  | "session_invalid"
  | "no_active_org"
  | "not_a_member"
  | "membership_invited"
  | "membership_suspended"
  | "membership_revoked"
  | "forbidden"
  | "tenant_mismatch"
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_revoked"
  | "invitation_used"
  | "invitation_wrong_recipient"
  | "invalid_input";

const STATUS: Record<AccessCode, number> = {
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
  invalid_input: 400,
};

export class AccessError extends Error {
  readonly code: AccessCode;
  readonly status: number;
  constructor(code: AccessCode, message?: string) {
    super(message ?? code);
    this.name = "AccessError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isAccessError(value: unknown): value is AccessError {
  return value instanceof AccessError;
}