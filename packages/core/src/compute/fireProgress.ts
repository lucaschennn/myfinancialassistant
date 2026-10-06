import { type Ctx, requireSnapshot } from '../context.js';
import { type Cents, ZERO, ratioToBasisPoints } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import {
  INVESTABLE_ASSET_TYPES,
  LIABILITY_TYPES,
  gapNotes,
  isIlliquidSecuredDebt,
  sourcesOf,
  staleBalanceNotes,
} from '../snapshot.js';
import { getProfile } from '../tools/userContext.js';

export interface FireProgressParams {
  /** Defaults to the profile's `target_annual_spend_cents` when omitted. */
  annualSpendCents?: Cents;
  /** Target = annual spend × multiple. Ignored when `withdrawalRate` is given. */
  multiple?: number;
  /** Target = annual spend ÷ rate. Overrides `multiple`. E.g. 0.04 for the 4% rule. */
  withdrawalRate?: number;
}

export interface FireProgressData {
  targetCents: Cents;
  /** Investable assets minus the liabilities that are actually subtracted. */
  investableNetWorthCents: Cents;
  investableAssetsCents: Cents;
  /** Liabilities subtracted: everything except housing debt. */
  liabilitiesCents: Cents;
  /** Housing debt, reported but NOT subtracted. See the note on the module. */
  excludedLiabilitiesCents: Cents;
  shortfallCents: Cents;
  /** Progress toward target in basis points. 10000 = 100%. */
  progressBasisPoints: number | null;
  annualSpendCents: Cents;
  /** Which rule produced the target, echoed back for the "why" card. */
  basis: { kind: 'multiple'; multiple: number } | { kind: 'withdrawal_rate'; withdrawalRate: number };
  /** Accounts counted as investable, and those deliberately left out. */
  investableAccountIds: string[];
  excludedAccountIds: string[];
  /** Housing-debt accounts whose balance was not subtracted. */
  excludedLiabilityAccountIds: string[];
}

/** Fixed-point scale for turning a fractional rate/multiple into bigint math. */
const SCALE = 10_000n;

function toScaled(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`fireProgress: ${label} must be a positive finite number, got ${value}`);
  }
  return BigInt(Math.round(value * Number(SCALE)));
}

/**
 * fireProgress (§4). Two things make this different from `netWorth`:
 *
 *  1. It measures INVESTABLE net worth. A paid-off house raises net worth but
 *     cannot fund retirement withdrawals, so illiquid `other`-type assets are
 *     excluded — and so is the housing debt secured against them. Excluding the
 *     house while still subtracting its mortgage would charge the user twice:
 *     once here, and again through the mortgage payment already sitting inside
 *     `annualSpendCents`, which is what sets the target. Every other liability
 *     is subtracted in full.
 *  2. The target comes from the user's own spending target, not from income.
 *
 * Known limitation: Plaid types a rental property as `other`, identically to a
 * primary residence, so a rental is excluded here even though it genuinely does
 * produce withdrawable income. Distinguishing them needs a user-context flag
 * (Phase 1); until then it is stated as a provenance note rather than guessed at.
 *
 * Async because `annualSpendCents` falls back to the stored profile.
 */
