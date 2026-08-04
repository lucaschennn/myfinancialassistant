import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { NextConfig } from 'next';

/**
 * Load the monorepo's root `.env` before Next compiles anything.
 *
 * Next only reads `.env` from its own project root — `apps/web/` — so the
 * root file every other part of the repo uses is invisible to it. Duplicating
 * secrets into a second `.env` would be the obvious fix and the wrong one: two
 * files holding the same keys drift, and one of them eventually gets committed.
 *
 * This has to happen here rather than in a runtime helper. `NEXT_PUBLIC_*`
 * variables are inlined into the client bundle at compile time, so a loader
 * that runs when a request arrives is already too late — the publishable key
 * would be baked in as `undefined`. `next.config.ts` is evaluated before
 * compilation, which is early enough for both that and the server-side vars.
 *
 * Walks upward rather than hardcoding `../../.env`, mirroring
 * `packages/db/src/env.ts`, so neither breaks if the layout moves.
 */
function loadRootEnv(): void {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      // `override: false` so a real platform variable always wins — on Vercel
      // the env comes from the dashboard and there is no file at all.
      dotenv.config({ path: candidate, override: false, quiet: true });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  // The workspace packages ship raw TypeScript (`"main": "./src/index.ts"`)
  // rather than a build step, so Next must compile them itself.
  transpilePackages: ['@pfg/core', '@pfg/db', '@pfg/plaid'],

  // `postgres` opens real sockets — it must stay a Node module rather than
  // being bundled into the server build.
  serverExternalPackages: ['postgres'],

  /**
   * The workspace packages are written for NodeNext, so their relative imports
   * carry `.js` extensions pointing at `.ts` files on disk. `tsc`, `tsx`, and
   * Vitest all perform that substitution natively; bundlers resolve `.js`
   * literally and fail. `extensionAlias` teaches the resolver the same rule.
   *
   * This is why `dev` and `build` pass `--webpack`: as of Next 16.2,
   * `extensionAlias` is a webpack-only option and Turbopack ignores it, so a
   * Turbopack build fails on every one of those imports. The cost is build
   * speed and nothing else.
   *
   * The durable fix is to give the packages a real build step emitting `.js`
   * to `dist/`, which would drop this config and the flag together. That is a
   * deliberate change to the repo's no-build-step design, so it is flagged
   * rather than made unilaterally.
   */
  experimental: {
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    },
  },
};

export default nextConfig;
