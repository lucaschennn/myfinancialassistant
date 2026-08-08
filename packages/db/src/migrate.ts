import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';
import { directConnectionString, loadEnv } from './env.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Migrations deliberately do NOT use the pooled connection the app runs on.
// See directConnectionString() for why the pooler breaks the migrator.
loadEnv();
const variable = process.env.DATABASE_URL_UNPOOLED ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL';

const { db, sql } = createDb({ connectionString: directConnectionString() });
try {
  await migrate(db, { migrationsFolder });
  // The variable name, never its value — a connection string carries credentials.
  console.log(`Migrations applied from ${migrationsFolder} (connected via ${variable})`);
} finally {
  await sql.end();
}
