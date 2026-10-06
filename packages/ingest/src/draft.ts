/**
 * The draft (PHASE-2-INGESTION §3.2): a PROPOSAL of what a document contains,
 * and the only thing `commit.ts` accepts.
 *
 * A draft is never edited directly. It is DERIVED: `build(stored bytes,
 * decisions)`, where the decisions are what the user chose on the review screen
 * — column mapping, date format, sign convention, which account, per-row edits.
 * Re-deriving on every change keeps parsing re-runnable against the original
 * bytes (the reason they are kept at all) and means there is no path by which a
 * hand-patched draft reaches the ledger.
 *
 * `raw` on every field is not redundancy. It is how the review screen shows what
 * the document actually said beside what we made of it, and what the
 * transcription guard checks against the extracted text (§4).
 */

import { type Cents, formatCents } from '@pfg/core';
import type { ColumnMapping, DateFormat, SignConvention } from './csv/columns.js';

export type FieldOrigin = 'parsed' | 'transcribed' | 'user';

export interface DraftField<T> {
  value: T;
  /** Exactly what the source said, before interpretation. */
  raw: string;
  origin: FieldOrigin;
  /** For a transcribed field: the page it was read from. */
  page?: number;
  confidence?: 'high' | 'low';
}

export interface DraftTransaction {
  /** Row number in the source (1-based, header excluded) — the stable key for edits. */
  row: number;
  include: boolean;
  date: DraftField<string>;
  /** Plaid's sign convention: positive = money out. Converted at the boundary (§3.4). */
  amountCents: DraftField<Cents>;
  name: DraftField<string>;
  merchantName: string | null;
  /** A Plaid primary category, or null (UNCATEGORIZED). Never a bank's own label (§10). */
  categoryPrimary: string | null;
}

export interface DraftHolding {
  securityName: DraftField<string>;
  tickerSymbol: string | null;
  securityType: string | null;
  quantity: DraftField<number>;
  valueCents: DraftField<Cents>;
  asOfDate: DraftField<string>;
}

export interface DraftAccount {
  /** Set when the user adds the rows to an account they already have. */
  existingAccountId?: string;
  name: DraftField<string>;
  type: DraftField<string>;
  subtype: DraftField<string | null>;
  mask: DraftField<string | null>;
  institutionName: DraftField<string | null>;
  balance?: { asOfDate: DraftField<string>; currentCents: DraftField<Cents> };
  transactions: DraftTransaction[];
  holdings: DraftHolding[];
}

export interface DroppedField {
  label: string;
  raw: string;
  page?: number;
  reason: string;
}

export interface Draft {
  documentId: string;
  kind: 'csv' | 'pdf';
  accounts: DraftAccount[];
  /** Columns, lines, or rows the parser could not interpret. Shown, never hidden. */
  unparsed: Array<{ where: string; text: string; reason: string }>;
  /** Stated totals that disagree with the sum of parts (§4.4). Never auto-resolved. */
  discrepancies: Array<{ label: string; statedRaw: string; statedCents: Cents; computedCents: Cents; page?: number }>;
  /** Fields the transcription guard rejected (§4.2): dropped, and shown with their reason. */
  dropped: DroppedField[];
  /** Plain-language notes about interpretation choices the user should see. */
  notes: string[];
  /** CSV only: the detected sign convention and examples to confirm it with (§3.4). */
  signConvention?: {
    detected: SignConvention;
    applied: SignConvention;
    evidence: string;
    confident: boolean;
    /** True when the file states direction itself (separate debit and credit columns). */
    fromColumns: boolean;
    samples: Array<{ raw: string; sentence: string }>;
  };
  /** CSV only: date format, and the candidates when the column alone could not decide. */
  dateFormat?: { applied: DateFormat | null; candidates: DateFormat[] };
  /** CSV only: the column roles in use, with header names, for the mapping control. */
  columns?: { header: string[]; mapping: ColumnMapping; unused: number[] };
}

/**
 * What the user decided on the review screen. JSON-safe and all strings: the
 * browser never turns an amount into a number (§0.3) — edited amounts arrive
 * here as text and go through `parseAmount` on the server like every other.
 */
export interface Decisions {
  mapping?: ColumnMapping;
  dateFormat?: DateFormat;
  signConvention?: SignConvention;
  /** The user has read the plain-language examples and agrees with the direction. */
  signConfirmed?: boolean;
  account?: {
    existingAccountId?: string;
    name?: string;
    type?: string;
    subtype?: string;
    mask?: string;
    institutionName?: string;
  };
  /**
   * Per-row overrides keyed by source row number. An edited amount is a
   * magnitude plus a direction in words, so nobody types a sign convention.
   */
  rowEdits?: Record<string, { include?: boolean; date?: string; amount?: string; direction?: 'in' | 'out'; name?: string }>;
  balanceEdit?: { asOfDate?: string; amount?: string; remove?: boolean };
  discrepanciesAcknowledged?: boolean;
}

