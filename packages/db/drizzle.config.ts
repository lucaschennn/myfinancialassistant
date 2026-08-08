import { defineConfig } from 'drizzle-kit';
import { directConnectionString } from './src/env.js';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Schema work (studio, push) wants the direct connection for the same
    // reason migrations do. `directConnectionString()` loads .env itself —
    // drizzle-kit runs with cwd set to packages/db, where there is no .env.
    url: directConnectionString() ?? '',
  },
  strict: true,
  verbose: true,
});
