/**
 * The manual ledger's typed-entry tools (Phase 2, §3, §7b).
 *
 * The manual ledger is financial data the user handed over themselves, stored
 * because no external system holds it (§0.4's corollary). These tools are the
 * always-works path into it: create an account by hand, record a dated balance,
 * archive an account. Document imports (CSV, PDF) arrive through
 * `@pfg/ingest`'s commit step instead, after human review.
 *
 * Every query filters on `ctx.userId` (§3 Isolation) — including the ones that
 * already have an account id, because an id from a URL is user input.
 */

import {
  documents,
  manualAccounts,
  manualBalances,
} from '@pfg/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { type Ctx, requireDb } from '../context.js';
import type { Cents } from '../money.js';
import { type ToolResult, result } from '../provenance.js';
import type { AccountType } from '../snapshot.js';
import { manualAccountId, manualUuid } from '../sources.js';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'depository',
  'investment',
  'brokerage',
  'credit',
  'loan',
  'other',
];

export class ManualLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualLedgerError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertAccountType(type: string): asserts type is AccountType {
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
    throw new ManualLedgerError(`"${type}" is not an account type. Use one of: ${ACCOUNT_TYPES.join(', ')}.`);
  }
}

/** A real calendar date, not in the future. A balance cannot be true tomorrow. */
export function assertBalanceDate(date: string, today = new Date()): void {
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ManualLedgerError(`"${date}" is not a date in YYYY-MM-DD form.`);
  }
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ManualLedgerError(`${date} is not a real calendar date.`);
  }
  if (date > today.toISOString().slice(0, 10)) {
    throw new ManualLedgerError(`A balance cannot be dated in the future (${date}).`);
  }
}

function uuidFromAccountId(accountId: string): string {
  const uuid = manualUuid(accountId);
  if (!uuid) throw new ManualLedgerError('That is not a manual account.');
  return uuid;
}

export interface CreateManualAccountParams {
  name: string;
  type: string;
  subtype?: string | null;
  mask?: string | null;
  institutionName?: string | null;
  officialName?: string | null;
  /** Optional opening balance. Liabilities are the POSITIVE amount owed. */
  balance?: { asOfDate: string; currentCents: Cents };
}

export interface ManualAccountCreated {
  accountId: string;
  documentId: string;
}

/**
 * Create a typed-in account, and optionally its first balance, in one
 * transaction. A `manual_entry` document row is created alongside so the
 * account has a provenance target like every imported row does.
 */
export async function createManualAccount(
  ctx: Ctx,
  params: CreateManualAccountParams,
): Promise<ToolResult<ManualAccountCreated>> {
  const db = requireDb(ctx, 'createManualAccount');
  const name = params.name.trim();
  if (name === '') throw new ManualLedgerError('An account needs a name.');
  assertAccountType(params.type);
  const mask = params.mask?.trim() || null;
  if (mask !== null && !/^[A-Za-z0-9]{1,4}$/.test(mask)) {
    throw new ManualLedgerError('The account mask is the last 1–4 characters of the account number, nothing more.');
  }
  if (params.balance) assertBalanceDate(params.balance.asOfDate);

  const created = await db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({ userId: ctx.userId, kind: 'manual_entry', status: 'committed', committedAt: new Date() })
      .returning({ id: documents.id });
    const [account] = await tx
      .insert(manualAccounts)
      .values({
        userId: ctx.userId,
        documentId: doc!.id,
        name,
        officialName: params.officialName?.trim() || null,
        mask,
        type: params.type,
        subtype: params.subtype?.trim() || null,
        institutionName: params.institutionName?.trim() || null,
      })
      .returning({ id: manualAccounts.id });
    if (params.balance) {
      await tx.insert(manualBalances).values({
        userId: ctx.userId,
        accountId: account!.id,
        documentId: doc!.id,
        asOfDate: params.balance.asOfDate,
        currentCents: params.balance.currentCents,
      });
    }
    return { accountId: manualAccountId(account!.id), documentId: doc!.id };
  });

  return result(created, {
    source: 'user',
    asOf: new Date().toISOString(),
    accountIds: [created.accountId],
    computation: 'An account you entered by hand.',
    sources: ['manual'],
  });
}

