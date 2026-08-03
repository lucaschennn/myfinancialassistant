import { type Ctx, requireSnapshot } from '../context.js';
import { type Cents, ZERO } from '../money.js';
import { type Provenance, type ToolResult, result } from '../provenance.js';
import { LIABILITY_TYPES, type AccountType, gapNotes } from '../snapshot.js';

export interface NetWorthLine {
  accountId: string;
  name: string;
  institutionName: string | null;
  type: AccountType;
  subtype: string | null;
  mask: string | null;
  /** Signed contribution to net worth: positive for assets, negative for debts. */
  contributionCents: Cents;
}

export interface NetWorthData {
  netWorthCents: Cents;
  assetsCents: Cents;
  liabilitiesCents: Cents;
  /** Per-account breakdown, so the UI can show what rolled into the total. */
  lines: NetWorthLine[];
  /** Accounts skipped because Plaid returned no current balance. */
  excludedAccountIds: string[];
}

/**
 * netWorth (§4): assets − liabilities across ALL account types, including
 * illiquid ones (real estate, vehicles). `fireProgress` uses a narrower,
 * investable-only figure — the two are intentionally different numbers.
 *
 * Liability accounts (credit, loan) arrive from Plaid with a positive balance
 * meaning "amount owed". The sign flip to a negative contribution happens here
 * and only here.
 */
export function netWorth(ctx: Ctx): ToolResult<NetWorthData> {
  const snapshot = requireSnapshot(ctx, 'netWorth');

  const lines: NetWorthLine[] = [];
  const excludedAccountIds: string[] = [];
  let assetsCents = ZERO;
  let liabilitiesCents = ZERO;

  for (const account of snapshot.accounts) {
    if (account.currentCents === null) {
      excludedAccountIds.push(account.accountId);
      continue;
    }

    const isLiability = LIABILITY_TYPES.has(account.type);
    if (isLiability) {
      liabilitiesCents += account.currentCents;
    } else {
      assetsCents += account.currentCents;
    }

    lines.push({
      accountId: account.accountId,
      name: account.name,
      institutionName: account.institutionName,
      type: account.type,
      subtype: account.subtype,
      mask: account.mask,
      contributionCents: isLiability ? -account.currentCents : account.currentCents,
    });
  }

  const notes = gapNotes(snapshot, 'balances');
  if (excludedAccountIds.length > 0) {
    notes.push(
      `${excludedAccountIds.length} account(s) reported no current balance and are ` +
        `excluded from this total.`,
    );
  }

  const provenance: Provenance = {
    source: 'compute',
    asOf: snapshot.fetchedAt,
    accountIds: lines.map((l) => l.accountId),
    computation:
      'Sum of current balances on asset accounts (depository, investment, brokerage, other) ' +
      'minus sum of current balances on liability accounts (credit, loan).',
    inputs: ['getBalances'],
    ...(notes.length > 0 ? { notes } : {}),
  };

  return result(
    {
      netWorthCents: assetsCents - liabilitiesCents,
      assetsCents,
      liabilitiesCents,
      lines,
      excludedAccountIds,
    },
    provenance,
  );
}
