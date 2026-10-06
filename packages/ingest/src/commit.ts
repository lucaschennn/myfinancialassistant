/**
 * Commit (§7b stage 4, PHASE-2-INGESTION §5.2): a reviewed draft → manual_*
 * rows, in ONE database transaction. Partial commits are not a state the
 * system has.
 *
 * Commit does not trust that review happened. It is handed a draft that the
 * caller rebuilt from the stored bytes and the user's decisions moments ago,
 * re-checks every blocker itself, and refuses rather than writing past one —
 * including a field the transcription guard rejected (§4.5).
 */

import { ACCOUNT_TYPES, manualUuid } from '@pfg/core';
import {
  type Database,
  documents,
  manualAccounts,
  manualBalances,
  manualHoldings,
  manualSecurities,
  manualTransactions,
} from '@pfg/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type Decisions, type Draft, blockers } from './draft.js';
import { type TranscriptionClaim, checkTranscription } from './pdf/guard.js';

export class CommitBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`This import cannot be committed yet: ${reasons.join(' ')}`);
    this.name = 'CommitBlockedError';
  }
}

export interface CommitSummary {
  accountId: string;
  accountCreated: boolean;
  balancesWritten: number;
  transactionsInserted: number;
  /** Rows the ledger already had (same account, date, amount, description). Shown, because a wrong count is visible here. */
  transactionsSkippedAsDuplicates: number;
  transactionsExcludedByYou: number;
  holdingsWritten: number;
  discrepanciesAcknowledged: number;
}

