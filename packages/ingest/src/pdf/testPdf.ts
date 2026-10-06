/**
 * Test helper: write a minimal, valid PDF in memory — one page per entry, each
 * line drawn as real text, or no text at all to stand in for a scanned image.
 * Lets the extractor be tested against genuine PDF bytes without committing
 * binary fixtures (and without anything resembling a real statement on disk).
 */

const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(pages: Array<string[] | 'image-only'>): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objects.length + 1 + pages.length * 2; // reserved below
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream =
      page === 'image-only'
        ? // A filled rectangle: marks on the page, but no text layer.
          '0.8 g 72 72 468 648 re f'
        : ['BT /F1 11 Tf 14 TL 72 740 Td', ...page.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
