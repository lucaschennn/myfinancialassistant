import { type Ctx, requireSnapshot } from '../context.js';
import { type Cents, ZERO, ratioToBasisPoints } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { gapNotes, securityIndex } from '../snapshot.js';

/** Coarse buckets folded up from Plaid's finer `security.type` values. */
export type AssetClass =
  | 'equity'
  | 'fixed_income'
  | 'cash'
  | 'crypto'
  | 'derivative'
  | 'other';

/**
 * Plaid security types → asset classes. `mutual fund` and `etf` are wrappers,
 * not asset classes: without holdings-level lookthrough we cannot know whether
 * a given fund is stocks or bonds, so they land in `other` rather than being
 * silently miscounted as equity. That understates equity exposure for
 * fund-heavy portfolios — the provenance note says so out loud.
 */
const SECURITY_TYPE_TO_CLASS: Record<string, AssetClass> = {
  equity: 'equity',
  'fixed income': 'fixed_income',
  cash: 'cash',
  cryptocurrency: 'crypto',
  derivative: 'derivative',
  etf: 'other',
  'mutual fund': 'other',
  loan: 'other',
  other: 'other',
};

export interface AllocationBucket {
  assetClass: AssetClass;
  valueCents: Cents;
  /** Share of the portfolio in basis points. 2500 = 25.00%. */
  shareBasisPoints: number | null;
  /** Plaid security types that rolled into this bucket, for transparency. */
  securityTypes: string[];
  holdingCount: number;
}

export interface AllocationHoldingLine {
  securityId: string;
  name: string | null;
  tickerSymbol: string | null;
  securityType: string | null;
  assetClass: AssetClass;
  valueCents: Cents;
  quantity: number;
}

export interface AssetAllocationData {
  totalValueCents: Cents;
  buckets: AllocationBucket[];
  /** Individual positions, largest first. */
  holdings: AllocationHoldingLine[];
  /** Investment accounts the allocation covers. */
  accountIds: string[];
}

export interface AssetAllocationParams {
  accountIds?: string[];
}

/**
 * assetAllocation (§4): from holdings + security types.
 *
 * Scope note: this covers securities held in investment accounts only. Cash
 * sitting in a checking or savings account is NOT counted — it is not a
 * holding. That cash does count toward `netWorth` and `fireProgress`, so the
 * three figures deliberately cover different sets of money.
 */
export function assetAllocation(
  ctx: Ctx,
  params: AssetAllocationParams = {},
): ToolResult<AssetAllocationData> {
  const snapshot = requireSnapshot(ctx, 'assetAllocation');
  const securities = securityIndex(snapshot);

  const filter = params.accountIds ? new Set(params.accountIds) : null;
  const holdings = filter
    ? snapshot.holdings.filter((h) => filter.has(h.accountId))
    : snapshot.holdings;

  const lines: AllocationHoldingLine[] = [];
  const byClass = new Map<
    AssetClass,
    { valueCents: Cents; securityTypes: Set<string>; holdingCount: number }
  >();
  let totalValueCents = ZERO;

  for (const holding of holdings) {
    const security = securities.get(holding.securityId);
    const securityType = security?.type ?? null;
    const mapped = securityType ? SECURITY_TYPE_TO_CLASS[securityType] : undefined;
    // Unmapped or missing type: fall back to Plaid's own cash-equivalent flag
    // before giving up and calling it `other`.
    const assetClass: AssetClass = mapped ?? (security?.isCashEquivalent ? 'cash' : 'other');

    totalValueCents += holding.valueCents;

    const bucket = byClass.get(assetClass) ?? {
      valueCents: ZERO,
      securityTypes: new Set<string>(),
      holdingCount: 0,
    };
    bucket.valueCents += holding.valueCents;
    bucket.holdingCount += 1;
    if (securityType) bucket.securityTypes.add(securityType);
    byClass.set(assetClass, bucket);

    lines.push({
      securityId: holding.securityId,
      name: security?.name ?? null,
      tickerSymbol: security?.tickerSymbol ?? null,
      securityType,
      assetClass,
      valueCents: holding.valueCents,
      quantity: holding.quantity,
    });
  }

  const buckets: AllocationBucket[] = [...byClass.entries()]
    .map(([assetClass, b]) => ({
      assetClass,
      valueCents: b.valueCents,
      shareBasisPoints: ratioToBasisPoints(b.valueCents, totalValueCents),
      securityTypes: [...b.securityTypes].sort(),
      holdingCount: b.holdingCount,
    }))
    .sort((a, b) => (b.valueCents > a.valueCents ? 1 : b.valueCents < a.valueCents ? -1 : 0));

  lines.sort((a, b) => (b.valueCents > a.valueCents ? 1 : b.valueCents < a.valueCents ? -1 : 0));

  const accountIds = [...new Set(holdings.map((h) => h.accountId))];
  const notes = gapNotes(snapshot, 'holdings');

  const wrapperValue = buckets.find((b) => b.assetClass === 'other');
  if (wrapperValue && wrapperValue.securityTypes.some((t) => t === 'etf' || t === 'mutual fund')) {
    notes.push(
      'ETFs and mutual funds are grouped under "other" — the underlying stock/bond mix ' +
        'inside each fund is not visible from holdings data alone.',
    );
  }
  if (snapshot.accounts.some((a) => a.type === 'depository')) {
    notes.push(
      'Cash in checking/savings accounts is not included here — this covers securities ' +
        'held in investment accounts only.',
    );
  }
  const investmentAccountsWithoutHoldings = snapshot.accounts.filter(
    (a) => a.type === 'investment' && !accountIds.includes(a.accountId),
  );
  if (investmentAccountsWithoutHoldings.length > 0) {
    notes.push(
      `No holdings returned for: ${investmentAccountsWithoutHoldings
        .map((a) => `${a.name}${a.mask ? ` (…${a.mask})` : ''}`)
        .join(', ')}.`,
    );
  }

  const provenance: Provenance = {
    source: 'compute',
    asOf: snapshot.fetchedAt,
    accountIds,
    computation:
      'Each holding\'s institution-reported market value, grouped into asset classes by ' +
      'Plaid security type, with each bucket expressed as a share of total holdings value.',
    inputs: ['getHoldings'],
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result({ totalValueCents, buckets, holdings: lines, accountIds }, provenance);
}
