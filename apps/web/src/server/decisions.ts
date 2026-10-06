/**
 * The review screen's decisions, validated at the door. Every amount is a
 * string (§0.3) — the server's `parseAmount` is the only thing that reads one.
 */

import { DATE_FORMATS, type Decisions } from '@pfg/ingest';
import { z } from 'zod';

const amount = z.string().trim().max(32);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const columnIndex = z.number().int().min(0).max(200);

export const DecisionsSchema = z
  .object({
    mapping: z
      .object({
        date: columnIndex,
        description: columnIndex,
        amount: columnIndex,
        debit: columnIndex,
        credit: columnIndex,
        balance: columnIndex,
        category: columnIndex,
        merchant: columnIndex,
      })
      .partial()
      .optional(),
    dateFormat: z.enum(DATE_FORMATS).optional(),
    signConvention: z.enum(['plaid', 'inverted']).optional(),
    signConfirmed: z.boolean().optional(),
    account: z
      .object({
        existingAccountId: z.string().max(60),
        name: z.string().max(120),
        type: z.string().max(20),
        subtype: z.string().max(60),
        mask: z.string().max(4),
        institutionName: z.string().max(120),
      })
      .partial()
      .optional(),
    rowEdits: z
      .record(
        z.string().regex(/^\d{1,6}$/),
        z
          .object({ include: z.boolean(), date: isoDate, amount, direction: z.enum(['in', 'out']), name: z.string().max(200) })
          .partial(),
      )
      .optional(),
    balanceEdit: z.object({ asOfDate: isoDate, amount, remove: z.boolean() }).partial().optional(),
    discrepanciesAcknowledged: z.boolean().optional(),
  })
  .strict();

export function parseDecisions(body: unknown): Decisions | null {
  const parsed = DecisionsSchema.safeParse(body);
  return parsed.success ? (parsed.data as Decisions) : null;
}
