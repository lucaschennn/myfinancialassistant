/**
 * What the columns of a bank CSV mean (PHASE-2-INGESTION §3.3, §3.4).
 *
 * Bank headers are wildly inconsistent, so roles are inferred from header names
 * AND the shape of the values. Every inference here is a PROPOSAL the user
 * confirms on the review screen; nothing in this file is final.
 *
 * Two inferences matter far more than the rest, because getting them wrong
 * raises no error and leaves every figure plausible:
 *
 *  - Date format. `03/04/2026` is ambiguous alone and usually unambiguous over
 *    thirty rows. If the whole column stays ambiguous, we ASK — reading US dates
 *    as UK ones shifts transactions by months with nothing erroring.
 *  - Sign convention. Plaid's positive-means-money-OUT is the opposite of most
 *    bank exports. Backwards, it inverts savings rate and swaps income with
 *    spending. Detected here, confirmed by the user in plain words, converted
 *    once at the boundary.
 */

import { parseAmount } from '@pfg/core';

export type ColumnRole = 'date' | 'description' | 'amount' | 'debit' | 'credit' | 'balance' | 'category' | 'merchant';

/** Column index per role. Either `amount`, or `debit` and/or `credit`, must be present. */
export type ColumnMapping = Partial<Record<ColumnRole, number>>;

export const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MM/DD/YY', 'DD/MM/YY', 'DD.MM.YYYY', 'YYYY/MM/DD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Plaid's `personal_finance_category.primary` values — the only categories kept (§4, §10). */
export const PLAID_PRIMARY_CATEGORIES: ReadonlySet<string> = new Set([
  'INCOME',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'BANK_FEES',
  'ENTERTAINMENT',
  'FOOD_AND_DRINK',
  'GENERAL_MERCHANDISE',
  'HOME_IMPROVEMENT',
  'MEDICAL',
  'PERSONAL_CARE',
  'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT',
  'TRANSPORTATION',
  'TRAVEL',
  'RENT_AND_UTILITIES',
]);

const HEADER_PATTERNS: Array<[ColumnRole, RegExp]> = [
  ['date', /^(transaction |posting |post(ed)? |trans(action)? )?date$|^date posted$|^posted$/i],
  ['debit', /^(debit|debits|withdrawal|withdrawals|money out|paid out|outflow)( amount)?$/i],
  ['credit', /^(credit|credits|deposit|deposits|money in|paid in|inflow)( amount)?$/i],
  ['amount', /^(transaction )?amount$|^amt$|^value$/i],
  ['balance', /^(running |ending |available )?balance$/i],
  ['category', /^(transaction )?category$|^type$/i],
  ['merchant', /^merchant( name)?$|^payee$/i],
  ['description', /^(transaction )?(description|details|memo|narrative|name|particulars)$/i],
];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function realDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Read one value in one format into ISO YYYY-MM-DD, or null when it does not fit. */
export function parseDate(value: string, format: DateFormat): string | null {
  const v = value.trim();
  let m: RegExpExecArray | null;
  const year2 = (yy: number): number => (yy >= 70 ? 1900 + yy : 2000 + yy);
  switch (format) {
    case 'YYYY-MM-DD':
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
      return m ? realDate(+m[1]!, +m[2]!, +m[3]!) : null;
    case 'YYYY/MM/DD':
      m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
      return m ? realDate(+m[1]!, +m[2]!, +m[3]!) : null;
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      return m ? realDate(+m[3]!, +m[1]!, +m[2]!) : null;
    case 'DD/MM/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      return m ? realDate(+m[3]!, +m[2]!, +m[1]!) : null;
    case 'MM/DD/YY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(v);
      return m ? realDate(year2(+m[3]!), +m[1]!, +m[2]!) : null;
    case 'DD/MM/YY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(v);
      return m ? realDate(year2(+m[3]!), +m[2]!, +m[1]!) : null;
    case 'DD.MM.YYYY':
      m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
      return m ? realDate(+m[3]!, +m[2]!, +m[1]!) : null;
  }
}

/**
 * Every format that reads EVERY non-empty value in the column as a real date.
 * One survivor is a decision; several (e.g. MM/DD and DD/MM when no day exceeds
 * 12) is a question for the user; none means the column is not dates.
 */
