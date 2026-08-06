// AIRS Agent - deterministic transform of a canonical migration into an
// idempotent reconciliation body.
//
// Reconciliation never hand-copies schema: it replays the CURRENT canonical
// migration text with create-statements made safe to re-run, so a reconciled
// database is definitionally identical to a freshly migrated one. Nothing is
// dropped except policies and triggers, which are re-created immediately from
// the same canonical definition inside the same transaction.
//
// `already exists` is never swallowed: the transform makes re-creation a no-op
// up front instead of ignoring errors after the fact.

/** CREATE TABLE airs.x -> CREATE TABLE IF NOT EXISTS airs.x */
function tables(sql) {
  return sql.replace(/\bCREATE TABLE\s+(?!IF NOT EXISTS)(airs\.[A-Za-z0-9_]+)/g, "CREATE TABLE IF NOT EXISTS $1");
}

/** CREATE [UNIQUE] INDEX name -> ... IF NOT EXISTS name */
function indexes(sql) {
  return sql.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)([A-Za-z0-9_]+)/g, (_m, uniq, name) =>
    `CREATE ${uniq ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${name}`);
}

/** CREATE POLICY p ON airs.t -> DROP POLICY IF EXISTS p ON airs.t; CREATE POLICY ... */
function policies(sql) {
  return sql.replace(/\bCREATE POLICY\s+([A-Za-z0-9_]+)\s+ON\s+(airs\.[A-Za-z0-9_]+)/g, (m, name, tbl) =>
    `DROP POLICY IF EXISTS ${name} ON ${tbl};\n${m}`);
}

/**
 * CREATE TRIGGER t ... ON airs.x ...; -> DROP TRIGGER IF EXISTS t ON airs.x;
 * before it. The table name is read from the same statement (triggers never
 * contain dollar-quoted bodies, so scanning to the next `;` is safe).
 */
function triggers(sql) {
  return sql.replace(/\bCREATE(?:\s+OR\s+REPLACE)?\s+TRIGGER\s+([A-Za-z0-9_]+)[\s\S]*?;/g, (stmt, name) => {
    if (/DROP TRIGGER IF EXISTS/.test(stmt)) return stmt;
    const onTable = /\bON\s+(airs\.[A-Za-z0-9_]+)/.exec(stmt);
    if (!onTable) return stmt;
    return `DROP TRIGGER IF EXISTS ${name} ON ${onTable[1]};\n${stmt}`;
  });
}

/** CREATE TYPE airs.x AS ... -> guarded DO block. */
function types(sql) {
  return sql.replace(/\bCREATE TYPE\s+(airs\.[A-Za-z0-9_]+)([\s\S]*?);/g, (stmt, name, rest) => {
    const bare = name.split(".")[1];
    return [
      "DO $airs_type$ BEGIN",
      `  IF to_regtype('${name}') IS NULL THEN`,
      `    CREATE TYPE ${name}${rest};`,
      "  END IF;",
      `END $airs_type$; -- ${bare}`,
    ].join("\n");
  });
}

/** CREATE SEQUENCE / CREATE SCHEMA / CREATE EXTENSION safety. */
function misc(sql) {
  return sql
    .replace(/\bCREATE SCHEMA\s+(?!IF NOT EXISTS)/g, "CREATE SCHEMA IF NOT EXISTS ")
    .replace(/\bCREATE SEQUENCE\s+(?!IF NOT EXISTS)/g, "CREATE SEQUENCE IF NOT EXISTS ")
    .replace(/\bCREATE EXTENSION\s+(?!IF NOT EXISTS)/g, "CREATE EXTENSION IF NOT EXISTS ");
}

/** Statements the transform must never produce. Checked by tests and at runtime. */
export const FORBIDDEN_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+ROLE\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

/** Returns the destructive statements found in `sql` (empty array when safe). */
export function destructiveStatements(sql) {
  return FORBIDDEN_PATTERNS.filter((re) => re.test(String(sql ?? ""))).map((re) => re.source);
}

/** Collapses a DROP the canonical migration already performs itself. */
function dedupeDrops(sql) {
  const lines = sql.split("\n");
  const out = [];
  for (const line of lines) {
    const isDrop = /^\s*DROP (TRIGGER|POLICY) IF EXISTS /.test(line);
    if (isDrop) {
      const previous = [...out].reverse().find((l) => l.trim() !== "");
      if (previous && previous.trim() === line.trim()) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Transforms canonical migration SQL into a re-runnable reconciliation body. */
export function toIdempotentSql(sql) {
  return dedupeDrops(misc(triggers(policies(indexes(types(tables(String(sql ?? "")))))))); 
}