/**
 * Record (or correct) a dated balance. Upsert on (account, date): entering the
 * same date again replaces that day's figure; every other date is kept, so the
 * series stays a history rather than a single overwritten number.
 */
export async function recordManualBalance(
  ctx: Ctx,
  params: { accountId: string; asOfDate: string; currentCents: Cents },
): Promise<ToolResult<{ accountId: string; asOfDate: string }>> {
  const db = requireDb(ctx, 'recordManualBalance');
  const uuid = uuidFromAccountId(params.accountId);
  assertBalanceDate(params.asOfDate);

  const [account] = await db
    .select({ id: manualAccounts.id })
    .from(manualAccounts)
    .where(and(eq(manualAccounts.id, uuid), eq(manualAccounts.userId, ctx.userId), isNull(manualAccounts.archivedAt)));
  if (!account) throw new ManualLedgerError('No such account.');

  await db
    .insert(manualBalances)
    .values({ userId: ctx.userId, accountId: uuid, asOfDate: params.asOfDate, currentCents: params.currentCents })
    .onConflictDoUpdate({
      target: [manualBalances.accountId, manualBalances.asOfDate],
      set: { currentCents: params.currentCents, documentId: null },
    });

  return result(
    { accountId: params.accountId, asOfDate: params.asOfDate },
    {
      source: 'user',
      asOf: new Date().toISOString(),
      accountIds: [params.accountId],
      computation: 'A balance you entered by hand.',
      sources: ['manual'],
    },
  );
}

/**
 * Archive rather than delete (§3): the account leaves every future snapshot,
 * and its balance history stays intact instead of dangling.
 */
export async function archiveManualAccount(
  ctx: Ctx,
  accountId: string,
): Promise<ToolResult<{ archived: boolean }>> {
  const db = requireDb(ctx, 'archiveManualAccount');
  const uuid = uuidFromAccountId(accountId);
  const rows = await db
    .update(manualAccounts)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(manualAccounts.id, uuid), eq(manualAccounts.userId, ctx.userId), isNull(manualAccounts.archivedAt)))
    .returning({ id: manualAccounts.id });
  return result(
    { archived: rows.length > 0 },
    { source: 'user', asOf: new Date().toISOString(), accountIds: [accountId], sources: ['manual'] },
  );
}

export interface ManualBalancePoint {
  asOfDate: string;
  currentCents: Cents;
  /** The document this figure came from; null when typed by hand. */
  documentId: string | null;
  documentKind: string | null;
}

/** An account's full dated balance series, oldest first, for its detail page. */
export async function getManualBalanceHistory(
  ctx: Ctx,
  accountId: string,
): Promise<ToolResult<{ accountId: string; points: ManualBalancePoint[] }>> {
  const db = requireDb(ctx, 'getManualBalanceHistory');
  const uuid = uuidFromAccountId(accountId);
  const rows = await db
    .select({
      asOfDate: manualBalances.asOfDate,
      currentCents: manualBalances.currentCents,
      documentId: manualBalances.documentId,
      documentKind: documents.kind,
    })
    .from(manualBalances)
    .leftJoin(documents, and(eq(documents.id, manualBalances.documentId), eq(documents.userId, ctx.userId)))
    .where(and(eq(manualBalances.accountId, uuid), eq(manualBalances.userId, ctx.userId)))
    .orderBy(asc(manualBalances.asOfDate));

  return result(
    { accountId, points: rows },
    {
      source: 'db',
      asOf: new Date().toISOString(),
      accountIds: [accountId],
      computation: 'Every balance recorded for this account, from your statements and typed entries.',
      sources: ['manual'],
    },
  );
}
