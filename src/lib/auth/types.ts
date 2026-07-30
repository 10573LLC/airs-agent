// Replaceable authentication contract.
//
// The application never talks to a credential store directly: it talks to an
// AuthAdapter. `local` (self-hosted credentials in PostgreSQL) is the shipped
// implementation; an OIDC driver only has to implement the same surface and be
// registered in src/lib/auth/index.server.ts. Nothing here is builder specific.

import type { RoleKey } from "@/lib/rbac/roles";

export type MembershipStatus = "invited" | "active" | "suspended" | "revoked";

export interface AccountIdentity {
  accountId: string;
  email: string;
  displayName: string;
  /** Reserved: MFA is designed for but NOT implemented. */
  mfaEnrolled: boolean;
}

export interface MembershipView {
  membershipId: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  userId: string;
  roleKey: RoleKey;
  status: MembershipStatus;
}

export interface SessionView {
  sessionId: string;
  accountId: string;
  activeOrgId: string | null;
  expiresAt: string;
}

export interface AuthenticatedContext {
  session: SessionView;
  account: AccountIdentity;
  memberships: MembershipView[];
}

export interface SignInResult {
  ok: boolean;
  token?: string;
  expiresAt?: string;
  reason?: "invalid_credentials" | "account_disabled" | "mfa_required";
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface AuthAdapter {
  readonly driver: string;
  /** Verifies a credential and creates a server-side session. */
  signIn(email: string, password: string, meta: RequestMeta): Promise<SignInResult>;
  /** Revokes the session behind the presented token. */
  signOut(token: string, meta: RequestMeta): Promise<void>;
  /** Validates a session token; returns null for missing/expired/revoked/tampered tokens. */
  resolve(token: string | null | undefined): Promise<AuthenticatedContext | null>;
  /** Revokes every session of an account (used on password change / admin action). */
  revokeAllSessions(accountId: string, meta: RequestMeta): Promise<number>;
  /** Starts a recovery flow; returns the opaque token to deliver out of band. */
  startPasswordReset(email: string): Promise<string | null>;
  /** Completes a recovery flow and revokes all existing sessions. */
  completePasswordReset(token: string, newPassword: string): Promise<boolean>;
  /**
   * Maps an already-authenticated external identity (OIDC subject) onto an
   * internal account. The local driver uses it for invitation binding.
   */
  upsertIdentity(input: {
    email: string;
    displayName: string;
    password?: string;
    externalIssuer?: string;
    externalSubject?: string;
  }): Promise<AccountIdentity>;
}