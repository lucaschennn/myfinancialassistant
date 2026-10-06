/**
 * The transcription call (§0.8, PHASE-2-INGESTION §4.1): extracted statement
 * text in, VERBATIM QUOTED STRINGS out.
 *
 * The model is a reader here, not a calculator. It is asked to copy figures
 * exactly as printed, with the page it read each one from — never a parsed
 * number, never cents, never a total it worked out, never a "fixed" typo. A
 * field it cannot find is reported absent, which is a legitimate answer.
 * `checkTranscription()` then verifies every quoted string actually occurs in
 * the text, and a deterministic function turns each one into cents.
 *
 * Structured outputs make the shape a constraint rather than a request, as the
 * router already does. The prompt and model are parameters with today's values
 * as defaults (the Phase 3 playground varies them); the extracted text itself
 * is sent nowhere but this one call (§9), and the trace records only the model
 * name and duration — never a page or a figure.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TraceRecorder } from '@pfg/core';

export interface Quoted {
  /** Exactly as printed. Empty string = not found. */
  raw: string;
  /** 1-based page the string was read from. 0 when absent. */
  page: number;
}

export type AccountKind =
  | 'checking'
  | 'savings'
  | 'credit_card'
  | 'loan'
  | 'mortgage'
  | 'brokerage'
  | 'retirement'
  | 'other'
  | 'unknown';

export interface PdfTranscription {
  institutionName: Quoted;
  accountName: Quoted;
  /** The account number as printed, usually masked ("XXXX4412"). Only its last digits are kept. */
  accountNumber: Quoted;
  /** A classification, not a figure. The user confirms it on review. */
  accountKind: AccountKind;
  /** The date the closing balance is as of. */
  statementDate: Quoted;
  openingBalance: Quoted;
  closingBalance: Quoted;
  /** Totals the statement itself prints. Compared against the rows by code, never reconciled. */
  totals: Array<{ kind: 'money_in' | 'money_out' | 'other'; label: string; raw: string; page: number }>;
  transactions: Array<{
    date: Quoted;
    description: Quoted;
    amount: Quoted;
    /** Which way the statement says the money moved: its column or heading, not a sign the model chose. */
    direction: 'in' | 'out' | 'unknown';
  }>;
  holdings: Array<{ name: Quoted; ticker: string; quantity: Quoted; value: Quoted }>;
  /** How many further accounts the statement covers, which are not transcribed. */
  otherAccountsOnStatement: number;
}

const QUOTED = {
  type: 'object',
  properties: {
    raw: { type: 'string', description: 'Exactly as printed, character for character. Empty string if not present.' },
    page: { type: 'integer', description: '1-based page the string appears on. 0 if not present.' },
  },
  required: ['raw', 'page'],
  additionalProperties: false,
} as const;

export const TRANSCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    institutionName: QUOTED,
    accountName: QUOTED,
    accountNumber: QUOTED,
    accountKind: {
      type: 'string',
      enum: ['checking', 'savings', 'credit_card', 'loan', 'mortgage', 'brokerage', 'retirement', 'other', 'unknown'],
    },
    statementDate: QUOTED,
    openingBalance: QUOTED,
    closingBalance: QUOTED,
    totals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['money_in', 'money_out', 'other'] },
          label: { type: 'string' },
          raw: { type: 'string' },
          page: { type: 'integer' },
        },
        required: ['kind', 'label', 'raw', 'page'],
        additionalProperties: false,
      },
    },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: QUOTED,
          description: QUOTED,
          amount: QUOTED,
          direction: { type: 'string', enum: ['in', 'out', 'unknown'] },
        },
        required: ['date', 'description', 'amount', 'direction'],
        additionalProperties: false,
      },
    },
    holdings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: QUOTED,
          ticker: { type: 'string', description: 'Ticker symbol as printed, or empty string.' },
          quantity: QUOTED,
          value: QUOTED,
        },
        required: ['name', 'ticker', 'quantity', 'value'],
        additionalProperties: false,
      },
    },
    otherAccountsOnStatement: { type: 'integer' },
  },
  required: [
    'institutionName',
    'accountName',
    'accountNumber',
    'accountKind',
    'statementDate',
    'openingBalance',
    'closingBalance',
    'totals',
    'transactions',
    'holdings',
    'otherAccountsOnStatement',
  ],
  additionalProperties: false,
} as const;

