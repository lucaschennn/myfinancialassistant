/**
 * §0.8 made testable. The hallucination test is the reason the guard exists:
 * a model that "reads" a balance the statement does not contain must have that
 * field dropped before review, with the reason shown — never in the ledger.
 */

import { describe, expect, it } from 'vitest';
import { commitDraft, transcribedClaims, CommitBlockedError } from '../commit.js';
import { blockers } from '../draft.js';
import { buildPdfDraft, parseStatementEndDate } from './draft.js';
import { checkTranscription } from './guard.js';
import type { PdfTranscription, Quoted } from './transcribe.js';

const PAGES = [
  [
    'Hometown Credit Union',
    'Everyday Checking   Account number: XXXX4412',
    'Statement period 08/01/2026 to 08/31/2026',
    'Beginning balance   $3,200.00',
    'Ending balance      $4,475.45',
    'Total deposits      $3,250.00',
    'Total withdrawals   $1,974.55',
  ].join('\n'),
  [
    'Deposits',
    '08/01   ACME CORP PAYROLL        3,250.00',
    'Withdrawals',
    '08/03   STARBUCKS #4412             4.85',
    '08/05   CITY POWER & LIGHT        121.40',
    '08/28   RENT AUGUST             1,800.00',
    '08/30   SHELL OIL 5521             48.30',
  ].join('\n'),
];

const q = (raw: string, page: number): Quoted => ({ raw, page });
const none: Quoted = { raw: '', page: 0 };

function honest(): PdfTranscription {
  return {
    institutionName: q('Hometown Credit Union', 1),
    accountName: q('Everyday Checking', 1),
    accountNumber: q('XXXX4412', 1),
    accountKind: 'checking',
    statementDate: q('08/31/2026', 1),
    openingBalance: q('$3,200.00', 1),
    closingBalance: q('$4,475.45', 1),
    totals: [
      { kind: 'money_in', label: 'Total deposits', raw: '$3,250.00', page: 1 },
      { kind: 'money_out', label: 'Total withdrawals', raw: '$1,974.55', page: 1 },
    ],
    transactions: [
      { date: q('08/01', 2), description: q('ACME CORP PAYROLL', 2), amount: q('3,250.00', 2), direction: 'in' },
      { date: q('08/03', 2), description: q('STARBUCKS #4412', 2), amount: q('4.85', 2), direction: 'out' },
      { date: q('08/05', 2), description: q('CITY POWER & LIGHT', 2), amount: q('121.40', 2), direction: 'out' },
      { date: q('08/28', 2), description: q('RENT AUGUST', 2), amount: q('1,800.00', 2), direction: 'out' },
      { date: q('08/30', 2), description: q('SHELL OIL 5521', 2), amount: q('48.30', 2), direction: 'out' },
    ],
    holdings: [],
    otherAccountsOnStatement: 0,
  };
}

describe('checkTranscription', () => {
  it('passes strings that occur verbatim, forgiving only whitespace', () => {
    const report = checkTranscription(PAGES, [
      { label: 'closing', raw: '$4,475.45', page: 1, kind: 'amount' },
      { label: 'payee', raw: 'ACME   CORP\nPAYROLL', page: 2, kind: 'text' },
    ]);
    expect(report).toEqual({ ok: true, violations: [] });
  });

  it('rejects an invented figure — the hallucination case', () => {
    const report = checkTranscription(PAGES, [{ label: 'closing balance', raw: '$4,457.45', page: 1, kind: 'amount' }]);
    expect(report.violations).toEqual([{ label: 'closing balance', raw: '$4,457.45', page: 1, reason: 'not-found-in-text' }]);
  });

  it('does not forgive currency formatting: a tidied figure is not the printed one', () => {
    const report = checkTranscription(PAGES, [
      { label: 'tidied', raw: '4475.45', kind: 'amount' },
      { label: 'resigned', raw: '-$4,475.45', kind: 'amount' },
    ]);
    expect(report.violations.map((v) => [v.label, v.reason])).toEqual([
      ['tidied', 'not-found-in-text'],
      ['resigned', 'not-found-in-text'],
    ]);
  });

  it('rejects a real figure attributed to the wrong page', () => {
    const report = checkTranscription(PAGES, [{ label: 'rent', raw: '1,800.00', page: 1, kind: 'amount' }]);
    expect(report.violations).toEqual([{ label: 'rent', raw: '1,800.00', page: 1, reason: 'not-on-claimed-page' }]);
  });

  it('rejects a found string that is not readable as an amount', () => {
    const report = checkTranscription(PAGES, [{ label: 'period', raw: '08/01/2026', page: 1, kind: 'amount' }]);
    expect(report.violations[0]?.reason).toBe('unparseable-amount');
  });
});

