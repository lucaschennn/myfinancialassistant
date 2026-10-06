/**
 * CSV text + the user's decisions → a draft (PHASE-2-INGESTION §3.3, §3.4).
 *
 * Pure and deterministic: the same bytes and the same decisions always give the
 * same draft. That is what lets the review screen re-derive on every change and
 * lets commit rebuild from scratch instead of trusting a stored copy.
 *
 * THE SIGN CONVENTION IS CONVERTED HERE AND NOWHERE ELSE. Every amount leaving
 * this file is in Plaid's convention (positive = money out); nothing downstream
 * of the draft knows a bank ever used another one.
 */

import { type Cents, LIABILITY_TYPES, type AccountType, formatCents, parseAmount } from '@pfg/core';
import type { Decisions, Draft, DraftAccount, DraftField, DraftTransaction } from '../draft.js';
import {
  type ColumnMapping,
  type DateFormat,
  type SignConvention,
  PLAID_PRIMARY_CATEGORIES,
  candidateDateFormats,
  detectSignConvention,
  inferColumns,
  parseDate,
} from './columns.js';
import { parseCsv } from './parse.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function spokenDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const parsed = <T>(value: T, raw: string): DraftField<T> => ({ value, raw, origin: 'parsed' });
const user = <T>(value: T, raw: string): DraftField<T> => ({ value, raw, origin: 'user' });

function unusedColumns(header: string[], mapping: ColumnMapping): number[] {
  const used = new Set(Object.values(mapping).filter((v): v is number => v !== undefined));
  return header.map((_, i) => i).filter((i) => !used.has(i));
}

export interface BuildCsvDraftInput {
  documentId: string;
  text: string;
  decisions: Decisions;
}

