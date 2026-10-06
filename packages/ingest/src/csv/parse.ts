/**
 * An RFC 4180 reader (PHASE-2-INGESTION §3.3): quoted fields, escaped quotes,
 * CRLF or LF, a leading byte-order mark. Nothing more — interpreting what the
 * columns mean is `columns.ts`'s job, and a spreadsheet-shaped library would be
 * a large dependency for a small, well-specified format (§2).
 */

export interface CsvTable {
  header: string[];
  rows: string[][];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Parse CSV text into rows of fields. Blank lines are dropped. */
export function parseCsvRows(text: string): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field !== '') throw new CsvParseError(`A quote appears inside an unquoted field on line ${rows.length + 1}.`);
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new CsvParseError('The file ends inside a quoted field.');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Parse with the first row as the header. Requires at least two columns and one data row. */
export function parseCsv(text: string): CsvTable {
  const all = parseCsvRows(text);
  const [header, ...rows] = all;
  if (!header || header.length < 2) {
    throw new CsvParseError('This does not look like a CSV export: it needs a header row with at least two columns.');
  }
  if (rows.length === 0) throw new CsvParseError('The file has a header but no rows.');
  return { header: header.map((h) => h.trim()), rows };
}
