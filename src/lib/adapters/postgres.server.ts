// Reference DatabaseAdapter for plain PostgreSQL (local Docker, RDS, Cloud SQL,
// or any managed Postgres). Requires the `pg` package at runtime; it is loaded
// lazily so the module can be imported in environments without it installed.
import type { DatabaseAdapter, QueryRunner } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPostgresAdapter(connectionString: string): DatabaseAdapter {
  let poolPromise: Promise<any> | undefined;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = import("pg").then((pg) => {
        const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
        return new Pool({ connectionString, max: 10 });
      });
    }
    return poolPromise;
  }

  return {
    async withTenant(ctx, fn) {
      if (!UUID.test(ctx.orgId) || !UUID.test(ctx.userId)) {
        throw new Error("withTenant requires valid uuid orgId and userId");
      }
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('airs.org_id', $1, true)", [ctx.orgId]);
        await client.query("SELECT set_config('airs.user_id', $1, true)", [ctx.userId]);
        const runner: QueryRunner = {
          query: async (sql, params) => (await client.query(sql, params ?? [])).rows,
        };
        const result = await fn(runner);
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
    },
  };
}