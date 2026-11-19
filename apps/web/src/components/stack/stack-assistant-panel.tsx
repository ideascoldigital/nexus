"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";

import { AssistantChat } from "@/components/assistant/assistant-panel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { AssistantEvent } from "@/services/assistant";
import { getStackAssistantState } from "@/services/stack";
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
  // Named, not counted: an arrow to the wrong service is the kind of mistake a
  // reviewer can only catch if they can see which one.
  if (s.dependsOn?.length) parts.push(`needs ${s.dependsOn.join(", ")}`);
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
};

/**
 * The Stack tab's assistant: the project's "stack" thread of the global
 * assistant (spec 30). Same conversation, tools and action cards as ⌘I —
 * plus the Stack assistant's instructions and its apply-to-canvas cards,
 * parsed out of each reply.
 */
export function StackAssistantPanel({ projectId, onApplySuggestion }: Props) {
  const { toast } = useToast();
  const [appliedKeys, setAppliedKeys] = useState<Set<string>>(new Set());
  const stateQuery = useQuery({
    queryKey: ["stack-assistant", projectId],
    queryFn: () => getStackAssistantState(projectId),
  });

  const handleApply = (key: string, s: StackSuggestion) => {
    if (onApplySuggestion(s)) {
      setAppliedKeys((prev) => new Set(prev).add(key));
      toast({ title: "Suggestion applied — review and Save" });
    }
  };

  const renderAssistant = (event: AssistantEvent) => {
    const { message, suggestions } = parseStackSuggestions(event.content.text);
    return (
      <div className="space-y-2">
        {message && (
          <div className="rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed prose dark:prose-invert prose-sm max-w-none [&_p]:my-1.5 [&_ul]:my-1.5 [&_pre]:my-1.5">
            <ReactMarkdown components={MARKDOWN_COMPONENTS}>{message}</ReactMarkdown>
          </div>
        )}
        {suggestions.map((sug, i) => {
          const key = `${event.id}:${i}`;
          return (
            <SuggestionCard
              key={key}
              suggestion={sug}
              applied={appliedKeys.has(key)}
              onApply={(x) => handleApply(key, x)}
            />
          );
        })}
      </div>
    );
  };

  return (
    // FloatingPanel owns the header and the close button.
    <div className="flex h-full w-full min-w-0 flex-col bg-card/40">
      {stateQuery.data && !stateQuery.data.indexStatus.indexed ? (
        <div className="border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          Search index not built — answers improve if you build it in the{" "}
          <Link href={`/projects/${projectId}?tab=search`} className="underline">
            Search tab
          </Link>
          .
        </div>
      ) : null}
      {stateQuery.isLoading || !stateQuery.data ? (
        <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          Loading...
        </div>
      ) : (
        <AssistantChat
          threadId={stateQuery.data.threadId}
          contextProjectId={projectId}
          renderAssistant={renderAssistant}
          placeholder="Ask about your stack… (Enter to send)"
          emptyState={
            <p className="px-4 pt-6 text-center text-sm text-muted-foreground">
              Ask how to run this project — I can read your repos, search the code, propose node configs you can
              apply to the canvas, and validate or repair the stack.
            </p>
          }
          starters={[
            "How do I run this project for development?",
            "Which services does this stack need?",
            "Set up the repos on the canvas for me",
          ]}
        />
      )}
    </div>
  );
}
