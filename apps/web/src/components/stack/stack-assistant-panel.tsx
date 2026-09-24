"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Bot,
  Loader2,
  Sparkles,
  User,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  getStackAssistantState,
  sendStackAssistantMessage,
} from "@/services/stack";
import { parseStackSuggestions } from "@/lib/stack/suggestions";
import type { StackSuggestion } from "@/lib/stack/types";

type CodeProps = {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

const MARKDOWN_COMPONENTS = {
  code({ inline, className, children, ...props }: CodeProps) {
    const match = /language-(\w+)/.exec(className || "");
    return !inline && match ? (
      <SyntaxHighlighter
        style={oneDark as { [key: string]: React.CSSProperties }}
        language={match[1]}
        PreTag="div"
        customStyle={{ margin: 0, fontSize: 13, borderRadius: 6 }}
        {...props}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export function describePatch(s: StackSuggestion): string {
  const parts: string[] = [];
  const p = s.patch ?? {};
  // A new repo node carries its name here; without this line a suggestion that
  // only creates a node (no patch fields) reads as "no changes".
  if (s.createNode) {
    parts.push(
      `new node ${s.createNode.name}${s.createNode.workdir ? ` (${s.createNode.workdir})` : ""}`,
    );
  }
  if (s.createService) {
    parts.push(
      `new service ${s.createService.name ?? s.createService.catalogKey ?? s.createService.image}`
    );
  }
  if (p.runMode) parts.push(`mode → ${p.runMode}`);
  if (p.localCommand) parts.push(`cmd → ${p.localCommand}`);
  if (p.command) parts.push(`command → ${p.command}`);
  if (p.image) parts.push(`image → ${p.image}`);
  if (p.dockerfile) parts.push(`dockerfile → ${p.dockerfile}`);
  if (p.ports?.length) {
    parts.push(`ports ${p.ports.map((x) => `${x.host}:${x.container}`).join(", ")}`);
  }
  if (p.env?.length) parts.push(`${p.env.length} env var(s)`);
  if (p.volumes?.length) parts.push(`${p.volumes.length} volume(s)`);
  return parts.join(" · ") || "no changes";
}

export function SuggestionCard({
  suggestion,
  onApply,
  applied,
}: {
  suggestion: StackSuggestion;
  onApply: (s: StackSuggestion) => void;
  applied: boolean;
}) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
        <span className="text-sm flex-1">{suggestion.reason}</span>
      </div>
      <div className="text-xs font-mono text-muted-foreground ml-5 break-all">
        {describePatch(suggestion)}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant={applied ? "outline" : "default"}
          className="h-7 text-xs"
          disabled={applied}
          onClick={() => onApply(suggestion)}
        >
          {applied ? (
            <>
              Applied
            </>
          ) : (
            "Apply to canvas"
          )}
        </Button>
      </div>
    </div>
  );
}

type Props = {
  projectId: string;
  onApplySuggestion: (s: StackSuggestion) => boolean;
  onClose: () => void;
};

export function StackAssistantPanel({
  projectId,
  onApplySuggestion,
  onClose,
}: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [appliedKeys, setAppliedKeys] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  const stateQuery = useQuery({
    queryKey: ["stack-assistant", projectId],
    queryFn: () => getStackAssistantState(projectId),
  });

  const send = useMutation({
    mutationFn: (message: string) => {
      const history = (stateQuery.data?.messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content:
            m.role === "assistant"
              ? parseStackSuggestions(m.content).message
              : m.content,
        }));
      return sendStackAssistantMessage(projectId, message, history);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stack-assistant", projectId] });
    },
    onError: (err: Error) =>
      toast({
        title: "Assistant error",
        description: err.message,
        variant: "destructive",
      }),
  });

  const messages = stateQuery.data?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, send.isPending]);

  const handleApply = (key: string, s: StackSuggestion) => {
    const ok = onApplySuggestion(s);
    if (ok) {
      setAppliedKeys((prev) => new Set(prev).add(key));
      toast({ title: "Suggestion applied — review and Save" });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || send.isPending) return;
    setInput("");
    send.mutate(msg);
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col border-l bg-card/40">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          <Bot className="h-4 w-4 text-primary" />
          Stack Assistant
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {stateQuery.data && !stateQuery.data.indexStatus.indexed ? (
        <div className="border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          Search index not built — answers improve if you build it in the{" "}
          <Link
            href={`/projects/${projectId}?tab=search`}
            className="underline"
          >
            Search tab
          </Link>
          .
        </div>
      ) : null}

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {stateQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              Loading...
            </div>
          ) : messages.length === 0 && !send.isPending ? (
            <div className="text-sm text-muted-foreground text-center py-8 px-4">
              Ask how to run this project — I can read your repos, search the
              code, and propose node configs you can apply to the canvas.
              <div className="mt-3 space-y-1">
                {[
                  "How do I run this project for development?",
                  "Which services does this stack need?",
                  "Set up the repos on the canvas for me",
                ].map((q) => (
                  <button
                    key={q}
                    className="block w-full rounded border px-2.5 py-1.5 text-left text-xs hover:border-primary/60"
                    onClick={() => send.mutate(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              if (m.role === "user") {
                return (
                  <div key={m.id} className="flex gap-2 justify-end">
                    <div className="max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap">
                      {m.content}
                    </div>
                    <User className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />
                  </div>
                );
              }
              const { message, suggestions } = parseStackSuggestions(m.content);
              return (
                <div key={m.id} className="flex gap-2">
                  <Bot className="h-4 w-4 mt-1 text-primary shrink-0" />
                  <div className="max-w-[85%] space-y-2 min-w-0">
                    <div className="rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed prose prose-invert prose-sm max-w-none [&_p]:my-1.5 [&_ul]:my-1.5 [&_pre]:my-1.5">
                      <ReactMarkdown components={MARKDOWN_COMPONENTS}>
                        {message}
                      </ReactMarkdown>
                    </div>
                    {suggestions.map((s, i) => {
                      const key = `${m.id}:${i}`;
                      return (
                        <SuggestionCard
                          key={key}
                          suggestion={s}
                          applied={appliedKeys.has(key)}
                          onApply={(sug) => handleApply(key, sug)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}

          {send.isPending ? (
            <div className="flex gap-2">
              <Bot className="h-4 w-4 mt-1 text-primary shrink-0" />
              <div className="rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Reading your project...
              </div>
            </div>
          ) : null}

          {send.data?.toolCalls?.length ? (
            <div className="flex flex-wrap gap-1 ml-6">
              {Array.from(new Set(send.data.toolCalls)).map((t) => (
                <Badge key={t} variant="outline" className="text-[11px] gap-1">
                  <Wrench className="h-2.5 w-2.5" />
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <form onSubmit={submit} className="border-t p-2 flex gap-1.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your stack..."
          className="h-9 text-sm"
          disabled={send.isPending}
        />
        <Button
          type="submit"
          size="sm"
          className="h-9 px-3"
          disabled={!input.trim() || send.isPending}
        >
          {send.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </Button>
      </form>
    </div>
  );
}
