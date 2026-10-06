/**
 * The transcription guard (§0.8, PHASE-2-INGESTION §4.2) — the sibling of
 * `checkAttribution()`.
 *
 * §0.1 forbids the model from DERIVING a figure. Reading one off a statement is
 * permitted, under a guard as strict: the model may only emit the verbatim
 * string it claims to have read, and that string must actually occur in the
 * document's own extracted text — on the page it names, when it names one.
 * Anything else is treated as invented, and the field is DROPPED from the draft.
 *
 * Only presentational whitespace is normalised, because PDF extraction inserts
 * it unpredictably. Currency symbols, thousands separators, parenthesised
 * negatives and CR/DR suffixes are compared exactly: those are precisely the
 * details a hallucination gets subtly wrong, and a matcher loose enough to
 * forgive them is a matcher that passes invented figures.
 *
 * A detector, like its sibling. It reports; the caller drops.
 */

import { parseAmount } from '@pfg/core';

export interface TranscriptionClaim {
  label: string;
  raw: string;
  /** 1-based page the model says it read this from. */
  page?: number;
  /** Amount claims must also parse as an amount; text claims (names, dates) need not. */
  kind?: 'amount' | 'text';
}

export interface TranscriptionViolation {
  label: string;
  raw: string;
  page?: number;
  reason: 'not-found-in-text' | 'not-on-claimed-page' | 'unparseable-amount' | 'empty';
}

export interface TranscriptionReport {
  ok: boolean;
  violations: TranscriptionViolation[];
}

/** Collapse runs of whitespace — the one thing PDF extraction gets arbitrarily wrong. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function checkTranscription(pages: string[], claims: TranscriptionClaim[]): TranscriptionReport {
  const squashed = pages.map(squash);
  const whole = squashed.join(' ');
  const violations: TranscriptionViolation[] = [];

  for (const claim of claims) {
    const needle = squash(claim.raw);
    const base = { label: claim.label, raw: claim.raw, ...(claim.page !== undefined ? { page: claim.page } : {}) };

    if (needle === '') {
      violations.push({ ...base, reason: 'empty' });
      continue;
    }
    if (!whole.includes(needle)) {
      violations.push({ ...base, reason: 'not-found-in-text' });
      continue;
    }
    if (claim.page !== undefined && !(squashed[claim.page - 1] ?? '').includes(needle)) {
      violations.push({ ...base, reason: 'not-on-claimed-page' });
      continue;
    }
    if (claim.kind === 'amount' && !parseAmount(claim.raw).ok) {
      violations.push({ ...base, reason: 'unparseable-amount' });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** The reason in words, for the review screen. */
export function describeViolation(v: TranscriptionViolation): string {
  switch (v.reason) {
    case 'not-found-in-text':
      return 'Not found anywhere in the statement text, so it was treated as invented and dropped.';
    case 'not-on-claimed-page':
      return `Not on page ${v.page}, where it was said to be, so it was dropped.`;
    case 'unparseable-amount':
      return 'Found in the statement, but not readable as an amount with certainty, so it was dropped.';
    case 'empty':
      return 'Nothing was read for this field.';
  }
}
