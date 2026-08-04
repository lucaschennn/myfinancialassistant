/**
 * These run against real Postgres rather than a fake.
 *
 * The behaviour worth testing here is not the TypeScript — it is the upsert
 * resolving a race to one row, and that lives in the unique constraint, not in
 * this file. A mocked drizzle would assert that we call the methods we call,
 * which proves nothing. So: hit the dev database when one is configured, skip
 * cleanly when there isn't (CI, or a fresh clone before `db:up`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, closeDb, getDb, loadEnv, users } from '@pfg/db';
import { eq, inArray } from 'drizzle-orm';
import { MissingAuthSubjectError, claimSeededUser, findUser, resolveUser } from './users.js';

loadEnv();

const hasDb = Boolean(process.env.DATABASE_URL);

// Every row this file creates is tagged so cleanup can find them all without
// any chance of matching the sandbox user (§ STATE.md keeps that one linked).
const TAG = `test-users-${Date.now()}`;
const authId = (suffix: string) => `${TAG}-${suffix}`;
const emailFor = (suffix: string) => `${TAG}-${suffix}@example.test`;

describe.skipIf(!hasDb)('user store', () => {
  let db: Database;
  const createdIds: string[] = [];

  const track = <T extends { id: string }>(user: T): T => {
    createdIds.push(user.id);
    return user;
  };

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdIds));
    }
    await closeDb();
  });

  it('creates a row on first sight of a Clerk subject', async () => {
    const user = track(
      await resolveUser(db, { authProviderId: authId('new'), email: emailFor('new') }),
    );

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.created).toBe(true);
    // The Clerk id is mirrored, never used as the primary key — everything
    // downstream scopes on the UUID (§3).
    expect(user.id).not.toBe(authId('new'));
  });

  it('returns the same UUID on every later request', async () => {
    const first = track(await resolveUser(db, { authProviderId: authId('stable') }));
    const second = await resolveUser(db, { authProviderId: authId('stable') });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
  });

  it('resolves a first-request race to one row, not a duplicate-key error', async () => {
    // Two requests from a brand-new user arriving together — a page load and
    // its data fetch. Both find nothing; both insert.
    const [a, b] = await Promise.all([
      resolveUser(db, { authProviderId: authId('race'), email: emailFor('race') }),
      resolveUser(db, { authProviderId: authId('race'), email: emailFor('race') }),
    ]);

    track(a);
    expect(b.id).toBe(a.id);

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.authProviderId, authId('race')));
    expect(rows).toHaveLength(1);
  });

  it('refreshes a changed email but never nulls a known one', async () => {
    const created = track(
      await resolveUser(db, { authProviderId: authId('email'), email: emailFor('email') }),
    );

    const renamed = await resolveUser(db, {
      authProviderId: authId('email'),
      email: 'changed@example.test',
    });
    expect(renamed.email).toBe('changed@example.test');

    // An id-only token must not erase the address captured at sign-up.
    const idOnly = await resolveUser(db, { authProviderId: authId('email') });
    expect(idOnly.email).toBe('changed@example.test');
    expect(idOnly.id).toBe(created.id);
  });

  it('refuses an unauthenticated request', async () => {
    await expect(resolveUser(db, { authProviderId: '' })).rejects.toThrow(
      MissingAuthSubjectError,
    );
  });

  describe('claiming a seeded user', () => {
    it('adopts a Phase 0 row so its linked Plaid item is not orphaned', async () => {
      const [seeded] = await db
        .insert(users)
        .values({ email: emailFor('seeded'), authProviderId: null })
        .returning();
      track(seeded!);

      const claimed = await claimSeededUser(db, {
        authProviderId: authId('seeded'),
        email: emailFor('seeded'),
      });

      // Same row — so plaid_items and user_profile still point at it.
      expect(claimed?.id).toBe(seeded!.id);

      const resolved = await resolveUser(db, { authProviderId: authId('seeded') });
      expect(resolved.id).toBe(seeded!.id);
    });

    it('leaves no orphan when the sign-in path adopts a seeded row', async () => {
      // The ordering constraint behind `findUser` existing at all: provisioning
      // before attempting the claim creates a row, then adopts a different one,
      // and the user silently loses the linked item on the row they kept.
      const [seeded] = await db
        .insert(users)
        .values({ email: emailFor('orphan'), authProviderId: null })
        .returning();
      track(seeded!);

      // The real sign-in sequence from apps/web/src/server/auth.ts.
      expect(await findUser(db, authId('orphan'))).toBeNull();
      const claimed = await claimSeededUser(db, {
        authProviderId: authId('orphan'),
        email: emailFor('orphan'),
      });

      expect(claimed?.id).toBe(seeded!.id);
      const withEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, emailFor('orphan')));
      expect(withEmail).toHaveLength(1);
    });

    it('refuses to take over a row another Clerk account already owns', async () => {
      track(
        await resolveUser(db, {
          authProviderId: authId('owned'),
          email: emailFor('owned'),
        }),
      );

      // Same email, different Clerk subject. Matching on email is only safe
      // for unclaimed rows; this is the case that makes it safe.
      const stolen = await claimSeededUser(db, {
        authProviderId: authId('attacker'),
        email: emailFor('owned'),
      });

      expect(stolen).toBeNull();
    });
  });
});