export async function commitDraft(options: {
  db: Database;
  userId: string;
  draft: Draft;
  decisions: Decisions;
  /** PDF only: the extracted page text, so the guard can be re-run here rather than trusted. */
  pages?: string[];
}): Promise<CommitSummary> {
  const { db, userId, draft, decisions } = options;

  const reasons = blockers(draft, decisions);
  if (reasons.length > 0) throw new CommitBlockedError(reasons);
  // Belt and braces with the guard at parse time (§4.5): every field a model
  // transcribed is checked again, here, against the document's own text. A
  // draft carrying one the guard rejects is refused, whatever let it through.
  const claims = transcribedClaims(draft);
  if (claims.length > 0) {
    if (!options.pages) throw new CommitBlockedError(['A transcribed figure has no statement text to be checked against.']);
    const report = checkTranscription(options.pages, claims);
    if (!report.ok) {
      throw new CommitBlockedError(
        report.violations.map((v) => `"${v.raw}" (${v.label}) is not in the statement text.`),
      );
    }
  }

  const account = draft.accounts[0]!;
  const type = account.type.value;
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
    throw new CommitBlockedError([`"${type}" is not an account type.`]);
  }

  return db.transaction(async (tx) => {
    // --- the account: an existing one of yours, or a new one ---------------
    let accountUuid: string;
    let accountCreated = false;
    if (account.existingAccountId) {
      const uuid = manualUuid(account.existingAccountId);
      const [existing] = uuid
        ? await tx
            .select({ id: manualAccounts.id })
            .from(manualAccounts)
            .where(and(eq(manualAccounts.id, uuid), eq(manualAccounts.userId, userId), isNull(manualAccounts.archivedAt)))
        : [];
      if (!existing) throw new CommitBlockedError(['The account chosen for these rows no longer exists.']);
      accountUuid = existing.id;
    } else {
      const [created] = await tx
        .insert(manualAccounts)
        .values({
          userId,
          documentId: draft.documentId,
          name: account.name.value.trim(),
          type,
          subtype: account.subtype.value,
          mask: account.mask.value,
          institutionName: account.institutionName.value,
        })
        .returning({ id: manualAccounts.id });
      accountUuid = created!.id;
      accountCreated = true;
    }

    // --- balance ------------------------------------------------------------
    let balancesWritten = 0;
    if (account.balance) {
      await tx
        .insert(manualBalances)
        .values({
          userId,
          accountId: accountUuid,
          documentId: draft.documentId,
          asOfDate: account.balance.asOfDate.value,
          currentCents: account.balance.currentCents.value,
        })
        .onConflictDoUpdate({
          target: [manualBalances.accountId, manualBalances.asOfDate],
          set: { currentCents: account.balance.currentCents.value, documentId: draft.documentId },
        });
      balancesWritten = 1;
    }

    // --- transactions: already in Plaid's sign convention (§3.4) -------------
    const included = account.transactions.filter((t) => t.include);
    let inserted = 0;
    // Chunked so a large export stays well under Postgres' parameter limit.
    for (let i = 0; i < included.length; i += 500) {
      const chunk = included.slice(i, i + 500);
      const rows = await tx
        .insert(manualTransactions)
        .values(
          chunk.map((t) => ({
            userId,
            accountId: accountUuid,
            documentId: draft.documentId,
            date: t.date.value,
            amountCents: t.amountCents.value,
            name: t.name.value,
            merchantName: t.merchantName,
            categoryPrimary: t.categoryPrimary,
            categoryDetailed: null,
          })),
        )
        .onConflictDoNothing({
          target: [manualTransactions.accountId, manualTransactions.date, manualTransactions.amountCents, manualTransactions.name],
        })
        .returning({ id: manualTransactions.id });
      inserted += rows.length;
    }

    // --- holdings: find-or-create the security, then the dated position -----
    let holdingsWritten = 0;
    for (const h of account.holdings) {
      const ticker = h.tickerSymbol;
      const name = h.securityName.value;
      const [known] = await tx
        .select({ id: manualSecurities.id })
        .from(manualSecurities)
        .where(
          and(
            eq(manualSecurities.userId, userId),
            ticker ? eq(manualSecurities.tickerSymbol, ticker) : eq(manualSecurities.name, name),
          ),
        );
      const securityId =
        known?.id ??
        (
          await tx
            .insert(manualSecurities)
            .values({ userId, name, tickerSymbol: ticker, type: h.securityType, isCashEquivalent: h.securityType === 'cash' })
            .returning({ id: manualSecurities.id })
        )[0]!.id;
      await tx
        .insert(manualHoldings)
        .values({
          userId,
          accountId: accountUuid,
          securityId,
          documentId: draft.documentId,
          quantity: h.quantity.value,
          valueCents: h.valueCents.value,
          asOfDate: h.asOfDate.value,
        })
        .onConflictDoUpdate({
          target: [manualHoldings.accountId, manualHoldings.securityId, manualHoldings.asOfDate],
          set: { quantity: h.quantity.value, valueCents: h.valueCents.value, documentId: draft.documentId },
        });
      holdingsWritten += 1;
    }

    // --- the document: committed, and its draft cleared ----------------------
    // The draft holds financial figures; past this point it duplicates the
    // ledger with no reader, so it is cleared rather than kept (§2).
    await tx
      .update(documents)
      .set({ status: 'committed', committedAt: new Date(), draftJson: null, failureReason: null })
      .where(and(eq(documents.id, draft.documentId), eq(documents.userId, userId)));

    return {
      accountId: `manual_${accountUuid}`,
      accountCreated,
      balancesWritten,
      transactionsInserted: inserted,
      transactionsSkippedAsDuplicates: included.length - inserted,
      transactionsExcludedByYou: account.transactions.length - included.length,
      holdingsWritten,
      discrepanciesAcknowledged: draft.discrepancies.length,
    };
  });
}

/** Every field a model transcribed, as guard claims. Parsed and user-typed fields are not claims. */
export function transcribedClaims(draft: Draft): TranscriptionClaim[] {
  const out: TranscriptionClaim[] = [];
  const add = (label: string, f: { raw: string; origin: string; page?: number }, kind: 'amount' | 'text'): void => {
    if (f.origin === 'transcribed') out.push({ label, raw: f.raw, kind, ...(f.page !== undefined ? { page: f.page } : {}) });
  };
  for (const a of draft.accounts) {
    if (a.balance) {
      add('balance date', a.balance.asOfDate, 'text');
      add('balance', a.balance.currentCents, 'amount');
    }
    a.transactions
      .filter((t) => t.include)
      .forEach((t) => {
        add(`row ${t.row} date`, t.date, 'text');
        add(`row ${t.row} amount`, t.amountCents, 'amount');
        add(`row ${t.row} description`, t.name, 'text');
      });
    a.holdings.forEach((h, i) => {
      add(`holding ${i + 1} name`, h.securityName, 'text');
      add(`holding ${i + 1} value`, h.valueCents, 'amount');
      add(`holding ${i + 1} quantity`, h.quantity, 'text');
    });
  }
  return out;
}
