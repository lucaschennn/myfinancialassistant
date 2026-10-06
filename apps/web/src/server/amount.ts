/**
 * Amounts typed into a form arrive as STRINGS and become cents here, on the
 * server, through `parseAmount` — the one text-to-cents parser (§0.3). The
 * browser never turns an amount into a number.
 */

import { type Cents, ManualLedgerError, parseAmount } from '@pfg/core';

export function centsFromField(raw: string, label: string): Cents {
  const parsed = parseAmount(raw);
  if (!parsed.ok) {
    throw new ManualLedgerError(`${label}: enter an amount like 4182.09 or 4,182.09.`);
  }
  return parsed.cents;
}
