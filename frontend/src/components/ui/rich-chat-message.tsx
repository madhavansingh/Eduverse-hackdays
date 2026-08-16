import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import 'katex/dist/katex.min.css';
import { InlineMath, BlockMath } from 'react-katex';
import { Lightbulb, Sparkles } from 'lucide-react';
import type { Citation } from '@/services/chat';

interface RichChatMessageProps {
  content: string;
  citations?: Citation[];
  onCitationClick?: (citation: Citation, index: number) => void;
  isUser?: boolean;
}

function CitationBadge({
  index,
  onClick,
  sourceLabel,
}: {
  index: number;
  onClick: () => void;
  sourceLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold hover:bg-emerald-500/30 transition-colors cursor-pointer align-super mx-0.5"
      title={sourceLabel}
    >
      {index + 1}
    </button>
  );
}

// Helper to render text with LaTeX formulas ($...$ or $$...$$)
function ProcessedMathText({ text }: { text: string }) {
  if (!text) return null;

  // Split text by block math $$...$$ and inline math $...$
  const segments = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.startsWith('$$') && seg.endsWith('$$')) {
          const math = seg.slice(2, -2).trim();
          try {
            return (
              <div key={i} className="my-3 p-3 bg-muted/40 rounded-xl overflow-x-auto text-center border border-border/40 shadow-2xs">
                <BlockMath math={math} />
              </div>
            );
          } catch {
            return <code key={i} className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">{math}</code>;
          }
        }
        if (seg.startsWith('$') && seg.endsWith('$')) {
          const math = seg.slice(1, -1).trim();
          try {
            return <InlineMath key={i} math={math} />;
          } catch {
            return <code key={i} className="bg-muted px-1 rounded text-xs font-mono">{math}</code>;
          }
        }
        return <React.Fragment key={i}>{seg}</React.Fragment>;
      })}
    </>
  );
}

export function RichChatMessage({
  content,
  citations = [],
  onCitationClick,
  isUser = false,
}: RichChatMessageProps) {
  if (isUser) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed">{content}</div>;
  }

  // Pre-process citations in text
  const renderWithCitations = (text: string) => {
    if (!citations.length) return <ProcessedMathText text={text} />;

    const parts = text.split(/(\[\d+\])/g);
    return (
      <>
        {parts.map((part, i) => {
          const match = part.match(/^\[(\d+)\]$/);
          if (match) {
            const citIndex = parseInt(match[1], 10) - 1;
            const citation = citations[citIndex];
            if (citation && onCitationClick) {
              return (
                <CitationBadge
                  key={i}
                  index={citIndex}
                  onClick={() => onCitationClick(citation, citIndex)}
                  sourceLabel={`Source ${citIndex + 1}`}
                />
              );
            }
          }
          return <ProcessedMathText key={i} text={part} />;
        })}
      </>
    );
  };

  return (
    <div className="prose prose-slate dark:prose-invert max-w-none text-sm leading-relaxed space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold text-foreground mt-4 mb-2 pb-1 border-b border-border/50 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>{children}</span>
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-bold text-foreground mt-3 mb-2 flex items-center gap-2">
              <span className="w-1.5 h-4 bg-emerald-500 rounded-full" />
              <span>{children}</span>
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-foreground mt-2 mb-1">
              {children}
            </h3>
          ),
          p: ({ children }) => {
            const childrenString = typeof children === 'string' ? children : '';
            return (
              <p className="text-foreground/90 leading-relaxed mb-2">
                {typeof children === 'string' ? renderWithCitations(childrenString) : children}
              </p>
            );
          },
          ul: ({ children }) => (
            <ul className="space-y-1.5 my-2.5 pl-1 list-none">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="space-y-1.5 my-2.5 pl-4 list-decimal marker:text-emerald-500 marker:font-semibold">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="flex items-start gap-2 text-foreground/90">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-2 shrink-0" />
              <div className="flex-1">{children}</div>
            </li>
          ),
          blockquote: ({ children }) => (
            <div className="my-3 p-3.5 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/15 border-l-4 border-emerald-500 text-foreground/95 flex items-start gap-3 shadow-2xs">
              <Lightbulb className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-xs sm:text-sm leading-relaxed">{children}</div>
            </div>
          ),
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !String(children).includes('\n');
            if (isInline) {
              return (
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-emerald-600 dark:text-emerald-400 font-medium" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <div className="my-3 rounded-xl bg-zinc-950 text-zinc-100 overflow-hidden border border-zinc-800 shadow-md">
                {match && (
                  <div className="bg-zinc-900/90 px-3 py-1.5 text-[11px] font-mono text-zinc-400 border-b border-zinc-800 flex items-center justify-between">
                    <span>{match[1]}</span>
                  </div>
                )}
                <pre className="p-3 text-xs font-mono overflow-x-auto leading-relaxed">
                  <code>{children}</code>
                </pre>
              </div>
            );
          },
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground dark:text-emerald-300">
              {children}
            </strong>
          ),
          hr: () => <hr className="my-4 border-border/60" />,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs text-left text-foreground">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/70 text-foreground font-semibold border-b border-border">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border/40">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-muted/30 transition-colors">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-xs font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-xs">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
