"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Renders an agent's markdown report.
 *
 * Memoised: parsing markdown is the expensive part, and these live inside
 * feeds whose parent re-renders on unrelated state (a composer's keystrokes,
 * a poll). Same string in, same output — nothing here depends on time.
 *
 * Elements are styled explicitly rather than with `prose`: the
 * @tailwindcss/typography plugin isn't installed in this app, so `prose`
 * classes are inert.
 *
 * GFM is on because agents write GitHub-flavoured markdown, not the CommonMark
 * subset: a bare merge-request URL is the single most useful thing in a report
 * and was rendering as dead text, and a comparison table came out as rows of
 * pipes. Both are parser features, not styling ones.
 */
export const MarkdownReport = memo(function MarkdownReport({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 text-xs leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-4 mb-2 text-sm font-semibold first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-4 mb-2 border-b border-border/40 pb-1 text-sm font-semibold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1.5 text-xs font-semibold first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-1.5 break-words text-muted-foreground">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-1 pl-4 text-muted-foreground marker:text-muted-foreground/60">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-1 pl-4 text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="break-words">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              // break-all, because an autolinked URL is one unbroken token: a
              // merge-request link is long enough to push the whole panel into
              // a horizontal scroll without it.
              className="break-all text-violet-300 underline underline-offset-2 hover:text-violet-200"
            >
              {children}
            </a>
          ),
          // GFM tables. The wrapper scrolls rather than the page: a wide table
          // in a narrow side panel is normal in these reports, and letting it
          // widen the container breaks every sibling.
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-border/60">{children}</thead>
          ),
          tr: ({ children }) => (
            <tr className="border-b border-border/30 last:border-0">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1 align-top">{children}</td>
          ),
          del: ({ children }) => (
            <del className="text-muted-foreground line-through">{children}</del>
          ),
          input: ({ checked, type }) =>
            // GFM task lists: rendered read-only, since a report is a record of
            // what happened, not a checklist to tick.
            type === "checkbox" ? (
              <input
                type="checkbox"
                checked={Boolean(checked)}
                readOnly
                className="mr-1.5 align-middle accent-primary"
              />
            ) : null,
          code: ({ className, children }) => {
            // Fenced blocks arrive with a language class; inline code doesn't.
            const isBlock = Boolean(className);
            if (isBlock) {
              return (
                <code className="font-mono text-[11px]">{children}</code>
              );
            }
            return (
              <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px] break-all text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-border/50 bg-muted/30 p-2 text-[11px] leading-snug">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border/40" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
