/**
 * Extracted pages + the model's verbatim claims + the user's decisions → a
 * draft (PHASE-2-INGESTION §3.5, §4).
 *
 * Order matters, and is the whole design:
 *   1. `checkTranscription()` runs over EVERY quoted string first. A string not
 *      found in the statement text (or not on the page claimed) is dropped, with
 *      its reason, before anything is built from it.
 *   2. Only then are surviving strings converted — amounts by `parseAmount`,
 *      dates by the deterministic parser below. The model never emitted a
 *      number, so there is no number of its to trust.
 *   3. Totals the statement prints are COMPARED with the sum of the rows, by
 *      code, and any disagreement becomes a discrepancy the user must look at.
 *      Nothing is reconciled, and the model is never asked which is right (§4.4).
 */

import { type AccountType, type Cents, LIABILITY_TYPES, formatCents, parseAmount } from '@pfg/core';
import { candidateDateFormats, parseDate } from '../csv/columns.js';
import type { DateFormat } from '../csv/columns.js';
import type { Decisions, Draft, DraftAccount, DraftField, DraftHolding, DraftTransaction } from '../draft.js';
import { type TranscriptionClaim, checkTranscription, describeViolation } from './guard.js';
import type { AccountKind, PdfTranscription, Quoted } from './transcribe.js';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function iso(y: number, m: number, d: number): string | null {
  return parseDate(`${y}-${m}-${d}`, 'YYYY-MM-DD');
}

/** Month-name dates are unambiguous: "Aug 31, 2026", "August 31 2026", "31 Aug 2026", "Aug 31". */
function monthOf(name: string): number | undefined {
  const lower = name.toLowerCase();
  const month = MONTHS[lower.slice(0, 3)];
  // A month name, not merely something that starts like one: the rest must
  // continue the real name ("Sept", "August"), never arbitrary text.
  if (month === undefined) return undefined;
  const full = MONTH_NAMES[month - 1]!.toLowerCase();
  return full.startsWith(lower) || lower === 'sept' ? month : undefined;
}