export async function fireProgress(
  ctx: Ctx,
  params: FireProgressParams = {},
): Promise<ToolResult<FireProgressData>> {
  const snapshot = requireSnapshot(ctx, 'fireProgress');
  const notes = gapNotes(snapshot, 'balances');

  let annualSpendCents = params.annualSpendCents;
  let spendSource: 'param' | 'profile' = 'param';
  if (annualSpendCents === undefined) {
    const profile = await getProfile(ctx);
    if (profile.data.targetAnnualSpendCents === null) {
      throw new Error(
        'fireProgress: no annual spend to work from. Pass `annualSpendCents`, or set ' +
          '`targetAnnualSpendCents` on the user profile via setProfile.',
      );
    }
    annualSpendCents = profile.data.targetAnnualSpendCents;
    spendSource = 'profile';
  }

  if (annualSpendCents <= ZERO) {
    throw new RangeError(
      `fireProgress: annual spend must be positive, got ${annualSpendCents} cents.`,
    );
  }

  let targetCents: Cents;
  let basis: FireProgressData['basis'];
  if (params.withdrawalRate !== undefined) {
    if (params.withdrawalRate > 1) {
      throw new RangeError(
        `fireProgress: withdrawalRate is a fraction (0.04 = 4%), got ${params.withdrawalRate}.`,
      );
    }
    targetCents = (annualSpendCents * SCALE) / toScaled(params.withdrawalRate, 'withdrawalRate');
    basis = { kind: 'withdrawal_rate', withdrawalRate: params.withdrawalRate };
  } else {
    const multiple = params.multiple ?? 25;
    targetCents = (annualSpendCents * toScaled(multiple, 'multiple')) / SCALE;
    basis = { kind: 'multiple', multiple };
  }

  let investableAssetsCents = ZERO;
  let liabilitiesCents = ZERO;
  let excludedLiabilitiesCents = ZERO;
  const investableAccountIds: string[] = [];
  const excludedAccountIds: string[] = [];
  const excludedLiabilityAccountIds: string[] = [];

  for (const account of snapshot.accounts) {
    if (account.currentCents === null) {
      excludedAccountIds.push(account.accountId);
      continue;
    }
    if (LIABILITY_TYPES.has(account.type)) {
      if (isIlliquidSecuredDebt(account)) {
        excludedLiabilitiesCents += account.currentCents;
        excludedLiabilityAccountIds.push(account.accountId);
      } else {
        liabilitiesCents += account.currentCents;
      }
      continue;
    }
    if (INVESTABLE_ASSET_TYPES.has(account.type)) {
      investableAssetsCents += account.currentCents;
      investableAccountIds.push(account.accountId);
    } else {
      excludedAccountIds.push(account.accountId);
    }
  }

  const describe = (a: { name: string; mask: string | null }): string =>
    `${a.name}${a.mask ? ` (…${a.mask})` : ''}`;

  const illiquid = snapshot.accounts.filter((a) => excludedAccountIds.includes(a.accountId));
  if (illiquid.length > 0) {
    notes.push(
      `Excluded from investable assets (illiquid or no balance reported): ${illiquid
        .map(describe)
        .join(', ')}. These still count toward overall net worth.`,
    );
    notes.push(
      'If any of those are rental properties rather than a home you live in, this ' +
        'understates your progress — they do produce income, but Plaid reports both the ' +
        'same way.',
    );
  }

  const excludedDebt = snapshot.accounts.filter((a) =>
    excludedLiabilityAccountIds.includes(a.accountId),
  );
  if (excludedDebt.length > 0) {
    notes.push(
      `Not subtracted here: ${excludedDebt.map(describe).join(', ')}. Housing debt is left ` +
        'out because the property it is secured against is also left out, and the payment ' +
        'is already part of the annual spending figure this target is built from. It does ' +
        'reduce your overall net worth.',
    );
  }

  const usedAccountIds = new Set([...investableAccountIds, ...snapshot.accounts
    .filter((a) => a.currentCents !== null && LIABILITY_TYPES.has(a.type) && !isIlliquidSecuredDebt(a))
    .map((a) => a.accountId)]);
  notes.push(...staleBalanceNotes(snapshot, usedAccountIds));

  if (spendSource === 'profile') {
    notes.push('Annual spend target came from your saved profile, not from measured spending.');
  }

  const investableNetWorthCents = investableAssetsCents - liabilitiesCents;
  const targetRule =
    basis.kind === 'withdrawal_rate'
      ? `Target = annual spend ÷ ${basis.withdrawalRate} withdrawal rate.`
      : `Target = annual spend × ${basis.multiple}.`;
  const computation =
    `${targetRule} Investable net worth = balances in investment and cash accounts, minus ` +
    'debts other than housing. Progress = investable net worth ÷ target.';

  const provenance: Provenance = {
    source: 'compute',
    asOf: snapshot.fetchedAt,
    accountIds: investableAccountIds,
    computation,
    inputs: spendSource === 'profile' ? ['getBalances', 'getUserContext'] : ['getBalances'],
    sources: sourcesOf(snapshot.accounts.filter((a) => usedAccountIds.has(a.accountId))),
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      targetCents,
      investableNetWorthCents,
      investableAssetsCents,
      liabilitiesCents,
      excludedLiabilitiesCents,
      shortfallCents:
        targetCents > investableNetWorthCents ? targetCents - investableNetWorthCents : ZERO,
      progressBasisPoints: ratioToBasisPoints(investableNetWorthCents, targetCents),
      annualSpendCents,
      basis,
      investableAccountIds,
      excludedAccountIds,
      excludedLiabilityAccountIds,
    },
    provenance,
  );
}
