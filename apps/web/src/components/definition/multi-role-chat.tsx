"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Bot,
  User,
  Send,
  Loader2,
  AlertCircle,
  RotateCcw,
  Compass,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import {
  getDefinerState,
  initDefiner,
  sendDefinerMessage,
  type ChatMessage,
} from "@/services/definition";

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  triage: "Triage",
  "project-manager": "Project Manager",
  "finance-manager": "Finance",
  "technical-architect": "Architect",
  "product-ux": "Product/UX",
  detractor: "Detractor",
};

const ROLE_COLOR: Record<string, string> = {
  user: "bg-primary text-primary-foreground",
  triage: "bg-slate-500/15 text-slate-300",
  "project-manager": "bg-blue-500/15 text-blue-300",
  "finance-manager": "bg-emerald-500/15 text-emerald-300",
  "technical-architect": "bg-violet-500/15 text-violet-300",
  "product-ux": "bg-pink-500/15 text-pink-300",
  detractor: "bg-amber-500/15 text-amber-300",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${ROLE_COLOR[role] ?? ROLE_COLOR.triage}`}>
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

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
        customStyle={{ margin: 0, fontSize: 12, borderRadius: 6 }}
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

interface PersistedMessage {
  id: string;
  role: string;
  agentRole: string | null;
  content: string;
  messageType: string;
}

export function MultiRoleChat({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [triageNote, setTriageNote] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const state = useQuery({
    queryKey: ["definer-state", projectId],
    queryFn: () => getDefinerState(projectId),
  });

  const init = useMutation({
    mutationFn: () => initDefiner(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["definer-state", projectId] });
      queryClient.invalidateQueries({ queryKey: ["definer-document", projectId] });
      queryClient.invalidateQueries({ queryKey: ["definer-phases", projectId] });
    },
  });

  const needsInit = state.data?.initialized === false;
  useEffect(() => {
    if (needsInit && !init.isPending) {
      init.mutate();
    }
    // init is stable from useMutation; only re-run when needsInit flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsInit]);

  const send = useMutation({
    mutationFn: (message: string) => {
      const history: ChatMessage[] = (state.data?.conversation?.messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      return sendDefinerMessage(projectId, message, history);
    },
    onSuccess: (data) => {
      const lastTransfer = data.transfers?.[data.transfers.length - 1];
      const reason = lastTransfer?.reason ? ` — ${lastTransfer.reason}` : "";
      setTriageNote(`Routed to ${data.finalRole}${reason}`);
      queryClient.invalidateQueries({ queryKey: ["definer-state", projectId] });
      queryClient.invalidateQueries({ queryKey: ["definer-document", projectId] });
    },
  });

  useEffect(() => {
    // Scroll only the chat's own viewport: scrollIntoView would also scroll
    // every ancestor, yanking the whole Overview down on mount now that the
    // chat is embedded there.
    const viewport = bottomRef.current?.closest<HTMLElement>(
      "[data-radix-scroll-area-viewport], [data-slot=scroll-area-viewport]",
    );
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [state.data?.conversation?.messages?.length, send.isPending]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || send.isPending) return;
    setInput("");
    setTriageNote(null);
    send.mutate(trimmed);
  }

  const messages: PersistedMessage[] = (state.data?.conversation?.messages ?? []) as PersistedMessage[];

  return (
    <Card className="border-border/50 flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium">Definition Chat</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => init.mutate()}
          disabled={init.isPending}
        >
          <RotateCcw className="h-3 w-3 mr-1" /> Re-init
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0 px-3 py-2">
        {messages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-8">
            Ask the team anything to start. Try: <em>&quot;draft an overview for a
            B2B saas invoicing tool with budget under 50k&quot;</em>.
          </div>
        )}
        <div className="space-y-3">
          {messages.map((m) => {
            const role = m.agentRole ?? m.role;
            const isUser = role === "user";
            const isTriage = role === "triage";

            if (isTriage) {
              let parsed:
                | Array<{ from?: string; to?: string; reason?: string }>
                | null = null;
              try {
                parsed = JSON.parse(m.content);
              } catch {}
              const last = parsed?.[parsed.length - 1];
              return (
                <div
                  key={m.id}
                  className="text-[10px] text-muted-foreground border-l-2 border-slate-500/40 pl-2 italic"
                >
                  Triage →{" "}
                  {last?.to ?? "?"}
                  {last?.reason ? ` · ${last.reason}` : ""}
                </div>
              );
            }

            return (
              <div
                key={m.id}
                className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
              >
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback>
                    {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                  </AvatarFallback>
                </Avatar>
                <div className={`flex-1 min-w-0 ${isUser ? "items-end" : "items-start"}`}>
                  <div className={`mb-1 flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <RoleBadge role={role} />
                  </div>
                  <div
                    className={`rounded-lg px-3 py-2 text-xs ${
                      isUser
                        ? "bg-primary text-primary-foreground ml-auto inline-block"
                        : "bg-muted/40"
                    }`}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    ) : (
                      <div className="prose prose-sm prose-invert max-w-none text-xs">
                        <ReactMarkdown components={MARKDOWN_COMPONENTS}>
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {send.isPending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Triage routing…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {triageNote && !send.isPending && (
        <Alert className="m-2">
          <AlertDescription className="text-[11px]">{triageNote}</AlertDescription>
        </Alert>
      )}
      {send.isError && (
        <Alert variant="destructive" className="m-2">
          <AlertCircle className="h-3.5 w-3.5" />
          <AlertDescription className="text-[11px]">
            {(send.error as Error)?.message ?? "Chat error"}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="border-t border-border/50 p-2 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Talk to the specialists…"
          className="text-xs"
          disabled={send.isPending}
        />
        <Button type="submit" size="sm" disabled={send.isPending || !input.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </Card>
  );
}
