/**
 * Environment loading that does not depend on the current working directory.
 *
 * `import 'dotenv/config'` resolves `.env` against `process.cwd()`, which
 * quietly breaks in a monorepo: `npm run migrate -w @pfg/db` runs with cwd set
 * to `packages/db`, so the root `.env` is invisible and every variable reads as
 * undefined. Walking up from this file instead makes the lookup independent of
 * how a script was invoked.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

let loadedFrom: string | null = null;

/**
 * Find and load the nearest `.env`, searching upward from this module toward
 * the filesystem root. Idempotent — later calls are no-ops.
 *
 * Returns the path it loaded, or null when no file was found (which is the
 * normal case in production, where variables come from the platform).
 */
export function loadEnv(): string | null {
  if (loadedFrom) return loadedFrom;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      // `override: false` so a real environment variable always beats the file
      // — deploys must not be shadowed by a stray .env.
      dotenv.config({ path: candidate, override: false, quiet: true });
      loadedFrom = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
