/**
 * The manual ledger as a source (§7b): Postgres → `SourceResult`, which
 * `mergeSources` folds into the request's snapshot beside Plaid.
 *
 * Unlike the Plaid source this is a READ of durable data — the user's own
 * records, stored at import time because nothing else holds them (§0.4). The
 * expensive work happened once, at import; this is cheap and happens every turn.
 *
 * One query per dataset, never one per account: a user with thirty manual
 * accounts should not cost thirty round trips on every dashboard render, and the
 * network trace would show it if they did.
 */

import {
  type SnapshotAccount,
  type SnapshotHolding,
  type SnapshotSecurity,
  type SnapshotTransaction,
  type SourceResult,
  type TraceRecorder,
  type AccountType,
  manualAccountId,
  manualSecurityId,
} from '@pfg/core';
import {
  type Database,
  documents,
  manualAccounts,
  manualBalances,
  manualHoldings,
  manualSecurities,
  manualTransactions,
} from '@pfg/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';

export interface ReadManualSourceOptions {
  userId: string;
  db: Database;
  /** The transaction window to read, matching the Plaid fetch. Null skips transactions. */
  transactionWindow: { from: string; to: string } | null;
  includeHoldings?: boolean;
  trace?: TraceRecorder;
}

const MANUAL_ITEM_ID = 'manual';

/** Does this user have any live (non-archived) manual account? A cheap existence check. */
export async function hasManualAccounts(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: manualAccounts.id })
    .from(manualAccounts)
    .where(and(eq(manualAccounts.userId, userId), isNull(manualAccounts.archivedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function readManualSource(options: ReadManualSourceOptions): Promise<SourceResult> {
  const run = (): Promise<SourceResult> => read(options);
  return options.trace
    ? options.trace.track('db', 'read manual ledger', run, (r) => ({ count: r.accounts.length }))
    : run();
}

async function read({
  userId,
  db,
  transactionWindow,
  includeHoldings = true,
}: ReadManualSourceOptions): Promise<SourceResult> {
  const accountRows = await db
    .select()
    .from(manualAccounts)
    .where(and(eq(manualAccounts.userId, userId), isNull(manualAccounts.archivedAt)))
    .orderBy(asc(manualAccounts.createdAt));

  if (accountRows.length === 0) {
    return {
      kind: 'manual',
      accounts: [],
      holdings: [],
      securities: [],
      transactions: [],
      transactionWindow: null,
      gaps: [],
    };
  }
  const ids = accountRows.map((a) => a.id);

  // Latest balance per account: DISTINCT ON keeps the first row per account in
  // date-descending order, in one query.
  const latest = await db
    .selectDistinctOn([manualBalances.accountId])
    .from(manualBalances)
    .where(and(eq(manualBalances.userId, userId), inArray(manualBalances.accountId, ids)))
    .orderBy(manualBalances.accountId, desc(manualBalances.asOfDate));
  const balanceByAccount = new Map(latest.map((b) => [b.accountId, b]));

  // The document behind each current balance, so evidence can name it.
  const docIds = [...new Set(latest.map((b) => b.documentId).filter((id): id is string => id !== null))];
  const docRows = docIds.length
    ? await db
        .select({ id: documents.id, kind: documents.kind, uploadedAt: documents.uploadedAt })
        .from(documents)
        .where(and(eq(documents.userId, userId), inArray(documents.id, docIds)))
    : [];
  const docById = new Map(docRows.map((d) => [d.id, d]));

  const accounts: SnapshotAccount[] = accountRows.map((a) => {
    const balance = balanceByAccount.get(a.id);
    return {
      source: 'manual',
      accountId: manualAccountId(a.id),
      itemId: MANUAL_ITEM_ID,
      institutionName: a.institutionName,
      name: a.name,
      officialName: a.officialName,
      mask: a.mask,
      type: a.type as AccountType,
      subtype: a.subtype,
      currentCents: balance?.currentCents ?? null,
      availableCents: balance?.availableCents ?? null,
      limitCents: balance?.limitCents ?? null,
      isoCurrencyCode: a.isoCurrencyCode,
      // A balance is true as of its statement date. An account with no balance
      // yet is excluded from totals by netWorth anyway; its creation date stands in.
      balanceAsOf: balance?.asOfDate ?? a.createdAt.toISOString(),
      balanceDocument: (() => {
        const doc = balance?.documentId ? docById.get(balance.documentId) : undefined;
        return doc
          ? {
              documentId: doc.id,
              kind: doc.kind as 'csv' | 'pdf' | 'manual_entry',
              importedOn: doc.uploadedAt.toISOString().slice(0, 10),
            }
          : null;
      })(),
    };
  });

  let holdings: SnapshotHolding[] = [];
  let securities: SnapshotSecurity[] = [];
  if (includeHoldings) {
    const holdingRows = await db
      .select()
      .from(manualHoldings)
      .where(and(eq(manualHoldings.userId, userId), inArray(manualHoldings.accountId, ids)));
    // Positions as of each account's most recent statement, not every month's.
    const latestDate = new Map<string, string>();
    for (const h of holdingRows) {
      const prior = latestDate.get(h.accountId);
      if (!prior || h.asOfDate > prior) latestDate.set(h.accountId, h.asOfDate);
    }
    const current = holdingRows.filter((h) => latestDate.get(h.accountId) === h.asOfDate);
    holdings = current.map((h) => ({
      source: 'manual',
      accountId: manualAccountId(h.accountId),
      securityId: manualSecurityId(h.securityId),
      quantity: h.quantity,
      costBasisCents: h.costBasisCents,
      valueCents: h.valueCents,
      isoCurrencyCode: accountRows.find((a) => a.id === h.accountId)?.isoCurrencyCode ?? null,
    }));

    const securityIds = [...new Set(current.map((h) => h.securityId))];
    if (securityIds.length > 0) {
      const securityRows = await db
        .select()
        .from(manualSecurities)
        .where(and(eq(manualSecurities.userId, userId), inArray(manualSecurities.id, securityIds)));
      securities = securityRows.map((s) => ({
        source: 'manual',
        securityId: manualSecurityId(s.id),
        name: s.name,
        tickerSymbol: s.tickerSymbol,
        type: s.type,
        closePriceCents: s.closePriceCents,
        isCashEquivalent: s.isCashEquivalent,
      }));
    }
  }

  let transactions: SnapshotTransaction[] = [];
  if (transactionWindow) {
    const rows = await db
      .select()
      .from(manualTransactions)
      .where(
        and(
          eq(manualTransactions.userId, userId),
          inArray(manualTransactions.accountId, ids),
          gte(manualTransactions.date, transactionWindow.from),
          lte(manualTransactions.date, transactionWindow.to),
        ),
      )
      .orderBy(desc(manualTransactions.date));
    transactions = rows.map((t) => ({
      source: 'manual',
      transactionId: `manual_${t.id}`,
      accountId: manualAccountId(t.accountId),
      date: t.date,
      // Already in Plaid's sign convention — converted at import (§3.4).
      amountCents: t.amountCents,
      name: t.name,
      merchantName: t.merchantName,
      // A statement row is settled by definition.
      pending: false,
      category:
        t.categoryPrimary !== null
          ? { primary: t.categoryPrimary, detailed: t.categoryDetailed ?? `${t.categoryPrimary}_OTHER` }
          : null,
      isoCurrencyCode: t.isoCurrencyCode,
    }));
  }

  return {
    kind: 'manual',
    accounts,
    holdings,
    securities,
    transactions,
    transactionWindow,
    gaps: [],
  };
}
