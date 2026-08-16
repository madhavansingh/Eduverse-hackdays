/**
 * QuestionRenderer — Renders question text with embedded Mermaid diagrams.
 *
 * Detects ```mermaid ... ``` blocks inside question strings and renders them
 * as interactive SVG diagrams using the MermaidDiagram component.
 * All other text is rendered as plain text (with basic line-break support).
 */

import { MermaidDiagram } from './MermaidDiagram';

interface QuestionRendererProps {
  text: string;
  className?: string;
}

interface TextSegment {
  type: 'text' | 'mermaid' | 'code';
  content: string;
  lang?: string;
}

function parseSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // Match fenced code blocks: ```lang\n...\n```
  const fenceRe = /```(\w*)\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    // Text before this block
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    const lang = match[1].toLowerCase().trim();
    const code = match[2];
    if (lang === 'mermaid') {
      segments.push({ type: 'mermaid', content: code });
    } else {
      segments.push({ type: 'code', content: code, lang: lang || 'text' });
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

export function QuestionRenderer({ text, className }: QuestionRendererProps) {
  const segments = parseSegments(text);

  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.type === 'mermaid') {
          return <MermaidDiagram key={i} code={seg.content} />;
        }
        if (seg.type === 'code') {
          return (
            <pre
              key={i}
              className="my-2 p-3 bg-muted rounded-lg text-sm font-mono overflow-x-auto border border-border"
            >
              <code>{seg.content}</code>
            </pre>
          );
        }
        // Plain text — render with line breaks preserved
        return (
          <span key={i} className="whitespace-pre-wrap">
            {seg.content}
          </span>
        );
      })}
    </div>
  );
}
