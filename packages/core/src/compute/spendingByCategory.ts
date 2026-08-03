import { type Ctx, requireSnapshot } from '../context.js';
import { type Cents, ZERO, ratioToBasisPoints } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { gapNotes } from '../snapshot.js';
import { type Period, type SelectOptions, assertPeriod, selectTransactions } from './period.js';

export interface CategoryDetailLine {
  detailed: string;
  spendCents: Cents;
  transactionCount: number;
}

export interface CategoryGroup {
  /** Plaid `personal_finance_category.primary`, used verbatim (§4 — no custom mapping table). */
  primary: string;
  spendCents: Cents;
  shareBasisPoints: number | null;
  transactionCount: number;
  detailed: CategoryDetailLine[];
}

export interface SpendingByCategoryData {
  totalSpendCents: Cents;
  categories: CategoryGroup[];
  /** Spend Plaid could not categorise, kept visible rather than dropped. */
  uncategorizedCents: Cents;
  period: Period;
}

export interface SpendingByCategoryParams extends SelectOptions {
  period: Period;
}

/** Bucket for transactions Plaid returned without a personal_finance_category. */
const UNCATEGORIZED = 'UNCATEGORIZED';

/**
 * spendingByCategory (§4): outflows grouped by Plaid's `personal_finance_category`.
 *
 * Plaid's taxonomy is used directly — no custom mapping table — so the category
 * a user sees here is the same one Plaid assigned, and a disagreement is
 * traceable to Plaid rather than to a translation layer of ours.
 *
 * Refunds (negative amounts inside a spending category) net against that
 * category's total, which can make a category go slightly negative in a period
 * dominated by a return. That is the honest number, so it is not clamped.
 */
export function spendingByCategory(
  ctx: Ctx,
  params: SpendingByCategoryParams,
): ToolResult<SpendingByCategoryData> {
  const snapshot = requireSnapshot(ctx, 'spendingByCategory');
  const { period, ...selectOptions } = params;
  assertPeriod(period, 'spendingByCategory');

  const selection = selectTransactions(snapshot, period, selectOptions);

  const groups = new Map<
    string,
    { spendCents: Cents; count: number; detailed: Map<string, { spendCents: Cents; count: number }> }
  >();
  let totalSpendCents = ZERO;
  let uncategorizedCents = ZERO;

  for (const t of selection.transactions) {
    // Income lands here as a negative amount. Only spending categories are of
    // interest, so inflows in non-spending categories are left to `cashFlow`.
    const primary = t.category?.primary ?? UNCATEGORIZED;
    const detailed = t.category?.detailed ?? UNCATEGORIZED;
    if (primary === 'INCOME') continue;

    totalSpendCents += t.amountCents;
    if (primary === UNCATEGORIZED) uncategorizedCents += t.amountCents;

    const group = groups.get(primary) ?? { spendCents: ZERO, count: 0, detailed: new Map() };
    group.spendCents += t.amountCents;
    group.count += 1;
    const detail = group.detailed.get(detailed) ?? { spendCents: ZERO, count: 0 };
    detail.spendCents += t.amountCents;
    detail.count += 1;
    group.detailed.set(detailed, detail);
    groups.set(primary, group);
  }

  const byValueDesc = <T extends { spendCents: Cents }>(a: T, b: T): number =>
    b.spendCents > a.spendCents ? 1 : b.spendCents < a.spendCents ? -1 : 0;

  const categories: CategoryGroup[] = [...groups.entries()]
    .map(([primary, g]) => ({
      primary,
      spendCents: g.spendCents,
      shareBasisPoints: ratioToBasisPoints(g.spendCents, totalSpendCents),
      transactionCount: g.count,
      detailed: [...g.detailed.entries()]
        .map(([detailed, d]) => ({
          detailed,
          spendCents: d.spendCents,
          transactionCount: d.count,
        }))
        .sort(byValueDesc),
    }))
    .sort(byValueDesc);

  const notes = [...gapNotes(snapshot, 'transactions'), ...selection.notes];
  if (uncategorizedCents !== ZERO) {
    notes.push('Some transactions arrived from Plaid without a category and are grouped as UNCATEGORIZED.');
  }

  const provenance: Provenance = {
    source: 'compute',
    asOf: snapshot.fetchedAt,
    accountIds: selection.accountIds,
    period,
    computation:
      "Outflows over the period grouped by Plaid's personal_finance_category (primary, then " +
      'detailed). Income-category transactions are excluded; refunds net against their category.',
    inputs: ['getTransactions'],
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result({ totalSpendCents, categories, uncategorizedCents, period }, provenance);
}
