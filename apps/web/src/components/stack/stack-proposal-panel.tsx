"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { SuggestionCard } from "@/components/stack/stack-assistant-panel";
import type { StackSuggestion } from "@/lib/stack/types";

type Turn = {
  request: string;
  message: string;
  suggestions: StackSuggestion[];
  toolCalls: string[];
};

/** Openers, because a blank box is the hardest part of a chat like this. */
const EXAMPLES = [
  "postgres and a queue worker",
  "redis for caching",
  "a second service for the admin panel",
];

/**
 * Tell it what the project needs; it proposes the nodes.
 *
 * Distinct from the stack assistant beside it, which reads your repos and
 * describes what is *there*. This one is for what is not there yet — a worker
 * you have not written, a cache nobody mentions — so it proposes rather than
 * reports, and never asks a clarifying question first.
 *
 * Nothing here writes. A proposal becomes a change when the user taps Apply,
 * through the same path the assistant uses, so there is one place where an
 * agent's suggestion reaches the canvas and the user drives it.
 */
export function StackProposalPanel({
  projectId,
  onApplySuggestion,
}: {
  projectId: string;
  onApplySuggestion: (s: StackSuggestion) => boolean;
}) {
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [appliedKeys, setAppliedKeys] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  const propose = useMutation({
    mutationFn: async (request: string): Promise<Turn> => {
      const res = await fetch(`/api/projects/${projectId}/stack/propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request,
          // Prior turns as context, so "and a cache too" refers to something.
          history: turns.flatMap((t) => [
            { role: "user" as const, content: t.request },
            { role: "assistant" as const, content: t.message },
          ]),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not propose a stack");
      }
      return { request, ...(await res.json()) };
    },
    onSuccess: (turn) => {
      setTurns((prev) => [...prev, turn]);
      setInput("");
      requestAnimationFrame(() =>
        bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
      );
    },
    onError: (err: Error) =>
      toast({
        title: "Could not propose",
        description: err.message,
        variant: "destructive",
      }),
  });

  const submit = () => {
    const text = input.trim();
    if (text && !propose.isPending) propose.mutate(text);
  };

  return (
    // No header or border of its own: FloatingPanel owns the chrome, so this
    // renders the same whether it is floating or docked.
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-auto p-3">
        {turns.length === 0 && !propose.isPending ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Describe what this project needs to run. It reads your repos, then
              proposes nodes you can apply — including things the repos do not
              mention yet.
            </p>
            <div className="space-y-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => propose.mutate(example)}
                  className="block w-full rounded-md border border-border/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, ti) => (
          <div key={ti} className="space-y-2">
            <div className="ml-6 rounded-lg bg-primary/10 px-3 py-2 text-sm">
              {turn.request}
            </div>

            <p className="text-sm whitespace-pre-wrap">{turn.message}</p>

            {/* What it actually read, so "it says it checked" is checkable. */}
            {turn.toolCalls.length ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                read: {turn.toolCalls.join(" · ")}
              </p>
            ) : null}

            {turn.suggestions.map((s, si) => {
              const key = `${ti}-${si}`;
              return (
                <SuggestionCard
                  key={key}
                  suggestion={s}
                  applied={appliedKeys.has(key)}
                  onApply={(sug) => {
                    if (!onApplySuggestion(sug)) return;
                    setAppliedKeys((prev) => new Set(prev).add(key));
                    toast({ title: "Applied — review and Save" });
                  }}
                />
              );
            })}
          </div>
        ))}

        {propose.isPending ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the repos…
          </div>
        ) : null}

        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 p-2.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="postgres and a queue worker…"
          disabled={propose.isPending}
        />
        <Button
          size="icon"
          onClick={submit}
          disabled={!input.trim() || propose.isPending}
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