export const TRANSCRIPTION_SYSTEM_PROMPT = `You transcribe a bank, card, loan, or investment statement into structured fields. You are a careful copy typist, not an analyst.

## The rule

QUOTE, NEVER COMPUTE, NEVER TIDY. Every "raw" value must be copied exactly as it appears in the statement text: the same characters, the same currency symbol, the same commas, the same parentheses, minus signs, or CR/DR suffixes. Then give the page number you copied it from.

This means:
- Never add, subtract, or total anything. If the statement prints a total, quote it. If it does not, leave it out.
- Never convert a number into another format. "$1,234.56" stays "$1,234.56"; "(89.00)" stays "(89.00)"; "4,182.09 CR" stays "4,182.09 CR".
- Never fix what looks like a typo, and never fill in a value that is missing.
- If you cannot find a field, return an empty string for raw and 0 for page. That is a correct answer.

Every quoted string is checked against the statement text afterwards. Anything that does not appear there exactly is discarded.

## Fields

- institutionName, accountName: as printed.
- accountNumber: the account number as printed, which is usually masked (e.g. "XXXX4412"). Never a full unmasked number if the statement masks it.
- accountKind: your best classification of the account. "unknown" if unclear.
- statementDate: the single date the closing (ending) balance is as of — usually the end of the statement period. Quote just that one date as printed (e.g. "Aug 31, 2026"), not the whole period.
- openingBalance, closingBalance: the beginning and ending balance as printed.
- totals: totals the statement prints, such as total deposits ("money_in") and total withdrawals or purchases ("money_out").
- transactions: every transaction line, in statement order. date, description, and amount as printed. direction says which way the money moved according to the statement's own layout — the column or section the line sits in (Deposits vs Withdrawals, Payments vs Purchases), or an explicit sign or CR/DR. Use "unknown" when the statement does not say.
- holdings: for investment statements, each position's name, ticker (or ""), quantity, and market value as printed.
- otherAccountsOnStatement: if the statement covers more than one account, transcribe only the first and count the rest here.`;

export interface TranscriptionConfig {
  model: string;
  systemPrompt: string;
  maxTokens: number;
}

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  model: 'claude-sonnet-5',
  systemPrompt: TRANSCRIPTION_SYSTEM_PROMPT,
  maxTokens: 16_000,
};

export class TranscriptionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionFailedError';
  }
}

function pagesAsText(pages: string[]): string {
  return pages.map((p, i) => `=== Page ${i + 1} ===\n${p}`).join('\n\n');
}

/**
 * Make a transcriber. The returned function sends the pages to one model call
 * and returns the model's verbatim claims — unchecked. Checking is the guard's
 * job, done when the draft is built, so it can never be skipped by a caller.
 */
export function createTranscriber(
  options: { client?: Anthropic; config?: Partial<TranscriptionConfig>; trace?: TraceRecorder } = {},
): (pages: string[]) => Promise<PdfTranscription> {
  const config = { ...DEFAULT_TRANSCRIPTION_CONFIG, ...options.config };
  return async (pages) => {
    const client = options.client ?? new Anthropic();
    const call = () =>
      client.messages
        .stream({
          model: config.model,
          max_tokens: config.maxTokens,
          system: config.systemPrompt,
          output_config: { format: { type: 'json_schema', schema: TRANSCRIPTION_SCHEMA } },
          messages: [{ role: 'user', content: `Transcribe this statement.\n\n${pagesAsText(pages)}` }],
        } as Anthropic.MessageStreamParams)
        .finalMessage();

    // Disclosed by model name, page count and duration only (§0.2, §9).
    const message = options.trace
      ? await options.trace.track('anthropic', config.model, call, () => ({
          count: pages.length,
          detail: 'statement transcription (pages)',
        }))
      : await call();

    const block = message.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new TranscriptionFailedError('The transcription returned no text.');
    try {
      return JSON.parse(block.text) as PdfTranscription;
    } catch {
      throw new TranscriptionFailedError('The transcription was not valid JSON.');
    }
  };
}
