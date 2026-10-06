import { describe, expect, it } from 'vitest';
import { inspectUpload, UploadRejectedError } from '../upload.js';
import { PdfTextError, extractPdfText } from './extract.js';
import { makePdf } from './testPdf.js';

describe('extractPdfText', () => {
  it('reads the text layer page by page', async () => {
    const bytes = makePdf([
      ['Hometown Credit Union', 'Ending balance $4,475.45'],
      ['08/03 STARBUCKS #4412 4.85'],
    ]);
    const pages = await extractPdfText(bytes);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Ending balance $4,475.45');
    expect(pages[1]).toContain('STARBUCKS #4412');
  });

  it('rejects a page with no text layer as a scan, saying so — no OCR, no guessing', async () => {
    await expect(extractPdfText(makePdf(['image-only']))).rejects.toThrow(PdfTextError);
    await expect(extractPdfText(makePdf(['image-only']))).rejects.toThrow('No text layer — this looks like a scanned image');
  });

  it('rejects bytes that only claim to be a PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('%PDF-1.4 not really'))).rejects.toThrow('could not be opened');
  });
});

describe('inspectUpload sniffs content, not the name', () => {
  it('recognises a PDF by its magic bytes and hashes it', () => {
    const i = inspectUpload(makePdf([['x']]));
    expect(i.kind).toBe('pdf');
    expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats text as CSV, refuses spreadsheets and binaries with a reason', () => {
    expect(inspectUpload(new TextEncoder().encode('Date,Amount\n2026-01-01,1.00\n')).kind).toBe('csv');
    expect(() => inspectUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toThrow('Spreadsheet files are not supported');
    expect(() => inspectUpload(new Uint8Array([1, 0, 2, 3]))).toThrow(UploadRejectedError);
    expect(() => inspectUpload(new Uint8Array())).toThrow('empty');
  });

  it('the same bytes always hash the same — the duplicate guard', () => {
    const bytes = new TextEncoder().encode('Date,Amount\n2026-01-01,1.00\n');
    expect(inspectUpload(bytes).sha256).toBe(inspectUpload(bytes.slice()).sha256);
  });
});
