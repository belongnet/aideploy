/**
 * OpenClaw Master Dashboard — Database query layer
 *
 * Prefers the Supabase PostgREST client for standard table queries.
 * Falls back to raw pg for complex queries (cross-schema, JOINs with
 * dynamic schema names) that PostgREST cannot express.
 *
 * This avoids creating a new pg connection per request while still
 * supporting queries that PostgREST can't handle.
 */

import { supabase } from "./supabase";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://openclaw:openclaw@localhost:5432/openclaw";
const PG_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function quoteIdentifier(identifier: string, label = "identifier"): string {
  if (!PG_IDENTIFIER_RE.test(identifier)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return `"${identifier}"`;
}

function selectList(select?: string): string {
  const raw = select?.trim();
  if (!raw || raw === "*") return "*";
  return raw
    .split(",")
    .map((column) => quoteIdentifier(column.trim(), "select column"))
    .join(", ");
}

/**
 * Execute a raw SQL query via pg (for complex/cross-schema queries).
 * Creates and closes a connection per call.
 */
export async function rawQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows as T[];
    } finally {
      await client.end();
    }
  } catch {
    console.warn("[db] Database unavailable");
    return [];
  }
}

/**
 * Query a public table via Supabase PostgREST.
 * Falls back to rawQuery if Supabase client is not available.
 */
export async function fromTable<T = Record<string, unknown>>(
  table: string,
  opts?: {
    select?: string;
    filters?: Array<{ column: string; op: "eq" | "gt" | "gte" | "lt" | "lte" | "neq"; value: unknown }>;
    order?: { column: string; ascending?: boolean };
    limit?: number;
  },
): Promise<T[]> {
  const sb = supabase();
  if (!sb) {
    // Fallback: build a simple SELECT via raw SQL
    const cols = selectList(opts?.select);
    let sql = `SELECT ${cols} FROM public.${quoteIdentifier(table, "table")}`;
    const params: unknown[] = [];
    let idx = 1;
    if (opts?.filters?.length) {
      const conds = opts.filters.map((f) => {
        const opMap = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", neq: "!=" };
        params.push(f.value);
        return `${quoteIdentifier(f.column, "filter column")} ${opMap[f.op]} $${idx++}`;
      });
      sql += ` WHERE ${conds.join(" AND ")}`;
    }
    if (opts?.order) {
      sql += ` ORDER BY ${quoteIdentifier(opts.order.column, "order column")} ${opts.order.ascending ? "ASC" : "DESC"}`;
    }
    if (opts?.limit) {
      sql += ` LIMIT ${opts.limit}`;
    }
    return rawQuery<T>(sql, params);
  }

  let query = sb.from(table).select(opts?.select ?? "*");
  if (opts?.filters) {
    for (const f of opts.filters) {
      query = query.filter(f.column, f.op, f.value);
    }
  }
  if (opts?.order) {
    query = query.order(opts.order.column, {
      ascending: opts.order.ascending ?? true,
    });
  }
  if (opts?.limit) {
    query = query.limit(opts.limit);
  }

  const { data, error } = await query;
  if (error) {
    console.warn(`[db] Supabase query on ${table} failed:`, error.message);
    return [];
  }
  return (data ?? []) as T[];
}