function parseNamedDate(raw: string, fallbackYear: number | null): string | null {
  const v = raw.trim().replace(/\./g, '').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = /^([A-Za-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(v);
  if (m) {
    const month = monthOf(m[1]!);
    const year = m[3] ? +m[3] : fallbackYear;
    return month && year ? iso(year, month, +m[2]!) : null;
  }
  m = /^(\d{1,2}) ([A-Za-z]+)(?: (\d{4}))?$/.exec(v);
  if (m) {
    const month = monthOf(m[2]!);
    const year = m[3] ? +m[3] : fallbackYear;
    return month && year ? iso(year, month, +m[1]!) : null;
  }
  return null;
}

const NUMERIC_NO_YEAR = /^\d{1,2}\/\d{1,2}$/;

/**
 * The date a statement's closing balance is true on. Models often quote the
 * whole period ("Aug 1, 2026 - Aug 31, 2026") — the guard accepts it, since it
 * is printed — so a period resolves to its END date, deterministically.
 */
export function parseStatementEndDate(raw: string): string | null {
  const parts = raw.split(/\s+(?:-|–|—|to|through|thru)\s+/i);
  const end = parts[parts.length - 1]!.trim();
  const named = parseNamedDate(end, null);
  if (named) return named;
  const candidates = candidateDateFormats([end]);
  if (candidates.length === 1) return parseDate(end, candidates[0]!);
  // Ambiguous on its own (03/04/2026): US statements are month-first, and the
  // review screen shows the date for the user to correct if that is wrong.
  return candidates.includes('MM/DD/YYYY') ? parseDate(end, 'MM/DD/YYYY') : null;
}

/** A numeric date with no year ("08/14") borrows the statement's year — or the year before, for a December line on a January statement. */
function parseStatementDate(raw: string, format: DateFormat | null, statementDate: string | null): string | null {
  const named = parseNamedDate(raw, statementDate ? +statementDate.slice(0, 4) : null);
  if (named) return named;
  const v = raw.trim();
  if (!format) return parseDate(v, 'YYYY-MM-DD');
  if (NUMERIC_NO_YEAR.test(v) && statementDate) {
    const year = +statementDate.slice(0, 4);
    const candidate = parseDate(`${v}/${year}`, format === 'DD/MM/YY' ? 'DD/MM/YYYY' : format === 'MM/DD/YY' ? 'MM/DD/YYYY' : format);
    if (candidate && candidate > statementDate) {
      return parseDate(`${v}/${year - 1}`, format === 'DD/MM/YY' ? 'DD/MM/YYYY' : format === 'MM/DD/YY' ? 'MM/DD/YYYY' : format);
    }
    return candidate;
  }
  return parseDate(v, format);
}

const KIND_TO_TYPE: Record<AccountKind, { type: AccountType; subtype: string | null }> = {
  checking: { type: 'depository', subtype: 'checking' },
  savings: { type: 'depository', subtype: 'savings' },
  credit_card: { type: 'credit', subtype: 'credit card' },
  loan: { type: 'loan', subtype: null },
  mortgage: { type: 'loan', subtype: 'mortgage' },
  brokerage: { type: 'investment', subtype: 'brokerage' },
  retirement: { type: 'investment', subtype: 'retirement' },
  other: { type: 'other', subtype: null },
  unknown: { type: 'depository', subtype: null },
};

/**
 * A statement balance in the ledger's convention. CR/DR mean opposite things on
 * the two kinds of account: on a bank account "CR" is money you hold, on a card
 * it is money owed TO you. Liabilities are stored as the positive amount owed.
 */
function balanceCents(raw: string, isLiability: boolean): Cents | null {
  const p = parseAmount(raw);
  if (!p.ok) return null;
  const suffix = /\b(CR|DR)\s*$/i.exec(raw.trim())?.[1]?.toUpperCase();
  const mag = p.cents < 0n ? -p.cents : p.cents;
  if (suffix === 'CR') return isLiability ? -mag : mag;
  if (suffix === 'DR') return isLiability ? mag : -mag;
  return p.cents;
}

const present = (q: Quoted | undefined): q is Quoted => Boolean(q && q.raw.trim() !== '');
const claim = (label: string, q: Quoted, kind: 'amount' | 'text'): TranscriptionClaim => ({
  label,
  raw: q.raw,
  kind,
  ...(q.page > 0 ? { page: q.page } : {}),
});
const transcribed = <T>(value: T, q: Quoted, confidence?: 'high' | 'low'): DraftField<T> => ({
  value,
  raw: q.raw,
  origin: 'transcribed',
  ...(q.page > 0 ? { page: q.page } : {}),
  ...(confidence ? { confidence } : {}),
});
const user = <T>(value: T, raw: string): DraftField<T> => ({ value, raw, origin: 'user' });

export interface BuildPdfDraftInput {
  documentId: string;
  pages: string[];
  transcription: PdfTranscription;
  decisions: Decisions;
}

export function buildPdfDraft({ documentId, pages, transcription: t, decisions }: BuildPdfDraftInput): Draft {
  const draft: Draft = { documentId, kind: 'pdf', accounts: [], unparsed: [], discrepancies: [], dropped: [], notes: [] };

  // --- 1. the guard, over every quoted string --------------------------------
  const claims: TranscriptionClaim[] = [];
  const header: Array<[string, Quoted, 'amount' | 'text']> = [
    ['account number', t.accountNumber, 'text'],
    ['statement date', t.statementDate, 'text'],
    ['opening balance', t.openingBalance, 'amount'],
    ['closing balance', t.closingBalance, 'amount'],
  ];
  for (const [label, q, kind] of header) if (present(q)) claims.push(claim(label, q, kind));
  t.totals.forEach((x, i) => claims.push(claim(`total ${i + 1}: ${x.label}`, { raw: x.raw, page: x.page }, 'amount')));
  t.transactions.forEach((x, i) => {
    claims.push(claim(`row ${i + 1} date`, x.date, 'text'));
    claims.push(claim(`row ${i + 1} description`, x.description, 'text'));
    claims.push(claim(`row ${i + 1} amount`, x.amount, 'amount'));
  });
  t.holdings.forEach((x, i) => {
    claims.push(claim(`holding ${i + 1} name`, x.name, 'text'));
    if (present(x.quantity)) claims.push(claim(`holding ${i + 1} quantity`, x.quantity, 'text'));
    claims.push(claim(`holding ${i + 1} value`, x.value, 'amount'));
  });

  const report = checkTranscription(pages, claims);
  const rejected = new Set(report.violations.map((v) => v.label));
  for (const v of report.violations) {
    draft.dropped.push({ label: v.label, raw: v.raw, ...(v.page !== undefined ? { page: v.page } : {}), reason: describeViolation(v) });
  }
  const ok = (label: string, q: Quoted): boolean => present(q) && !rejected.has(label);

  // --- 2. the account -----------------------------------------------------------
  const kind = KIND_TO_TYPE[t.accountKind] ?? KIND_TO_TYPE.unknown;
  const a = decisions.account ?? {};
  const type = (a.type ?? kind.type) as AccountType;
  const isLiability = LIABILITY_TYPES.has(type);
  const mask = ok('account number', t.accountNumber) ? (/(\d{2,4})\D*$/.exec(t.accountNumber.raw)?.[1] ?? null) : null;
  const proposedName = [t.institutionName.raw.trim(), t.accountName.raw.trim()].filter(Boolean).join(' ') || '';

  const account: DraftAccount = {
    ...(a.existingAccountId ? { existingAccountId: a.existingAccountId } : {}),
    name: a.name !== undefined ? user(a.name, a.name) : transcribed(proposedName, t.accountName),
    type: a.type !== undefined ? user(type, type) : transcribed(type, { raw: t.accountKind, page: 0 }),
    subtype: a.subtype !== undefined ? user(a.subtype.trim() || null, a.subtype) : transcribed(kind.subtype, { raw: t.accountKind, page: 0 }),
    mask: a.mask !== undefined ? user(a.mask.trim() || null, a.mask) : transcribed(mask, t.accountNumber),
    institutionName:
      a.institutionName !== undefined ? user(a.institutionName.trim() || null, a.institutionName) : transcribed(t.institutionName.raw.trim() || null, t.institutionName),
    transactions: [],
    holdings: [],
  };
  if (t.accountKind === 'unknown') {
    draft.notes.push('The kind of account could not be read from the statement. Check it before importing.');
  }
  if (t.otherAccountsOnStatement > 0) {
    draft.notes.push(
      `This statement covers ${t.otherAccountsOnStatement + 1} accounts. Only the first was read; import the others separately or add them by hand.`,
    );
  }

  // --- statement date and date format ------------------------------------------
  const statementDate = ok('statement date', t.statementDate) ? parseStatementEndDate(t.statementDate.raw) : null;
  if (ok('statement date', t.statementDate) && !statementDate) {
    draft.unparsed.push({ where: 'Statement date', text: t.statementDate.raw, reason: 'Not a date that could be read with certainty.' });
  }
  const numericDates = t.transactions
    .map((x, i) => ({ raw: x.date.raw.trim(), i }))
    .filter((x) => ok(`row ${x.i + 1} date`, t.transactions[x.i]!.date) && /^\d/.test(x.raw))
    .map((x) => (NUMERIC_NO_YEAR.test(x.raw) ? `${x.raw}/${statementDate?.slice(0, 4) ?? '2000'}` : x.raw));
  const candidates = numericDates.length > 0 ? candidateDateFormats(numericDates) : [];
  let dateFormat: DateFormat | null = decisions.dateFormat ?? null;
  if (!dateFormat) {
    const nonIso = candidates.filter((c) => c !== 'YYYY-MM-DD' && c !== 'YYYY/MM/DD');
    dateFormat = candidates.length === 1 ? candidates[0]! : nonIso.length === 0 && candidates.length > 0 ? candidates[0]! : null;
  }
  if (numericDates.length > 0) draft.dateFormat = { applied: dateFormat, candidates };

  // --- balance --------------------------------------------------------------------
  if (ok('closing balance', t.closingBalance) && statementDate) {
    const cents = balanceCents(t.closingBalance.raw, isLiability);
    if (cents !== null) {
      account.balance = {
        asOfDate: transcribed(statementDate, t.statementDate),
        currentCents: transcribed(cents, t.closingBalance),
      };
    }
  } else if (ok('closing balance', t.closingBalance) && !statementDate) {
    draft.unparsed.push({ where: 'Closing balance', text: t.closingBalance.raw, reason: 'No statement date could be read, so the balance has no date. Add one below.' });
  }
  if (decisions.balanceEdit) {
    const e = decisions.balanceEdit;
    if (e.remove) delete account.balance;
    else {
      const p = e.amount ? parseAmount(e.amount) : null;
      const date = e.asOfDate && parseDate(e.asOfDate, 'YYYY-MM-DD') ? e.asOfDate : account.balance?.asOfDate.value;
      if (p?.ok && date) account.balance = { asOfDate: user(date, e.asOfDate ?? date), currentCents: user(p.cents, e.amount!) };
      else if (account.balance && date && e.asOfDate) account.balance = { ...account.balance, asOfDate: user(date, e.asOfDate) };
    }
  }

  // --- transactions -------------------------------------------------------------------
  const flip = decisions.signConvention === 'inverted';
  t.transactions.forEach((x, i) => {
    const row = i + 1;
    const edit = decisions.rowEdits?.[String(row)];
    const labels = [`row ${row} date`, `row ${row} description`, `row ${row} amount`];
    if (labels.some((l) => rejected.has(l)) && !edit?.amount) return; // dropped, and listed

    const parsedAmount = parseAmount(x.amount.raw);
    if (!parsedAmount.ok && !edit?.amount) {
      draft.unparsed.push({ where: `Row ${row}`, text: `${x.description.raw} ${x.amount.raw}`, reason: parsedAmount.reason });
      return;
    }
    let amount: DraftField<Cents>;
    if (edit?.amount && parseAmount(edit.amount).ok) {
      const p = parseAmount(edit.amount) as { ok: true; cents: Cents };
      const mag = p.cents < 0n ? -p.cents : p.cents;
      amount = user(edit.direction === 'in' ? -mag : mag, edit.amount);
    } else {
      const cents = (parsedAmount as { ok: true; cents: Cents }).cents;
      const mag = cents < 0n ? -cents : cents;
      // Direction from the statement's own layout as read; with none, a negative
      // or CR figure is read as money out — and the row is marked low confidence.
      let out: boolean;
      if (x.direction === 'out') out = true;
      else if (x.direction === 'in') out = false;
      else out = cents < 0n;
      if (flip) out = !out;
      amount = transcribed(out ? mag : -mag, x.amount, x.direction === 'unknown' ? 'low' : 'high');
    }

    let date: DraftField<string>;
    if (edit?.date && parseDate(edit.date, 'YYYY-MM-DD')) date = user(edit.date, edit.date);
    else {
      const parsed = parseStatementDate(x.date.raw, dateFormat, statementDate);
      if (!parsed && dateFormat) {
        draft.unparsed.push({
          where: `Row ${row}`,
          text: x.date.raw,
          reason:
            NUMERIC_NO_YEAR.test(x.date.raw.trim()) && !statementDate
              ? 'The date has no year, and no statement date could be read to supply one.'
              : 'Not a date that could be read.',
        });
        return;
      }
      date = transcribed(parsed ?? '', x.date);
    }
    const name = edit?.name?.trim() ? user(edit.name.trim(), edit.name) : transcribed(x.description.raw.trim(), x.description);
    const txn: DraftTransaction = { row, include: edit?.include ?? true, date, amountCents: amount, name, merchantName: null, categoryPrimary: null };
    account.transactions.push(txn);
  });

  if (account.transactions.length > 0) {
    const withDirection = t.transactions.filter((x) => x.direction !== 'unknown').length;
    draft.signConvention = {
      detected: 'plaid',
      applied: flip ? 'inverted' : 'plaid',
      evidence:
        withDirection === t.transactions.length
          ? "Each row's direction comes from the statement's own layout — the column or section it sits in."
          : `${t.transactions.length - withDirection} row(s) gave no direction on the statement; for those a negative or CR amount is read as money out. They are marked low confidence.`,
      confident: withDirection === t.transactions.length,
      fromColumns: false,
      samples: [],
    };
    const included = account.transactions.filter((x) => x.include && x.amountCents.origin === 'transcribed');
    for (const x of [included.find((r) => r.amountCents.value > 0n), included.find((r) => r.amountCents.value < 0n)]) {
      if (!x) continue;
      const mag = formatCents(x.amountCents.value < 0n ? -x.amountCents.value : x.amountCents.value);
      const [y, m, d] = x.date.value.split('-').map(Number);
      const when = x.date.value ? ` on ${d} ${MONTH_NAMES[(m ?? 1) - 1]} ${y}` : '';
      draft.signConvention.samples.push({
        raw: `${x.name.raw}  ${x.amountCents.raw}`,
        sentence: x.amountCents.value > 0n ? `${mag} ${isLiability ? 'charged at' : 'spent at'} ${x.name.value}${when}` : `${mag} ${isLiability ? 'paid or credited' : 'received'} — ${x.name.value}${when}`,
      });
    }
  }

  // --- holdings -------------------------------------------------------------------------
  t.holdings.forEach((h, i) => {
    const n = i + 1;
    if (rejected.has(`holding ${n} name`) || rejected.has(`holding ${n} value`) || rejected.has(`holding ${n} quantity`)) return;
    const value = parseAmount(h.value.raw);
    const qtyText = h.quantity.raw.replace(/,/g, '').trim();
    const quantity = /^\d+(\.\d+)?$/.test(qtyText) ? Number(qtyText) : null;
    if (!value.ok || quantity === null || !statementDate) {
      draft.unparsed.push({
        where: `Holding ${n}`,
        text: `${h.name.raw} ${h.quantity.raw} ${h.value.raw}`.trim(),
        reason: !statementDate ? 'No statement date to date the position by.' : 'Quantity or value could not be read with certainty.',
      });
      return;
    }
    const holding: DraftHolding = {
      securityName: transcribed(h.name.raw.trim(), h.name),
      tickerSymbol: h.ticker.trim() || null,
      securityType: null,
      quantity: transcribed(quantity, h.quantity),
      valueCents: transcribed(value.cents, h.value),
      asOfDate: transcribed(statementDate, t.statementDate),
    };
    account.holdings.push(holding);
  });
  if (account.holdings.length > 0) {
    draft.notes.push('Security types are not read from statements, so these holdings count as "other" in your asset allocation.');
  }

  // --- 3. totals versus rows: compared, never reconciled (§4.4) ---------------------------
  const included = account.transactions.filter((x) => x.include);
  const sumOut = included.filter((x) => x.amountCents.value > 0n).reduce((s, x) => s + x.amountCents.value, 0n);
  const sumIn = included.filter((x) => x.amountCents.value < 0n).reduce((s, x) => s - x.amountCents.value, 0n);
  t.totals.forEach((total, i) => {
    if (rejected.has(`total ${i + 1}: ${total.label}`) || total.kind === 'other' || included.length === 0) return;
    const p = parseAmount(total.raw);
    if (!p.ok) return;
    const stated = p.cents < 0n ? -p.cents : p.cents;
    const computed = total.kind === 'money_in' ? sumIn : sumOut;
    if (stated !== computed) {
      draft.discrepancies.push({ label: total.label, statedRaw: total.raw, statedCents: stated, computedCents: computed, ...(total.page > 0 ? { page: total.page } : {}) });
    }
  });
  if (ok('opening balance', t.openingBalance) && account.balance && included.length > 0) {
    const opening = balanceCents(t.openingBalance.raw, isLiability);
    if (opening !== null) {
      // Money out raises what a card owes and lowers what an account holds.
      const expected = isLiability ? opening + sumOut - sumIn : opening - sumOut + sumIn;
      if (expected !== account.balance.currentCents.value) {
        draft.discrepancies.push({
          label: 'Closing balance versus opening balance plus the rows below',
          statedRaw: t.closingBalance.raw,
          statedCents: account.balance.currentCents.value,
          computedCents: expected,
          ...(t.closingBalance.page > 0 ? { page: t.closingBalance.page } : {}),
        });
      }
    }
  }

  draft.accounts.push(account);
  return draft;
}
