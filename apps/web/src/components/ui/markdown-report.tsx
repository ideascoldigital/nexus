"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, Download, FileWarning } from "lucide-react";

import { CodeBlock } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { parseLocalFileLink } from "@/lib/local-file-link";
import { cn } from "@/lib/utils";

/** Files bots hand over are served by Nexus under this path (see lib/bot-files). */
const BOT_FILE = /^\/api\/bots\/[\w-]+\/files\//;

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** A paragraph made only of two or more images (line breaks and spaces allowed). */
export function isImageRow(node: HastNode | undefined): boolean {
  const kids = node?.children ?? [];
  let images = 0;
  for (const k of kids) {
    if (k.type === "element" && k.tagName === "img") images++;
    else if (k.type === "element" && k.tagName === "br") continue;
    else if (k.type === "text" && !k.value?.trim()) continue;
    else return false;
  }
  return images > 1;
}

/** Images on consecutive lines — even with blank lines between — become one paragraph, so one row. */
export function joinImageLines(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]]*\]\([^)]*\))[ \t]*\n(?:[ \t]*\n)+(?=[ \t]*!\[)/g,
    "$1\n",
  );
}

type ReportImage = { src: string; alt: string };

/** Full-size view of one image, with arrows (and ← →) through its siblings. */
export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: ReportImage[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const many = images.length > 1;
  const current = index === null ? null : images[index];
  const go = (step: number) => {
    if (index === null) return;
    onIndex((index + step + images.length) % images.length);
  };
  return (
    <Dialog
      open={current !== undefined && current !== null}
      onOpenChange={(o) => !o && onClose()}
    >
      <DialogContent
        className="max-h-[calc(100vh-4rem)] gap-2 p-3 sm:max-w-[min(1400px,calc(100vw-4rem))]"
        onKeyDown={(e) => {
          if (!many) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            go(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            go(-1);
          }
        }}
      >
        {current && (
          <>
            <DialogTitle className="flex items-center gap-2 truncate pr-8 text-[13px]">
              <span className="truncate">{current.alt || "Image"}</span>
              {many && (
                <span className="shrink-0 font-normal text-muted-foreground">
                  {index! + 1} / {images.length}
                </span>
              )}
            </DialogTitle>
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- full-size view */}
              <img
                key={current.src}
                src={current.src}
                alt={current.alt}
                className="max-h-[calc(100vh-9rem)] w-full animate-in rounded-md object-contain duration-200 fade-in"
              />
              {many && (
                <>
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    aria-label="Previous image"
                    className="absolute top-1/2 left-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-colors outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => go(1)}
                    aria-label="Next image"
                    className="absolute top-1/2 right-2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-colors outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <a
                href={current.src}
                download
                className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
              {many && (
                <div className="ml-auto flex gap-1.5">
                  {images.map((im, i) => (
                    <button
                      key={im.src}
                      type="button"
                      aria-label={`Image ${i + 1}`}
                      onClick={() => onIndex(i)}
                      className={cn(
                        "h-1.5 w-1.5 rounded-full transition-colors",
                        i === index
                          ? "bg-foreground"
                          : "bg-foreground/25 hover:bg-foreground/50",
                      )}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MissingImage({ alt }: { alt?: string }) {
  return (
    <span className="my-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground italic">
      <FileWarning className="h-3.5 w-3.5" />
      {alt || "Image"} (no longer available)
    </span>
  );
}

function Thumb({
  image,
  onOpen,
  className,
}: {
  image: ReportImage;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("block max-w-full cursor-zoom-in", className)}
      title={image.alt}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- served by Nexus, arbitrary size */}
      <img
        src={image.src}
        alt={image.alt}
        loading="lazy"
        className="max-h-96 max-w-full rounded-lg border border-border/50 object-contain"
      />
    </button>
  );
}

/** An image in a report: fits the bubble, opens full size on click. */
function ZoomableImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!src) return null;
  if (src === "#missing-file") return <MissingImage alt={alt} />;
  const image = { src, alt: alt ?? "" };
  return (
    <>
      <Thumb image={image} onOpen={() => setOpen(0)} className="my-2" />
      <ImageLightbox
        images={[image]}
        index={open}
        onIndex={setOpen}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

/** Several images in a row: thumbnails on one line, opened as a carousel. */
function ImageRow({ node }: { node: HastNode }) {
  const [open, setOpen] = useState<number | null>(null);
  const all = (node.children ?? [])
    .filter((k) => k.type === "element" && k.tagName === "img")
    .map((k) => ({
      src: String(k.properties?.src ?? ""),
      alt: String(k.properties?.alt ?? ""),
    }));
  const images = all.filter((im) => im.src && im.src !== "#missing-file");
  return (
    <div className="my-2 flex gap-2 overflow-x-auto pb-1">
      {all.map((im, i) =>
        !im.src || im.src === "#missing-file" ? (
          <MissingImage key={i} alt={im.alt} />
        ) : (
          <Thumb
            key={im.src}
            image={im}
            onOpen={() => setOpen(images.indexOf(im))}
            className="shrink-0 [&_img]:h-56 [&_img]:max-h-none [&_img]:w-auto"
          />
        ),
      )}
      <ImageLightbox
        images={images}
        index={open}
        onIndex={setOpen}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/** The text of a hast node and everything under it. */
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** A link to a file on this Mac: opens it in the editor (at its line), not as a page. */
function LocalFileAnchor({ href, children, className }: { href: string; children: React.ReactNode; className: string }) {
  const { toast } = useToast();
  const target = parseLocalFileLink(href)!;
  return (
    <a
      href={href}
      title={`Open ${target.path}${target.line ? `:${target.line}` : ""}`}
      className={className}
      onClick={async (e) => {
        e.preventDefault();
        let app: string | null = null;
        try {
          app = window.localStorage.getItem("nexux:project-opener");
        } catch {
          // no preference
        }
        const res = await fetch("/api/open-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...target, app }),
        }).catch(() => null);
        if (!res?.ok) {
          const body = res ? await res.json().catch(() => ({})) : {};
          toast({ title: "Could not open the file", description: body.error ?? "Nexus did not answer", variant: "destructive" });
        }
      }}
    >
      {children}
    </a>
  );
}

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
  variant = "report",
}: {
  children: string;
  className?: string;
  /** "chat": a reply in a conversation — body-size text in the foreground colour. */
  variant?: "report" | "chat";
}) {
  const chat = variant === "chat";
  const linkClass = "break-all text-violet-300 underline underline-offset-2 hover:text-violet-200";
  return (
    <div className={cn("min-w-0", chat ? "text-[13.5px] leading-[1.65] text-foreground/90" : "text-xs leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className={cn("mt-4 mb-2 font-semibold first:mt-0", chat ? "text-[16px] text-foreground" : "text-sm")}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className={cn(
                "mt-4 mb-2 font-semibold first:mt-0",
                chat ? "text-[15px] text-foreground" : "border-b border-border/40 pb-1 text-sm",
              )}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className={cn("mt-3 mb-1.5 font-semibold first:mt-0", chat ? "text-[14px] text-foreground" : "text-xs")}>
              {children}
            </h3>
          ),
          p: ({ node, children }) =>
            isImageRow(node) ? (
              // Several images in a row (a carousel, a set of screenshots):
              // one line of thumbnails, opened as a carousel with arrows.
              <ImageRow node={node as HastNode} />
            ) : (
              <p className={cn("break-words first:mt-0 last:mb-0", chat ? "my-2" : "my-1.5 text-muted-foreground")}>
                {children}
              </p>
            ),
          ul: ({ children }) => (
            <ul
              className={cn(
                "list-disc space-y-1 pl-5 marker:text-muted-foreground/60",
                chat ? "my-2" : "my-1.5 pl-4 text-muted-foreground",
              )}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={cn(
                "list-decimal space-y-1 pl-5 marker:text-muted-foreground",
                chat ? "my-2" : "my-1.5 pl-4 text-muted-foreground",
              )}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="break-words pl-0.5 [&>p]:my-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          img: ({ src, alt }) => (
            <ZoomableImage
              src={typeof src === "string" ? src : undefined}
              alt={alt}
            />
          ),
          a: ({ href, children }) =>
            href === "#mention" ? (
              // @Teammate, as in a chat app.
              <span className="rounded bg-sky-400/15 px-1 font-medium text-sky-300">
                {children}
              </span>
            ) : href === "#missing-file" ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground italic">
                <FileWarning className="h-3 w-3" />
                {children} (no longer available)
              </span>
            ) : href && BOT_FILE.test(href) ? (
              // A file a bot handed over: a download, not a page to visit.
              <a
                href={href}
                download
                className="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-foreground no-underline hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{children}</span>
              </a>
            ) : parseLocalFileLink(href) ? (
              // A path on this Mac (a file the chat read or changed): the editor.
              <LocalFileAnchor href={href!} className={linkClass}>
                {children}
              </LocalFileAnchor>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                // break-all, because an autolinked URL is one unbroken token: a
                // merge-request link is long enough to push the whole panel into
                // a horizontal scroll without it.
                className={linkClass}
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
          // Inline code only: a fenced block is drawn whole by `pre` below.
          code: ({ children }) => (
            <code
              className={cn(
                "rounded-md font-mono break-words text-foreground",
                chat ? "border border-border/60 bg-muted/60 px-1.5 py-px text-[12.5px]" : "bg-muted/60 px-1 py-0.5 text-[11px] break-all",
              )}
            >
              {children}
            </code>
          ),
          pre: ({ node }) => {
            const code = (node as HastNode | undefined)?.children?.find((c) => c.type === "element" && c.tagName === "code");
            const classes = code?.properties?.className;
            const lang = (Array.isArray(classes) ? classes : [classes])
              .map(String)
              .find((c) => c.startsWith("language-"))
              ?.slice("language-".length);
            return <CodeBlock code={hastText(code)} language={lang} />;
          },
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border/40" />,
        }}
      >
        {joinImageLines(children)}
      </ReactMarkdown>
    </div>
  );
});
