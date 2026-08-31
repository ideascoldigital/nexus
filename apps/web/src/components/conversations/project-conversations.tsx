"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  MessageSquareCode,
  Bot,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getConversations,
  createConversation,
  type ConversationWithRelations,
} from "@/services/conversations";
import { getProjectAgents } from "@/services/skills";
import { getFeatures } from "@/services/features";
import type { Agent, Feature } from "@nexux/db";
import Link from "next/link";

const statusColors: Record<string, string> = {
  idle: "bg-muted-foreground/30",
  running: "bg-emerald-400 animate-pulse",
  paused: "bg-amber-400",
  completed: "bg-blue-400",
  error: "bg-red-400",
};

const SIDECAR_URL = "http://localhost:3001";

function StartConversationDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [featureId, setFeatureId] = useState<string>("");
  const [model, setModel] = useState("opus");

  const { data: agents = [] } = useQuery({
    queryKey: ["projectAgents", projectId],
    queryFn: () => getProjectAgents(projectId),
    enabled: open,
  });

  const { data: features = [] } = useQuery({
    queryKey: ["features", projectId],
    queryFn: () => getFeatures(projectId),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      // 1. Create conversation in DB
      const conv = await createConversation(projectId, {
        prompt,
        name: name.trim() || undefined,
        agentId: agentId || undefined,
        featureId: featureId || undefined,
        model,
      });

      // 2. Get workspace path (project-level) or fall back to main repo path
      const project = await fetch(`/api/projects/${projectId}`)
        .then((r) => r.json());

      const workingDirectory =
        project.workspacePath ||
        project.repositories?.find((r: { isMain: boolean }) => r.isMain)?.localPath ||
        project.repositories?.[0]?.localPath;

      if (workingDirectory) {
        await fetch(`${SIDECAR_URL}/process/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: conv.sessionId,
            workingDirectory,
            prompt: conv.prompt,
            model,
            permissionMode: "acceptEdits",
          }),
        }).catch((err) => {
          console.warn("[conversation] Sidecar not running:", err.message);
        });
      }

      return conv;
    },
    onSuccess: (conv) => {
      queryClient.invalidateQueries({
        queryKey: ["conversations", projectId],
      });
      setOpen(false);
      resetForm();
      router.push(`/projects/${projectId}/conversations/${conv.id}`);
    },
  });

  function resetForm() {
    setPrompt("");
    setName("");
    setAgentId("");
    setFeatureId("");
    setModel("opus");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) resetForm();
        setOpen(next);
      }}
    >
      <DialogTrigger
        nativeButton={true}
        render={
          <Button size="sm" className="gap-1.5">
            New Conversation
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim()) mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start Conversation</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Prompt */}
            <div className="grid gap-1.5">
              <Label className="text-xs">
                Prompt <span className="text-destructive">*</span>
              </Label>
              <Textarea
                placeholder="What should Claude work on? e.g. 'Implement user authentication with JWT tokens'"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="text-xs font-mono"
                required
              />
            </div>

            {/* Name */}
            <div className="grid gap-1.5">
              <Label className="text-xs">Name (optional)</Label>
              <Input
                placeholder="A short name for this conversation"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Agent */}
              <div className="grid gap-1.5">
                <Label className="text-xs">Agent</Label>
                <Select value={agentId} onValueChange={(v) => setAgentId(v ?? "")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {agents.map((agent: Agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full inline-block"
                            style={{ backgroundColor: agent.color }}
                          />
                          {agent.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Model */}
              <div className="grid gap-1.5">
                <Label className="text-xs">Model</Label>
                <Select value={model} onValueChange={(v) => setModel(v ?? "opus")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opus">Opus</SelectItem>
                    <SelectItem value="sonnet">Sonnet</SelectItem>
                    <SelectItem value="haiku">Haiku</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Link to feature */}
            {features.length > 0 && (
              <div className="grid gap-1.5">
                <Label className="text-xs">Link to Feature (optional)</Label>
                <Select value={featureId} onValueChange={(v) => setFeatureId(v ?? "")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {features.map((f: Feature & { _count?: { conversations: number } }) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {mutation.isError && (
            <p className="text-xs text-destructive pb-3">
              {mutation.error.message}
            </p>
          )}

          <DialogFooter>
            <Button
              type="submit"
              disabled={mutation.isPending || !prompt.trim()}
              className="gap-1.5"
            >
              {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mutation.isPending ? "Starting..." : "Start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConversationRow({ conv, projectId }: { conv: ConversationWithRelations; projectId: string }) {
  return (
    <Link href={`/projects/${projectId}/conversations/${conv.id}`}>
      <Card className="border-border/50 hover:border-border transition-colors cursor-pointer">
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  statusColors[conv.status] || statusColors.idle
                )}
              />
              <span className="text-xs font-medium truncate">
                {conv.name || conv.sessionId.slice(0, 12)}
              </span>
              {conv.agent && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                  <Bot
                    className="h-3 w-3"
                    style={{ color: conv.agent.color }}
                  />
                  {conv.agent.name}
                </span>
              )}
              {conv.feature && (
                <Badge
                  variant="outline"
                  className="text-[9px] h-4 shrink-0"
                >
                  {conv.feature.title}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground shrink-0">
              <span>{conv._count.messages} msgs</span>
              {conv.totalCostUsd > 0 && (
                <span>${conv.totalCostUsd.toFixed(3)}</span>
              )}
              <span>
                {formatDistanceToNow(new Date(conv.lastActivity), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function ProjectConversations({ projectId }: { projectId: string }) {
  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations", projectId],
    queryFn: () => getConversations(projectId),
  });

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {conversations?.length ?? 0} conversation
          {(conversations?.length ?? 0) !== 1 ? "s" : ""}
        </p>
        <StartConversationDialog projectId={projectId} />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-lg bg-muted/30 animate-pulse"
            />
          ))}
        </div>
      ) : conversations?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted mb-3">
            <MessageSquareCode className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            No conversations yet. Start one to begin working with Claude.
          </p>
          <StartConversationDialog projectId={projectId} />
        </div>
      ) : (
        <div className="space-y-1.5">
          {conversations?.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
