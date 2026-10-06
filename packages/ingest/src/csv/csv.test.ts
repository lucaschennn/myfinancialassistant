import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockers } from '../draft.js';
import { candidateDateFormats, detectSignConvention, inferColumns } from './columns.js';
import { buildCsvDraft } from './draft.js';
import { CsvParseError, parseCsv, parseCsvRows } from './parse.js';

const fixture = (name: string): string =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures', name), 'utf8');

const amounts = (draft: ReturnType<typeof buildCsvDraft>) =>
  draft.accounts[0]!.transactions.map((t) => [t.name.value, t.amountCents.value]);

describe('parseCsv (RFC 4180)', () => {
  it('handles quotes, escaped quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const rows = parseCsvRows('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });

  it('refuses malformed quoting and files with no data', () => {
    expect(() => parseCsvRows('a,b\n"open,2')).toThrow(CsvParseError);
    expect(() => parseCsvRows('a,b\nx"y,2')).toThrow(CsvParseError);
    expect(() => parseCsv('just one column\nvalue')).toThrow('at least two columns');
    expect(() => parseCsv('a,b\n')).toThrow('no rows');
  });
});

describe('dates are decided over the whole column', () => {
  it('one survivor when any day exceeds 12', () => {
    expect(candidateDateFormats(['03/04/2026', '13/04/2026'])).toEqual(['DD/MM/YYYY']);
    expect(candidateDateFormats(['04/13/2026', '04/03/2026'])).toEqual(['MM/DD/YYYY']);
  });

  it('both survive when every day is 12 or less, and the draft asks instead of assuming', () => {
    expect(candidateDateFormats(['03/04/2026', '05/06/2026'])).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY']);
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('ambiguous-dates.csv'), decisions: {} });
    expect(draft.dateFormat).toEqual({ applied: null, candidates: ['MM/DD/YYYY', 'DD/MM/YYYY'] });
    expect(blockers(draft, { signConfirmed: true, account: { name: 'x' } })).toContain(
      'Choose how the dates are written — the file alone could not decide between day-first and month-first.',
    );
  });

  it('the user choice is applied: 03/04 is 4 March one way and 3 April the other', () => {
    const us = buildCsvDraft({ documentId: 'd', text: fixture('ambiguous-dates.csv'), decisions: { dateFormat: 'MM/DD/YYYY' } });
    const uk = buildCsvDraft({ documentId: 'd', text: fixture('ambiguous-dates.csv'), decisions: { dateFormat: 'DD/MM/YYYY' } });
    expect(us.accounts[0]!.transactions[0]!.date.value).toBe('2026-03-04');
    expect(uk.accounts[0]!.transactions[0]!.date.value).toBe('2026-04-03');
  });
});