describe('parseStatementEndDate', () => {
  it('takes the end of a quoted period, in the forms statements print', () => {
    expect(parseStatementEndDate('Aug 1, 2026 - Aug 31, 2026')).toBe('2026-08-31');
    expect(parseStatementEndDate('08/01/2026 to 08/31/2026')).toBe('2026-08-31');
    expect(parseStatementEndDate('July 1 through July 31, 2026')).toBe('2026-07-31');
    expect(parseStatementEndDate('31 August 2026')).toBe('2026-08-31');
    expect(parseStatementEndDate('2026-08-31')).toBe('2026-08-31');
    expect(parseStatementEndDate('soon')).toBeNull();
  });

  it('a quoted period still dates the balance and the year-less rows', () => {
    const t = honest();
    const pages = [PAGES[0]!.replace('Statement period 08/01/2026 to 08/31/2026', 'Statement period Aug 1, 2026 - Aug 31, 2026'), PAGES[1]!];
    t.statementDate = q('Aug 1, 2026 - Aug 31, 2026', 1);
    const draft = buildPdfDraft({ documentId: 'doc', pages, transcription: t, decisions: {} });
    expect(draft.accounts[0]!.balance?.asOfDate.value).toBe('2026-08-31');
    expect(draft.accounts[0]!.transactions).toHaveLength(5);
    expect(draft.accounts[0]!.transactions[1]!.date.value).toBe('2026-08-03');
  });
});

describe('buildPdfDraft', () => {
  it('builds an honest transcription into Plaid-convention cents, dated from the statement', () => {
    const draft = buildPdfDraft({ documentId: 'doc', pages: PAGES, transcription: honest(), decisions: {} });
    const account = draft.accounts[0]!;
    expect(draft.dropped).toEqual([]);
    expect(draft.discrepancies).toEqual([]);
    expect(account.type.value).toBe('depository');
    expect(account.mask.value).toBe('4412');
    expect(account.balance?.currentCents).toEqual({ value: 447_545n, raw: '$4,475.45', origin: 'transcribed', page: 1 });
    expect(account.balance?.asOfDate.value).toBe('2026-08-31');
    expect(account.transactions.map((t) => [t.date.value, t.name.value, t.amountCents.value])).toEqual([
      ['2026-08-01', 'ACME CORP PAYROLL', -325_000n],
      ['2026-08-03', 'STARBUCKS #4412', 485n],
      ['2026-08-05', 'CITY POWER & LIGHT', 12_140n],
      ['2026-08-28', 'RENT AUGUST', 180_000n],
      ['2026-08-30', 'SHELL OIL 5521', 4_830n],
    ]);
    expect(draft.signConvention?.samples.map((s) => s.sentence)).toEqual([
      '$4.85 spent at STARBUCKS #4412 on 3 August 2026',
      '$3,250.00 received — ACME CORP PAYROLL on 1 August 2026',
    ]);
  });

  it('drops a hallucinated closing balance before review, and says why', () => {
    const t = honest();
    t.closingBalance = q('$4,457.45', 1);
    const draft = buildPdfDraft({ documentId: 'doc', pages: PAGES, transcription: t, decisions: {} });
    expect(draft.accounts[0]!.balance).toBeUndefined();
    expect(draft.dropped).toEqual([
      {
        label: 'closing balance',
        raw: '$4,457.45',
        page: 1,
        reason: 'Not found anywhere in the statement text, so it was treated as invented and dropped.',
      },
    ]);
  });

  it('drops a whole transaction whose amount was invented', () => {
    const t = honest();
    t.transactions[2] = { ...t.transactions[2]!, amount: q('112.40', 2) };
    const draft = buildPdfDraft({ documentId: 'doc', pages: PAGES, transcription: t, decisions: {} });
    expect(draft.accounts[0]!.transactions.map((x) => x.name.value)).not.toContain('CITY POWER & LIGHT');
    expect(draft.dropped.map((d) => d.label)).toEqual(['row 3 amount']);
    // With a row gone, the statement's own total no longer matches: shown, not fixed.
    expect(draft.discrepancies.map((d) => [d.label, d.statedCents, d.computedCents])).toEqual([
      ['Total withdrawals', 197_455n, 185_315n],
      ['Closing balance versus opening balance plus the rows below', 447_545n, 459_685n],
    ]);
    expect(blockers(draft, { signConfirmed: true })).toContain(
      'Acknowledge the totals that do not add up. They are not fixed for you.',
    );
  });

  it('reads CR the way each kind of account means it', () => {
    const t = honest();
    const card = buildPdfDraft({
      documentId: 'doc',
      pages: [`${PAGES[0]}\nNew balance 52.10 CR`, PAGES[1]!],
      transcription: { ...t, accountKind: 'credit_card', closingBalance: q('52.10 CR', 1), totals: [], openingBalance: none },
      decisions: {},
    });
    // On a card, CR is money owed TO you: a negative amount owed.
    expect(card.accounts[0]!.balance?.currentCents.value).toBe(-5_210n);
  });

  it('commit refuses a draft carrying a transcribed figure that is not in the text', async () => {
    const draft = buildPdfDraft({ documentId: 'doc', pages: PAGES, transcription: honest(), decisions: {} });
    // Tamper after the guard ran, as a bug upstream might.
    draft.accounts[0]!.balance!.currentCents = { value: 999_999n, raw: '$9,999.99', origin: 'transcribed', page: 1 };
    expect(transcribedClaims(draft).some((c) => c.raw === '$9,999.99')).toBe(true);
    await expect(
      commitDraft({
        db: {} as never,
        userId: 'u',
        draft,
        decisions: { signConfirmed: true, discrepanciesAcknowledged: true, account: { name: 'Checking' } },
        pages: PAGES,
      }),
    ).rejects.toThrow(CommitBlockedError);
  });
});
