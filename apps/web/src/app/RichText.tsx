/**
 * Renders the parsed Markdown subset as React elements.
 *
 * Every string ends up as a text child, never as HTML — see the note in
 * `markdown.ts` on why that matters when the text is model output built from
 * third-party merchant names.
 *
 * Named `RichText` rather than `Markdown` because the parser next to it is
 * `markdown.ts`, and on a case-insensitive filesystem two modules differing
 * only in capitalisation resolve to each other.
 */

import { type Block, type Span, parseBlocks } from './markdown';

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.type) {
          case 'bold':
            return <strong key={i}>{span.value}</strong>;
          case 'italic':
            return <em key={i}>{span.value}</em>;
          case 'code':
            return <code key={i}>{span.value}</code>;
          default:
            return <span key={i}>{span.value}</span>;
        }
      })}
    </>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h4';
      return (
        <Tag className="md-heading">
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case 'bullets':
      return (
        <ul className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case 'numbered':
      return (
        <ol className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      );
    default:
      return (
        <p>
          <Spans spans={block.spans} />
        </p>
      );
  }
}

export function RichText({ children }: { children: string }) {
  return (
    <>
      {parseBlocks(children).map((block, i) => (
        <BlockNode block={block} key={i} />
      ))}
    </>
  );
}