describe('the sign convention (§3.4) — both directions, specific values', () => {
  it('detects a bank export where negative means spending, from the payroll rows', () => {
    const d = detectSignConvention(['-4.85', '3,250.00', '-82.17'], ['STARBUCKS', 'ACME CORP PAYROLL', 'WHOLE FOODS']);
    expect(d.detected).toBe('inverted');
    expect(d.confident).toBe(true);
  });

  it('converts a negative-is-spending checking export into Plaid convention', () => {
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('checking-negative-is-spending.csv'), decisions: {} });
    expect(draft.signConvention?.applied).toBe('inverted');
    expect(amounts(draft)).toEqual([
      ['STARBUCKS #4412', 485n],
      ['WHOLE FOODS MKT, AUSTIN', 8_217n],
      ['ACME CORP PAYROLL', -325_000n],
      ['ACME CORP PAYROLL', -325_000n],
      ['CITY POWER & LIGHT', 12_140n],
      ['AMAZON MKTPLACE REFUND', -1_599n],
      ['SHELL OIL 5521', 4_830n],
      ['RENT SEPT', 180_000n],
    ]);
    // The confirmation the user reads is a sentence, not jargon.
    expect(draft.signConvention?.samples).toEqual([
      { raw: 'STARBUCKS #4412  -4.85', sentence: '$4.85 spent at STARBUCKS #4412 on 2 September 2026' },
      { raw: 'ACME CORP PAYROLL  3,250.00', sentence: '$3,250.00 received from ACME CORP PAYROLL on 1 September 2026' },
    ]);
  });

  it('leaves a positive-is-spending card export as it is', () => {
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('card-positive-is-spending.csv'), decisions: {} });
    expect(draft.signConvention?.applied).toBe('plaid');
    expect(amounts(draft).slice(0, 4)).toEqual([
      ['COFFEE ROASTERS', 650n],
      ['GROCERY OUTLET', 5_420n],
      ['BOOKSHOP', 1_800n],
      ['PAYMENT THANK YOU', -50_000n],
    ]);
  });

  it('flipping the convention flips every amount, and the samples say so', () => {
    const flipped = buildCsvDraft({
      documentId: 'd',
      text: fixture('checking-negative-is-spending.csv'),
      decisions: { signConvention: 'plaid' },
    });
    expect(amounts(flipped)[0]).toEqual(['STARBUCKS #4412', -485n]);
    expect(flipped.signConvention?.samples[0]?.sentence).toBe('$3,250.00 spent at ACME CORP PAYROLL on 1 September 2026');
  });

  it('separate debit and credit columns state direction themselves', () => {
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('debit-credit-columns.csv'), decisions: {} });
    expect(draft.signConvention?.fromColumns).toBe(true);
    expect(draft.dateFormat?.applied).toBe('DD/MM/YYYY');
    expect(amounts(draft)).toEqual([
      ['CORNER SHOP', 1_240n],
      ['SALARY SEPT', -210_000n],
      ['TRAIN TICKET', 4_500n],
      ['PHONE BILL', 2_500n],
    ]);
    // Newest-first file: the final balance is the top row of the latest day.
    expect(draft.accounts[0]!.balance?.currentCents.value).toBe(231_760n);
    expect(draft.accounts[0]!.balance?.asOfDate.value).toBe('2026-09-30');
  });

  it('commit stays blocked until the direction is confirmed', () => {
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('card-positive-is-spending.csv'), decisions: { account: { name: 'Card' } } });
    expect(blockers(draft, { account: { name: 'Card' } })).toContain(
      'Confirm the examples read the right way round: money spent versus money received.',
    );
    expect(blockers(draft, { account: { name: 'Card' }, signConfirmed: true })).toEqual([]);
  });
});

describe('what the parser does not silently do', () => {
  it("does not adopt a bank's own category names (§10), and says so", () => {
    const { mapping } = inferColumns(
      ['Transaction Date', 'Description', 'Category', 'Amount'],
      [['09/02/2026', 'X', 'Food & Drink', '-1.00']],
    );
    expect(mapping.category).toBeUndefined();
    const draft = buildCsvDraft({ documentId: 'd', text: fixture('checking-negative-is-spending.csv'), decisions: {} });
    expect(draft.accounts[0]!.transactions.every((t) => t.categoryPrimary === null)).toBe(true);
    expect(draft.notes.some((n) => n.includes('UNCATEGORIZED'))).toBe(true);
    expect(draft.unparsed.map((u) => u.where)).toEqual([
      'Column "Post Date"',
      'Column "Category"',
      'Column "Type"',
      'Column "Memo"',
    ]);
  });

  it('a user edit is applied on the server, marked as theirs, sign from the direction word', () => {
    const draft = buildCsvDraft({
      documentId: 'd',
      text: fixture('card-positive-is-spending.csv'),
      decisions: { rowEdits: { '1': { amount: '7.25', direction: 'out' }, '2': { include: false } } },
    });
    const [first, second] = draft.accounts[0]!.transactions;
    expect(first!.amountCents).toEqual({ value: 725n, raw: '7.25', origin: 'user' });
    expect(second!.include).toBe(false);
  });

  it('a card balance shown negative is stored as the positive amount owed, with a note', () => {
    const text = 'Date,Description,Amount,Balance\n2026-09-02,COFFEE,6.50,-520.00\n2026-09-01,GROCERY,10.00,-513.50\n';
    const draft = buildCsvDraft({ documentId: 'd', text, decisions: { account: { name: 'Card', type: 'credit' } } });
    expect(draft.accounts[0]!.balance?.currentCents.value).toBe(52_000n);
    expect(draft.notes).toContain(
      'The balance column shows -520.00 for this card. It is read as $520.00 owed, since a debt is stored as the amount you owe.',
    );
  });
});
