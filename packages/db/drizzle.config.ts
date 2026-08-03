import { defineConfig } from 'drizzle-kit';
import { loadEnv } from './src/env.js';

// Not `dotenv/config`: drizzle-kit runs with cwd set to packages/db, where
// there is no .env. See src/env.ts.
loadEnv();

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