export function candidateDateFormats(values: string[]): DateFormat[] {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  if (present.length === 0) return [];
  return DATE_FORMATS.filter((f) => present.every((v) => parseDate(v, f) !== null));
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function column(rows: string[][], index: number): string[] {
  return rows.map((r) => r[index] ?? '');
}

function mostlyAmounts(values: string[]): boolean {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  if (present.length === 0) return false;
  return present.filter((v) => parseAmount(v).ok).length / present.length >= 0.9;
}

export interface InferredColumns {
  mapping: ColumnMapping;
  /** Column indexes no role claimed — shown on the review screen, never silently dropped. */
  unused: number[];
}

/** Propose a role for each column from its header, then fill gaps from the values' shape. */
export function inferColumns(header: string[], rows: string[][]): InferredColumns {
  const mapping: ColumnMapping = {};
  const claimed = new Set<number>();
  const claim = (role: ColumnRole, index: number): void => {
    if (mapping[role] === undefined && !claimed.has(index)) {
      mapping[role] = index;
      claimed.add(index);
    }
  };

  header.forEach((name, index) => {
    for (const [role, pattern] of HEADER_PATTERNS) {
      if (pattern.test(name.trim())) {
        claim(role, index);
        break;
      }
    }
  });

  // Shape fallbacks for headers we did not recognise.
  if (mapping.date === undefined) {
    const idx = header.findIndex((_, i) => !claimed.has(i) && candidateDateFormats(column(rows, i)).length > 0);
    if (idx >= 0) claim('date', idx);
  }
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) {
    const idx = header.findIndex((_, i) => !claimed.has(i) && mostlyAmounts(column(rows, i)));
    if (idx >= 0) claim('amount', idx);
  }
  if (mapping.description === undefined) {
    // The widest remaining text column is the best guess at a description.
    let best = -1;
    let bestLen = 0;
    header.forEach((_, i) => {
      if (claimed.has(i)) return;
      const values = column(rows, i);
      if (mostlyAmounts(values)) return;
      const len = values.reduce((n, v) => n + v.length, 0);
      if (len > bestLen) {
        best = i;
        bestLen = len;
      }
    });
    if (best >= 0) claim('description', best);
  }

  // A "Category" column only earns the role if it speaks Plaid's taxonomy;
  // a bank's own labels ("Groceries") are not mapped onto it (§10).
  if (mapping.category !== undefined) {
    const values = column(rows, mapping.category).map((v) => v.trim()).filter((v) => v !== '');
    if (!values.every((v) => PLAID_PRIMARY_CATEGORIES.has(v.toUpperCase()))) {
      claimed.delete(mapping.category);
      delete mapping.category;
    }
  }

  return { mapping, unused: header.map((_, i) => i).filter((i) => !claimed.has(i)) };
}

// ---------------------------------------------------------------------------
// Sign convention
// ---------------------------------------------------------------------------

/**
 * `plaid`: a positive amount is money LEAVING the account (Plaid's convention).
 * `inverted`: a negative amount is money leaving (most bank exports).
 */
export type SignConvention = 'plaid' | 'inverted';

export interface SignDetection {
  detected: SignConvention;
  /** Plain-language reason, shown beside the sample sentences. */
  evidence: string;
  /** False when the signals were weak or conflicting; the review screen leads with it. */
  confident: boolean;
}

const INCOME_HINT = /payroll|salary|direct dep|deposit|interest paid|interest earned|refund|reimburse|dividend|transfer from/i;

/**
 * Detect a single signed amount column's convention. Strongest signal first:
 * rows whose description is recognisably money IN show which sign means "in".
 * Otherwise, most people have far more outflows than inflows, so the majority
 * sign is probably "out". Either way the user confirms it in plain words.
 */
export function detectSignConvention(amounts: string[], descriptions: string[]): SignDetection {
  let incomePositive = 0;
  let incomeNegative = 0;
  let positive = 0;
  let negative = 0;
  amounts.forEach((raw, i) => {
    const parsed = parseAmount(raw);
    if (!parsed.ok || parsed.cents === 0n) return;
    const isNegative = parsed.cents < 0n;
    if (isNegative) negative += 1;
    else positive += 1;
    if (INCOME_HINT.test(descriptions[i] ?? '')) {
      if (isNegative) incomeNegative += 1;
      else incomePositive += 1;
    }
  });

  if (incomePositive + incomeNegative > 0 && incomePositive !== incomeNegative) {
    // Income shows up as negative → negative means money in → Plaid's convention.
    const detected: SignConvention = incomeNegative > incomePositive ? 'plaid' : 'inverted';
    const n = Math.max(incomePositive, incomeNegative);
    return {
      detected,
      evidence:
        `${n} row(s) that look like money coming in (pay, deposits, refunds) are ` +
        `${detected === 'plaid' ? 'negative' : 'positive'}, so a ` +
        `${detected === 'plaid' ? 'positive' : 'negative'} amount is read as money going out.`,
      confident: Math.min(incomePositive, incomeNegative) === 0,
    };
  }

  if (positive === negative) {
    return {
      detected: 'inverted',
      evidence:
        'There are as many positive amounts as negative ones, so the direction could not be ' +
        'worked out from the file. Most bank exports show spending as negative; check the examples.',
      confident: false,
    };
  }
  const detected: SignConvention = negative > positive ? 'inverted' : 'plaid';
  const total = positive + negative;
  const majority = Math.max(positive, negative);
  return {
    detected,
    evidence:
      `${majority} of ${total} amounts are ${detected === 'inverted' ? 'negative' : 'positive'}. ` +
      'Most rows in an account are spending, so that sign is read as money going out.',
    confident: majority / total >= 0.7,
  };
}
