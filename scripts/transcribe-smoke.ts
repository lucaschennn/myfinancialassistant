/**
 * Live check of the PDF transcription path (§0.8) against the real model, on a
 * FICTIONAL statement generated in memory — no real document is involved.
 *
 *   npm run transcribe:smoke
 *
 * Prints what the model quoted, what the guard dropped, and the draft built
 * from what survived. One model call. Nothing is written anywhere.
 */

import { TraceRecorder, formatCents } from '@pfg/core';
import { loadEnv } from '@pfg/db';
import { buildPdfDraft, createTranscriber, extractPdfText } from '@pfg/ingest';
import { makePdf } from '../packages/ingest/src/pdf/testPdf.js';

loadEnv();

const pdf = makePdf([
  [
    'Hometown Credit Union',
    'Everyday Checking   Account number XXXX4412',
    'Statement period: Aug 1, 2026 - Aug 31, 2026',
    'Beginning balance   $3,200.00',
    'Ending balance      $4,475.45',
    'Total deposits      $3,250.00',
    'Total withdrawals   $1,974.55',
  ],
  [
    'Deposits and other credits',
    '08/01   ACME CORP PAYROLL            3,250.00',
    'Withdrawals and other debits',
    '08/03   STARBUCKS #4412                 4.85',
    '08/05   CITY POWER & LIGHT            121.40',
    '08/28   RENT AUGUST                 1,800.00',
    '08/30   SHELL OIL 5521                 48.30',
  ],
]);

const trace = new TraceRecorder();
const pages = await extractPdfText(pdf);
const transcription = await createTranscriber({ trace })(pages);
const draft = buildPdfDraft({ documentId: 'smoke', pages, transcription, decisions: {} });
const account = draft.accounts[0]!;

console.log('Model quoted:');
console.log(`  closing balance  ${JSON.stringify(transcription.closingBalance)}`);
console.log(`  statement date   ${JSON.stringify(transcription.statementDate)}`);
console.log(`  transactions     ${transcription.transactions.length}`);
console.log(`\nGuard dropped: ${draft.dropped.length === 0 ? 'nothing' : ''}`);
for (const d of draft.dropped) console.log(`  ${d.label}: ${d.raw} — ${d.reason}`);
console.log(`\nDraft: ${account.name.value} (${account.type.value}) ····${account.mask.value ?? ''}`);
if (account.balance) {
  console.log(`  balance ${formatCents(account.balance.currentCents.value)} as of ${account.balance.asOfDate.value}`);
}
for (const t of account.transactions) {
  console.log(`  ${t.date.value}  ${t.name.value.padEnd(22)} ${String(t.amountCents.value).padStart(8)} cents (${t.amountCents.value > 0n ? 'out' : 'in'})`);
}
console.log(`  discrepancies: ${draft.discrepancies.length}`);
for (const e of trace.build().entries) console.log(`\ntrace: [${e.scope}] ${e.label} ${e.durationMs}ms ${e.ok ? 'ok' : 'FAILED'}`);
