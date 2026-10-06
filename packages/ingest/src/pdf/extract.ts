/**
 * PDF text-layer extraction (PHASE-2-INGESTION §3.5). Server-side only.
 *
 * A statement with no text layer is a scanned image, and it is REJECTED with
 * that reason — never OCR'd, and never handed to a model as a page image (§10).
 * Both would abandon the transcription guard: without extracted text there is
 * nothing to check a quoted figure against, and an invented balance would reach
 * review looking exactly like a real one.
 *
 * The extracted text is the most PII-dense string this process will ever hold.
 * It is request-scoped like a snapshot: returned to the caller, never logged,
 * never put in a trace entry, never stored (§9).
 */

import { extractText, getDocumentProxy } from 'unpdf';

/** Statements are a few pages. A very long document is not a statement, and would be a large model call. */
export const MAX_PDF_PAGES = 30;

export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextError';
  }
}

/** One string per page, in page order. */
export async function extractPdfText(bytes: Uint8Array): Promise<string[]> {
  let pages: string[];
  try {
    // pdfjs may take ownership of the buffer it is given, so it gets a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new PdfTextError(`This PDF has ${pdf.numPages} pages. Statements of up to ${MAX_PDF_PAGES} pages are supported.`);
    }
    const { text } = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(text) ? text : [text];
  } catch (error) {
    if (error instanceof PdfTextError) throw error;
    throw new PdfTextError('This PDF could not be opened. It may be damaged or password-protected.');
  }
  const characters = pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0);
  if (characters < 20) {
    throw new PdfTextError(
      'No text layer — this looks like a scanned image. Scanned statements are not read, because a ' +
        'figure guessed from pixels cannot be checked against anything. Download the statement as a ' +
        'regular PDF from your bank, or add the account by hand.',
    );
  }
  return pages;
}
