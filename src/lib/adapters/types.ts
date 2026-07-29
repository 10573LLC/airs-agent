// Adapter contracts. Every managed/external capability sits behind one of these
// interfaces so the implementation can be swapped without touching app code.

export interface DatabaseAdapter {
  /**
   * Runs `fn` inside a transaction with the tenant session context applied
   * (SET LOCAL airs.org_id / airs.user_id), so PostgreSQL RLS enforces tenancy.
   */
  withTenant<T>(
    ctx: { orgId: string; userId: string },
    fn: (q: QueryRunner) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface QueryRunner {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface AuthAdapter {
  /** Verifies a bearer credential and returns the identity, or null. Never throws for invalid input. */
  verify(token: string): Promise<AuthIdentity | null>;
}

export interface AuthIdentity {
  subject: string;
  email: string;
  orgSlug: string;
}

export interface RealtimeAdapter {
  publish(channel: string, event: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (event: string, payload: unknown) => void): () => void;
}

export interface ObjectStorageAdapter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface AuditSink {
  record(event: {
    orgId: string;
    actorUserId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome: "allow" | "deny" | "error";
    detail?: Record<string, unknown>;
    ipAddress?: string | null;
  }): Promise<void>;
}