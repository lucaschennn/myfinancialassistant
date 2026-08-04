/**
 * The user store (§3): the bridge between Clerk's identity and our `users.id`.
 *
 * Clerk owns authentication. This table mirrors the minimum needed to scope
 * rows, and the mapping runs in exactly one direction: a Clerk subject id
 * (`user_...`) resolves to the UUID that every other table's `user_id` foreign
 * key points at. Nothing downstream ever sees a Clerk id — `ctx.userId` is
 * always our UUID, so §3 Isolation stays a single well-defined predicate.
 *
 * Provisioning is just-in-time rather than webhook-driven. A Clerk webhook needs
 * a publicly reachable endpoint, which localhost is not, so the MVP would have
 * needed a tunnel to develop against. Upserting on first authenticated request
 * removes that dependency entirely and cannot drift: there is no window in which
 * a session exists but its row does not, because the row is created by the same
 * request that first needs it. A webhook becomes worth adding for `user.deleted`
 * (cascade cleanup), which JIT provisioning genuinely cannot express.
 */

import { type Database, users } from '@pfg/db';
import { eq } from 'drizzle-orm';

export interface ResolveUserParams {
  /** Clerk subject id, e.g. `user_2abc...`. Never stored as `users.id`. */
  authProviderId: string;
  /** Primary email from the Clerk session, when the token carries one. */
  email?: string | null;
}

export interface ResolvedUser {
  /** Our UUID — this is what becomes `ctx.userId`. */
  id: string;
  authProviderId: string;
  email: string | null;
  /** True when this request is what created the row. */
  created: boolean;
}

export class MissingAuthSubjectError extends Error {
  constructor() {
    super('resolveUser requires a Clerk subject id. An unauthenticated request reached it.');
    this.name = 'MissingAuthSubjectError';
  }
}

/**
 * Look up a Clerk subject without provisioning.
 *
 * Separate from `resolveUser` because the caller sometimes needs to know "does
 * this user exist yet?" before deciding what to do — specifically, whether to
 * try adopting a seeded row. Creating first and adopting second would leave two
 * rows, one of them orphaned.
 */
export async function findUser(
  db: Database,
  authProviderId: string,
): Promise<ResolvedUser | null> {
  if (!authProviderId) throw new MissingAuthSubjectError();

  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.authProviderId, authProviderId))
    .limit(1);

  if (!row) return null;
  return { id: row.id, authProviderId, email: row.email, created: false };
}

/**
 * Find or create the `users` row for a Clerk subject.
 *
 * The insert is an upsert on `auth_provider_id` rather than a read-then-insert,
 * because two requests from a brand-new user can race — a page load and its
 * data fetch arrive together, both find nothing, and both insert. The unique
 * constraint plus `onConflictDoUpdate` makes that race resolve to one row
 * instead of a 23505 shown to a user on their first ever page.
 *
 * Deliberately NOT an `onConflictDoNothing`: that returns no row on conflict,
 * which would put us back to a second read to get the id.
 */
export async function resolveUser(
  db: Database,
  params: ResolveUserParams,
): Promise<ResolvedUser> {
  const { authProviderId } = params;
  if (!authProviderId) throw new MissingAuthSubjectError();

  const email = params.email ?? null;

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.authProviderId, authProviderId))
    .limit(1);

  if (existing) {
    // Keep the mirrored email fresh when Clerk's has changed, but never write
    // a null over a value we already have — an id-only token should not erase
    // an address captured at sign-up.
    if (email && email !== existing.email) {
      await db.update(users).set({ email }).where(eq(users.id, existing.id));
      return { id: existing.id, authProviderId, email, created: false };
    }
    return {
      id: existing.id,
      authProviderId,
      email: existing.email,
      created: false,
    };
  }

  const [row] = await db
    .insert(users)
    .values({ authProviderId, email })
    .onConflictDoUpdate({
      target: users.authProviderId,
      // A no-op write that still returns the row the racing insert created.
      set: { authProviderId },
    })
    .returning();

  if (!row) throw new Error('resolveUser: upsert returned no row.');

  return {
    id: row.id,
    authProviderId,
    email: row.email,
    // `created` reports whether the row is new, not whether THIS statement made
    // it — on a lost race the other request created it microseconds earlier.
    created: row.createdAt.getTime() > Date.now() - 5_000,
  };
}

/**
 * Adopt a pre-existing row that has no `auth_provider_id` yet.
 *
 * Phase 0 seeded a sandbox user directly (`scripts/link-sandbox-item.ts`), so it
 * has a linked Plaid item and a profile but no Clerk identity. Without this, the
 * first Clerk sign-in would create a second, empty row and the sandbox item
 * would look lost. Matching on email is safe here precisely because it only
 * considers rows that were never claimed by an auth provider.
 */
export async function claimSeededUser(
  db: Database,
  params: { authProviderId: string; email: string },
): Promise<ResolvedUser | null> {
  const [seeded] = await db
    .select()
    .from(users)
    .where(eq(users.email, params.email))
    .limit(1);

  if (!seeded || seeded.authProviderId !== null) return null;

  await db
    .update(users)
    .set({ authProviderId: params.authProviderId })
    .where(eq(users.id, seeded.id));

  return {
    id: seeded.id,
    authProviderId: params.authProviderId,
    email: seeded.email,
    created: false,
  };
}