/** What `documents.draft_json` holds: the decisions, plus anything not re-derivable. */
export interface StoredDraft {
  decisions: Decisions;
  /**
   * PDF only: the transcription model's claims, kept because re-deriving them
   * would cost another model call and could differ. Strings only — the model
   * never emits a number (§0.8).
   */
  transcription?: unknown;
}

// ---------------------------------------------------------------------------
// Commit readiness
// ---------------------------------------------------------------------------

/** Why a draft cannot be committed yet, in words for the review screen. Empty = ready. */
export function blockers(draft: Draft, decisions: Decisions): string[] {
  const out: string[] = [];
  if (draft.kind === 'csv') {
    const m = draft.columns?.mapping;
    if (m && (m.date === undefined || (m.amount === undefined && m.debit === undefined && m.credit === undefined))) {
      out.push('Tell us which column holds the date and which holds the amount.');
    }
    if (draft.dateFormat && draft.dateFormat.applied === null) {
      out.push('Choose how the dates are written — the file alone could not decide between day-first and month-first.');
    }
    if (draft.signConvention && !decisions.signConfirmed) {
      out.push('Confirm the examples read the right way round: money spent versus money received.');
    }
  }
  if (draft.discrepancies.length > 0 && !decisions.discrepanciesAcknowledged) {
    out.push('Acknowledge the totals that do not add up. They are not fixed for you.');
  }
  const account = draft.accounts[0];
  if (!account || (!account.existingAccountId && account.name.value.trim() === '')) {
    out.push('Name the account these rows belong to, or choose one you already have.');
  }
  if (draft.accounts.every((a) => a.transactions.every((t) => !t.include) && !a.balance && a.holdings.length === 0)) {
    out.push('Nothing is selected to import.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// View model — strings only, for the browser
// ---------------------------------------------------------------------------

export interface FieldView {
  raw: string;
  shown: string;
  origin: FieldOrigin;
  page?: number;
  confidence?: 'high' | 'low';
}

const money = (f: DraftField<Cents>): FieldView => ({
  raw: f.raw,
  shown: formatCents(f.value),
  origin: f.origin,
  ...(f.page !== undefined ? { page: f.page } : {}),
  ...(f.confidence ? { confidence: f.confidence } : {}),
});
const text = <T extends string | number | null>(f: DraftField<T>): FieldView => ({
  raw: f.raw,
  shown: f.value === null ? '—' : String(f.value),
  origin: f.origin,
  ...(f.page !== undefined ? { page: f.page } : {}),
  ...(f.confidence ? { confidence: f.confidence } : {}),
});

/** Turn a draft into the review screen's view: every figure as its raw text and the server's reading of it. */
export function draftView(draft: Draft, decisions: Decisions) {
  return {
    documentId: draft.documentId,
    kind: draft.kind,
    blockers: blockers(draft, decisions),
    decisions,
    notes: draft.notes,
    unparsed: draft.unparsed,
    dropped: draft.dropped,
    discrepancies: draft.discrepancies.map((d) => ({
      label: d.label,
      statedRaw: d.statedRaw,
      stated: formatCents(d.statedCents),
      computed: formatCents(d.computedCents),
      ...(d.page !== undefined ? { page: d.page } : {}),
    })),
    signConvention: draft.signConvention ?? null,
    dateFormat: draft.dateFormat ?? null,
    columns: draft.columns ?? null,
    accounts: draft.accounts.map((a) => ({
      existingAccountId: a.existingAccountId ?? null,
      name: text(a.name),
      type: text(a.type),
      subtype: text(a.subtype),
      mask: text(a.mask),
      institutionName: text(a.institutionName),
      balance: a.balance ? { asOfDate: text(a.balance.asOfDate), current: money(a.balance.currentCents) } : null,
      transactions: a.transactions.map((t) => ({
        row: t.row,
        include: t.include,
        date: text(t.date),
        amount: money(t.amountCents),
        // The direction in words, so nobody has to remember Plaid's convention.
        direction: t.amountCents.value > 0n ? 'out' : t.amountCents.value < 0n ? 'in' : 'zero',
        magnitude: formatCents(t.amountCents.value < 0n ? -t.amountCents.value : t.amountCents.value),
        name: text(t.name),
        category: t.categoryPrimary,
      })),
      holdings: a.holdings.map((h) => ({
        security: text(h.securityName),
        ticker: h.tickerSymbol,
        type: h.securityType,
        quantity: text(h.quantity),
        value: money(h.valueCents),
        asOfDate: text(h.asOfDate),
      })),
    })),
  };
}

export type DraftView = ReturnType<typeof draftView>;