export function buildCsvDraft({ documentId, text, decisions }: BuildCsvDraftInput): Draft {
  const { header, rows } = parseCsv(text);
  const inferred = inferColumns(header, rows);
  const mapping: ColumnMapping = decisions.mapping ?? inferred.mapping;
  const unused = unusedColumns(header, mapping);
  const cell = (row: string[], role: keyof ColumnMapping): string => {
    const i = mapping[role];
    return i === undefined ? '' : (row[i] ?? '').trim();
  };

  const draft: Draft = {
    documentId,
    kind: 'csv',
    accounts: [],
    unparsed: [],
    discrepancies: [],
    dropped: [],
    notes: [],
    columns: { header, mapping, unused },
  };

  for (const i of unused) {
    const sample = rows.map((r) => (r[i] ?? '').trim()).find((v) => v !== '') ?? '';
    draft.unparsed.push({
      where: `Column "${header[i] ?? i + 1}"`,
      text: sample,
      reason: 'Not used. Assign it a role if it matters.',
    });
  }
  if (unused.some((i) => /categor/i.test(header[i] ?? ''))) {
    draft.notes.push(
      "This file has its own category names. They are not translated into the app's categories " +
        '(there is deliberately no mapping table), so these transactions are grouped as UNCATEGORIZED.',
    );
  }

  // --- dates: decided over the whole column -------------------------------
  const candidates = candidateDateFormats(rows.map((r) => cell(r, 'date')));
  let dateFormat: DateFormat | null = null;
  if (decisions.dateFormat) dateFormat = decisions.dateFormat;
  else if (candidates.length === 1) dateFormat = candidates[0]!;
  else if (candidates.length > 1) {
    // Several formats fit every value. ISO forms cannot be confused with the
    // others; anything else (day-first vs month-first) is the user's call.
    const iso = candidates.filter((c) => c === 'YYYY-MM-DD' || c === 'YYYY/MM/DD');
    dateFormat = iso.length === candidates.length ? iso[0]! : null;
  }
  draft.dateFormat = { applied: dateFormat, candidates };

  // --- direction -----------------------------------------------------------
  const split = mapping.amount === undefined && (mapping.debit !== undefined || mapping.credit !== undefined);
  let applied: SignConvention = 'plaid';
  if (split) {
    draft.signConvention = {
      detected: 'plaid',
      applied: 'plaid',
      evidence: 'The file has separate columns for money going out and money coming in.',
      confident: true,
      fromColumns: true,
      samples: [],
    };
  } else if (mapping.amount !== undefined) {
    const detection = detectSignConvention(
      rows.map((r) => cell(r, 'amount')),
      rows.map((r) => cell(r, 'description')),
    );
    applied = decisions.signConvention ?? detection.detected;
    draft.signConvention = { ...detection, applied, fromColumns: false, samples: [] };
  }

  // --- rows ------------------------------------------------------------------
  const transactions: DraftTransaction[] = [];
  rows.forEach((r, index) => {
    const rowNumber = index + 1;
    const edit = decisions.rowEdits?.[String(rowNumber)];
    const description = cell(r, 'description');
    const rawDate = cell(r, 'date');

    let amount: DraftField<Cents> | null = null;
    let rawAmountText = '';
    if (split) {
      const debit = cell(r, 'debit');
      const credit = cell(r, 'credit');
      rawAmountText = [debit && `out ${debit}`, credit && `in ${credit}`].filter(Boolean).join(' / ');
      const d = debit ? parseAmount(debit) : null;
      const c = credit ? parseAmount(credit) : null;
      const nonZero = (p: typeof d): boolean => p !== null && p.ok && p.cents !== 0n;
      if ((d && !d.ok) || (c && !c.ok) || (nonZero(d) && nonZero(c)) || (!nonZero(d) && !nonZero(c))) {
        if (!edit?.amount) {
          draft.unparsed.push({
            where: `Row ${rowNumber}`,
            text: `${description} ${rawAmountText}`.trim(),
            reason: 'Could not tell a single amount and direction from the debit and credit columns.',
          });
        }
      } else if (nonZero(d) && d!.ok) {
        const mag = d!.cents < 0n ? -d!.cents : d!.cents;
        amount = parsed(mag, debit);
      } else if (c && c.ok) {
        const mag = c.cents < 0n ? -c.cents : c.cents;
        amount = parsed(-mag, credit);
      }
    } else {
      rawAmountText = cell(r, 'amount');
      const p = parseAmount(rawAmountText);
      if (p.ok) {
        // The one conversion: into Plaid's convention, positive = money out.
        amount = parsed(applied === 'inverted' ? -p.cents : p.cents, rawAmountText);
      } else if (!edit?.amount) {
        draft.unparsed.push({
          where: `Row ${rowNumber}`,
          text: `${description} ${rawAmountText}`.trim(),
          reason: rawAmountText === '' ? 'No amount.' : p.reason,
        });
      }
    }

    // A user edit wins and is marked as theirs. Amounts arrive as a magnitude
    // plus a direction in words; the sign is applied here, on the server.
    if (edit?.amount) {
      const p = parseAmount(edit.amount);
      if (p.ok) {
        const mag = p.cents < 0n ? -p.cents : p.cents;
        const out = edit.direction !== 'in';
        amount = user(out ? mag : -mag, edit.amount);
      }
    }
    if (!amount) return;

    let date: DraftField<string>;
    if (edit?.date && parseDate(edit.date, 'YYYY-MM-DD')) {
      date = user(edit.date, edit.date);
    } else {
      const iso = dateFormat ? parseDate(rawDate, dateFormat) : null;
      date = parsed(iso ?? '', rawDate);
      if (dateFormat && !iso) {
        draft.unparsed.push({ where: `Row ${rowNumber}`, text: rawDate, reason: `Not a ${dateFormat} date.` });
        return;
      }
    }

    const name = edit?.name?.trim() ? user(edit.name.trim(), edit.name) : parsed(description || '(no description)', description);
    const categoryRaw = cell(r, 'category').toUpperCase();
    transactions.push({
      row: rowNumber,
      include: edit?.include ?? true,
      date,
      amountCents: amount,
      name,
      merchantName: cell(r, 'merchant') || null,
      categoryPrimary: PLAID_PRIMARY_CATEGORIES.has(categoryRaw) ? categoryRaw : null,
    });
  });

  // --- account ---------------------------------------------------------------
  const a = decisions.account ?? {};
  const type = a.type ?? 'depository';
  const account: DraftAccount = {
    ...(a.existingAccountId ? { existingAccountId: a.existingAccountId } : {}),
    name: a.name !== undefined ? user(a.name, a.name) : parsed('', ''),
    type: a.type !== undefined ? user(type, type) : parsed(type, ''),
    subtype: user(a.subtype?.trim() || null, a.subtype ?? ''),
    mask: user(a.mask?.trim() || null, a.mask ?? ''),
    institutionName: user(a.institutionName?.trim() || null, a.institutionName ?? ''),
    transactions,
    holdings: [],
  };

  // --- balance: the running balance on the most recent row ------------------
  const isLiability = LIABILITY_TYPES.has(type as AccountType);
  if (mapping.balance !== undefined && dateFormat && !decisions.balanceEdit?.remove) {
    const dated = rows
      .map((r, i) => ({ r, i, iso: parseDate(cell(r, 'date'), dateFormat!) }))
      .filter((x): x is { r: string[]; i: number; iso: string } => x.iso !== null && cell(x.r, 'balance') !== '');
    if (dated.length > 0) {
      const latest = dated.reduce((m, x) => (x.iso > m ? x.iso : m), dated[0]!.iso);
      const sameDay = dated.filter((x) => x.iso === latest);
      // Within the latest day, the file's own order says which balance is final:
      // newest-first exports put it at the top, oldest-first at the bottom.
      const first = dated[0]!.iso;
      const last = dated[dated.length - 1]!.iso;
      const pick = first >= last ? sameDay[0]! : sameDay[sameDay.length - 1]!;
      const raw = cell(pick.r, 'balance');
      const p = parseAmount(raw);
      if (p.ok) {
        let cents = p.cents;
        if (isLiability && cents < 0n) {
          cents = -cents;
          draft.notes.push(
            `The balance column shows ${raw} for this ${type === 'credit' ? 'card' : 'loan'}. ` +
              `It is read as ${formatCents(cents)} owed, since a debt is stored as the amount you owe.`,
          );
        }
        account.balance = { asOfDate: parsed(latest, cell(pick.r, 'date')), currentCents: parsed(cents, raw) };
      }
    }
  }
  if (decisions.balanceEdit && !decisions.balanceEdit.remove) {
    const e = decisions.balanceEdit;
    const p = e.amount ? parseAmount(e.amount) : null;
    const date = e.asOfDate && parseDate(e.asOfDate, 'YYYY-MM-DD') ? e.asOfDate : account.balance?.asOfDate.value;
    if (p?.ok && date) {
      account.balance = { asOfDate: user(date, e.asOfDate ?? date), currentCents: user(p.cents, e.amount!) };
    } else if (account.balance && date && e.asOfDate) {
      account.balance = { ...account.balance, asOfDate: user(date, e.asOfDate) };
    }
  }

  draft.accounts.push(account);

  // --- plain-language examples for the direction check -----------------------
  if (draft.signConvention) {
    const included = transactions.filter((t) => t.include && t.amountCents.origin === 'parsed');
    const out = included.find((t) => t.amountCents.value > 0n);
    const inn = included.find((t) => t.amountCents.value < 0n);
    for (const t of [out, inn]) {
      if (!t) continue;
      const mag = formatCents(t.amountCents.value < 0n ? -t.amountCents.value : t.amountCents.value);
      const when = t.date.value ? ` on ${spokenDate(t.date.value)}` : '';
      draft.signConvention.samples.push({
        raw: `${t.name.raw}  ${t.amountCents.raw}`.trim(),
        sentence:
          t.amountCents.value > 0n
            ? `${mag} spent at ${t.name.value}${when}`
            : `${mag} received from ${t.name.value}${when}`,
      });
    }
  }

  return draft;
}
