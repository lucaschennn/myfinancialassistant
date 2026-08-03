import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from './env.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: { db: Database; sql: postgres.Sql } | null = null;

export interface DbOptions {
  connectionString?: string;
  /**
   * Serverless functions should keep this at 1 — each invocation is its own
   * process and a larger pool just burns Postgres connection slots.
   */
  max?: number;
}

export function createDb(options: DbOptions = {}): { db: Database; sql: postgres.Sql } {
  const envFile = loadEnv();
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. ' +
        (envFile
          ? `Loaded ${envFile}, but it has no DATABASE_URL line.`
          : 'No .env file was found above packages/db — copy .env.example to .env at the repo root.'),
    );
  }
  const sql = postgres(connectionString, {
    max: options.max ?? 1,
    // bigint columns must arrive as JS BigInt, not string or number — the
    // no-floats rule (§0.3) depends on this parser being in place.
    types: {
      bigint: postgres.BigInt,
    },
  });
  return { db: drizzle(sql, { schema }), sql };
}

/** Process-wide handle for long-lived processes (MCP harness, scripts). */
export function getDb(): Database {
  cached ??= createDb();
  return cached.db;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end();
    cached = null;
  }
}
