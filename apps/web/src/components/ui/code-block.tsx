"use client";

// A fenced code block in a reply: a small card with its language, a wrap
// toggle and copy, and the code highlighted. The highlighter loads its
// languages on demand, so a reply with no code costs nothing.

import { useState } from "react";
import { Check, Copy, FileCode2, SquareTerminal, WrapText } from "lucide-react";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import { cn } from "@/lib/utils";

function copyToClipboard(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

const SHELLS = new Set(["sh", "bash", "zsh", "shell", "console", "terminal", "fish", "powershell", "ps1"]);

/** Language names people write → the highlighter's. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  terminal: "bash",
  pine: "javascript", // Pine Script reads close enough to JS for colour
  pinescript: "javascript",
  md: "markdown",
  dockerfile: "docker",
};

export function CodeBlock({ code, language }: { code: string; language?: string | null }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const lang = (language ?? "").toLowerCase();
  const Icon = SHELLS.has(lang) ? SquareTerminal : FileCode2;
  const text = code.replace(/\n$/, "");
  const copy = () => {
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const button =
    "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  return (
    <div className="not-prose my-2.5 overflow-hidden rounded-xl border border-border/70 bg-[#1e2127]">
      <div className="flex items-center gap-1.5 border-b border-border/50 py-1 pr-1.5 pl-2.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-emerald-400/80" />
        <span className="flex-1 truncate font-mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          className={cn(button, wrap && "bg-accent text-foreground")}
          aria-label={wrap ? "Don't wrap lines" : "Wrap lines"}
          title={wrap ? "Don't wrap lines" : "Wrap lines"}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={copy} className={button} aria-label={copied ? "Copied" : "Copy code"} title={copied ? "Copied" : "Copy"}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {lang ? (
        <SyntaxHighlighter
          language={ALIASES[lang] ?? lang}
          style={oneDark}
          PreTag="div"
          wrapLongLines={wrap}
          customStyle={{
            margin: 0,
            padding: "10px 12px",
            background: "transparent",
            fontSize: "12px",
            lineHeight: 1.6,
            overflowX: wrap ? "hidden" : "auto",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono), ui-monospace, monospace", background: "transparent" } }}
        >
          {text}
        </SyntaxHighlighter>
      ) : (
        <pre
          className={cn(
            "px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground/90",
            wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
