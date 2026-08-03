/**
 * Context tools (§4). These are the only core tools that WRITE, and the only
 * ones that read Postgres for user-meaningful values. Everything they touch is
 * user-provided — targets, goals, notes — never Plaid-derived.
 *
 * Every query filters on `ctx.userId` (§3 Isolation). That scoping is the whole
 * of the MVP's multi-tenancy guarantee, so it is never omitted "because the id
 * is already in the row".
 */

import { type Ctx, requireDb } from '../context.js';
import type { Cents } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { type Goal, type ProfileNote, goals, userProfile } from '@pfg/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export interface ProfileData {
  annualIncomeCents: Cents | null;
  targetAnnualSpendCents: Cents | null;
  riskTolerance: string | null;
  notes: ProfileNote[];
}

const EMPTY_PROFILE: ProfileData = {
  annualIncomeCents: null,
  targetAnnualSpendCents: null,
  riskTolerance: null,
  notes: [],
};

function profileProvenance(hasRow: boolean): Provenance {
  return {
    source: 'user',
    asOf: new Date().toISOString(),
    computation: hasRow
      ? 'Values the user entered on their profile.'
      : 'No profile has been set up yet.',
    ...(hasRow ? {} : { notes: ['This user has not set an income or spending target yet.'] }),
  };
}

export async function getProfile(ctx: Ctx): Promise<ToolResult<ProfileData>> {
  const db = requireDb(ctx, 'getProfile');
  const [row] = await db.select().from(userProfile).where(eq(userProfile.userId, ctx.userId));

  if (!row) return result(EMPTY_PROFILE, profileProvenance(false));

  return result(
    {
      annualIncomeCents: row.annualIncomeCents,
      targetAnnualSpendCents: row.targetAnnualSpendCents,
      riskTolerance: row.riskTolerance,
      notes: row.notesJson ?? [],
    },
    profileProvenance(true),
  );
}

export interface UserContextData extends ProfileData {
  goals: Array<{
    id: string;
    type: string;
    label: string | null;
    targetCents: Cents | null;
    targetDate: string | null;
  }>;
}

/** getUserContext (§4): profile + goals + notes, in one read. */
export async function getUserContext(ctx: Ctx): Promise<ToolResult<UserContextData>> {
  const db = requireDb(ctx, 'getUserContext');
  const profile = await getProfile(ctx);
  const goalRows = await db.select().from(goals).where(eq(goals.userId, ctx.userId));

  return result(
    {
      ...profile.data,
      goals: goalRows.map(toGoalLine),
    },
    {
      source: 'user',
      asOf: new Date().toISOString(),
      computation: 'The profile, goals, and notes this user has entered.',
    },
  );
}

function toGoalLine(g: Goal): UserContextData['goals'][number] {
  return {
    id: g.id,
    type: g.type,
    label: g.label,
    targetCents: g.targetCents,
    targetDate: g.targetDate,
  };
}

export interface SetProfileParams {
  annualIncomeCents?: Cents | null;
  targetAnnualSpendCents?: Cents | null;
  riskTolerance?: string | null;
}

/**
 * setProfile (§4). Only the fields actually passed are written — omitting a
 * field leaves the stored value alone rather than nulling it, so a partial
 * update from the chat surface cannot wipe something the user set earlier.
 */
export async function setProfile(
  ctx: Ctx,
  params: SetProfileParams,
): Promise<ToolResult<ProfileData>> {
  const db = requireDb(ctx, 'setProfile');

  const changes: Record<string, unknown> = { updatedAt: new Date() };
  if ('annualIncomeCents' in params) changes.annualIncomeCents = params.annualIncomeCents ?? null;
  if ('targetAnnualSpendCents' in params) {
    changes.targetAnnualSpendCents = params.targetAnnualSpendCents ?? null;
  }
  if ('riskTolerance' in params) changes.riskTolerance = params.riskTolerance ?? null;

  await db
    .insert(userProfile)
    .values({ userId: ctx.userId, ...changes })
    .onConflictDoUpdate({ target: userProfile.userId, set: changes });

  return getProfile(ctx);
}

export interface SetGoalParams {
  /** fire | emergency_fund | debt_payoff | savings_target | custom */
  type: string;
  label?: string;
  targetCents?: Cents;
  /** YYYY-MM-DD */
  targetDate?: string;
}

export async function setGoal(
  ctx: Ctx,
  params: SetGoalParams,
): Promise<ToolResult<UserContextData['goals'][number]>> {
  const db = requireDb(ctx, 'setGoal');
  const [row] = await db
    .insert(goals)
    .values({
      userId: ctx.userId,
      type: params.type,
      label: params.label ?? null,
      targetCents: params.targetCents ?? null,
      targetDate: params.targetDate ?? null,
    })
    .returning();

  if (!row) throw new Error('setGoal: insert returned no row.');

  return result(toGoalLine(row), {
    source: 'user',
    asOf: new Date().toISOString(),
    computation: 'A goal the user set.',
  });
}

export async function deleteGoal(ctx: Ctx, goalId: string): Promise<ToolResult<{ deleted: boolean }>> {
  const db = requireDb(ctx, 'deleteGoal');
  // The user_id predicate is what stops one user deleting another's goal by id.
  const deleted = await db
    .delete(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, ctx.userId)))
    .returning();

  return result(
    { deleted: deleted.length > 0 },
    { source: 'user', asOf: new Date().toISOString(), computation: 'Goal removed by the user.' },
  );
}

/**
 * addNote (§4). Notes live in the profile's JSONB column. Read-modify-write is
 * fine at MVP scale — a user editing their own notes from two places at once is
 * not a scenario worth a transaction for yet.
 */
export async function addNote(ctx: Ctx, note: string): Promise<ToolResult<ProfileData>> {
  const db = requireDb(ctx, 'addNote');
  const current = await getProfile(ctx);
  const notes: ProfileNote[] = [
    ...current.data.notes,
    { id: randomUUID(), text: note, createdAt: new Date().toISOString() },
  ];

  await db
    .insert(userProfile)
    .values({ userId: ctx.userId, notesJson: notes })
    .onConflictDoUpdate({
      target: userProfile.userId,
      set: { notesJson: notes, updatedAt: new Date() },
    });

  return getProfile(ctx);
}
