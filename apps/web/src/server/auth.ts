/**
 * The one place a Clerk identity becomes a `ctx.userId` (§3 Isolation).
 *
 * §3 says user scoping is "enforced by convention in the core package" — every
 * query filters on `ctx.userId`. A convention needs exactly one place that
 * decides what that id is, or the guarantee is only as good as the least careful
 * route handler. That place is `requireCtx()`. No route builds a `Ctx` by hand,
 * and no route reads `auth()` directly to get an id it then trusts.
 *
 * The Clerk subject id is never used as `ctx.userId`. It resolves through the
 * user store to our UUID, which is what every foreign key points at.
 */

import { type Ctx, claimSeededUser, findUser, resolveUser } from '@pfg/core';
import { type Database, getDb } from '@pfg/db';
import { auth, currentUser } from '@clerk/nextjs/server';

export class UnauthenticatedError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'UnauthenticatedError';
  }
}

let dbHandle: Database | null = null;

/**
 * `getDb()` caches a pool of 1 (§ packages/db/src/client.ts), which is the right
 * shape for serverless: each invocation is its own process and a bigger pool
 * only burns Neon connection slots.
 */
function db(): Database {
  dbHandle ??= getDb();
  return dbHandle;
}

export interface AuthedUser {
  /** Our UUID. */
  id: string;
  email: string | null;
}

/**
 * Resolve the signed-in user, provisioning their row on first sight.
 *
 * Throws rather than returning null: a route that forgets to check a nullable
 * return would run unscoped, and the failure mode for that is cross-user data
 * leakage. Throwing makes the mistake impossible to write silently.
 */
export async function requireUser(): Promise<AuthedUser> {
  const { userId: clerkId } = await auth();
  if (!clerkId) throw new UnauthenticatedError();

  // Look up before provisioning. Order matters: creating the row first and then
  // trying to adopt a seeded one would leave two rows with the second orphaned.
  const existing = await findUser(db(), clerkId);
  if (existing) {
    // The established path costs one query. We deliberately skip `currentUser()`
    // here rather than refreshing the mirrored email on every request — the
    // email is a convenience copy, and Clerk remains its system of record.
    return { id: existing.id, email: existing.email };
  }

  // First sight of this subject. Now the email is worth fetching, because it is
  // what decides between adopting an existing row and creating a new one.
  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? null;

  if (email) {
    // A Phase 0 seeded row (linked Plaid item, no Clerk identity) should be
    // adopted rather than shadowed by a second empty row. Only matches rows no
    // auth provider has claimed — see `claimSeededUser`.
    const claimed = await claimSeededUser(db(), { authProviderId: clerkId, email });
    if (claimed) return { id: claimed.id, email: claimed.email };
  }

  const created = await resolveUser(db(), { authProviderId: clerkId, email });
  return { id: created.id, email: created.email };
}

/**
 * A `Ctx` with a database handle but no snapshot — for tools that only read
 * Postgres (profile, goals, net worth history). Deliberately does not trigger a
 * Plaid fetch, which is the slow part of any request (§7).
 */
export async function requireCtx(): Promise<Ctx & { userId: string; db: Database }> {
  const user = await requireUser();
  return { userId: user.id, db: db() };
}

export { db as getWebDb };
