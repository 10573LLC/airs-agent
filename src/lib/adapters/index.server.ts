// Adapter registry. Selection is environment driven; nothing here is
// builder-specific. Adding an implementation = adding a case.
import { createPostgresAdapter } from "./postgres.server";
import type { DatabaseAdapter } from "./types";

let db: DatabaseAdapter | undefined;

export function getDatabase(): DatabaseAdapter {
  if (db) return db;
  const driver = process.env.DB_DRIVER ?? "postgres";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  switch (driver) {
    case "postgres":
      db = createPostgresAdapter(url);
      return db;
    default:
      throw new Error(`Unsupported DB_DRIVER: ${driver}`);
  }
}

export type { DatabaseAdapter, AuthAdapter, RealtimeAdapter, ObjectStorageAdapter, AuditSink } from "./types";