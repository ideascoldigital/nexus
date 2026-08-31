"use client";

// Setup checklist (design 1b): compact n/5 card on the Overview's right
// column. Repos → definition document → stack services → agent wiring →
// sandbox tokens, each with live state and a jump link. Hides itself at 5/5.

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDefinerState } from "@/services/definition";
import { getStack } from "@/services/stack";
import { getProjectOrchestration } from "@/services/projects";
import { getProjectSetup } from "@/services/sandbox";
import { cn } from "@/lib/utils";

const GIT_TOKEN_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN"];
const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

export function ProjectSetupChecklist({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (target: string) => void;
}) {
  // Steps flip from actions taken all over the app (recommender, wizards,
  // settings) — poll so the card never shows stale state.
  const REFRESH = { refetchInterval: 20_000 } as const;
  const definer = useQuery({
    queryKey: ["definer-state", projectId],
    queryFn: () => getDefinerState(projectId),
    ...REFRESH,
  });
  const stack = useQuery({
    queryKey: ["project-stack", projectId],
    queryFn: () => getStack(projectId),
    ...REFRESH,
  });
  const orchestration = useQuery({
    queryKey: ["project-orchestration", projectId],
    queryFn: () => getProjectOrchestration(projectId),
    ...REFRESH,
  });
  const setup = useQuery({
    queryKey: ["project-setup", projectId],
    queryFn: () => getProjectSetup(projectId),
    ...REFRESH,
  });

  if (
    definer.isLoading ||
    stack.isLoading ||
    orchestration.isLoading ||
    setup.isLoading
  ) {
    return null;
  }

  const repos = setup.data?.repositories ?? [];
  const phases = definer.data?.phases ?? [];
  const phasesDone = phases.filter((p) => p.status === "completed").length;
  // A defined stack (repo and/or services on the canvas) counts — plenty of
  // projects legitimately need zero infra services.
  const stackNodes = stack.data?.nodes.length ?? 0;
  // Wired = the project has its crew: agents AND skills attached (edges are
  // a bonus, not a requirement — the recommender attaches without drawing).
  const wired =
    ((orchestration.data?.agents ?? []).length > 0 &&
      (orchestration.data?.skills ?? []).length > 0) ||
    (orchestration.data?.edges ?? []).filter((e) => e.scope === "project")
      .length > 0;
  const envKeys = new Set(
    (setup.data?.envVars ?? [])
      .filter((v) => !v.repositoryId)
      .map((v) => v.key),
  );
  // Git token: saved git credential or project env var. Claude Code token:
  // saved claude credential (or legacy Settings row) or project env var —
  // mirrors the launch gate.
  const gitOk =
    (setup.data?.credentials ?? []).some((c) =>
      GIT_PROVIDERS.includes(c.provider),
    ) || GIT_TOKEN_KEYS.some((k) => envKeys.has(k));
  const claudeOk =
    (setup.data?.credentials ?? []).some((c) => c.provider === "claude") ||
    (setup.data?.readiness.hasClaudeCodeToken ?? false) ||
    envKeys.has("CLAUDE_CODE_OAUTH_TOKEN");
  const tokensOk = gitOk && claudeOk;

  const items = [
    {
      key: "repos",
      label: "Repos registrados",
      done: repos.length > 0,
      target: "repos",
    },
    {
      key: "definition",
      label: "Definition document",
      done: (definer.data?.initialized ?? false) && phasesDone > 0,
      target: "definition",
    },
    {
      key: "stack",
      label: "Stack definido",
      done: stackNodes > 0,
      target: "stack",
    },
    {
      key: "wiring",
      label: "Agents and skills wired",
      done: wired,
      target: "orchestration",
    },
    {
      key: "tokens",
      label: "Tokens de sandbox",
      done: tokensOk,
      target: "sandboxes",
    },
  ];
  const doneCount = items.filter((i) => i.done).length;

  if (doneCount === items.length) return null;

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Setup checklist
        </CardTitle>
        <div className="flex items-center gap-3 pt-1">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.round((doneCount / items.length) * 100)}%`,
                background:
                  "linear-gradient(90deg, oklch(0.6 0.13 300), oklch(0.8 0.15 300))",
              }}
            />
          </div>
          <span className="font-mono text-[11px] text-accent-foreground">
            {doneCount}/{items.length}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={item.done}
            onClick={() => onNavigate(item.target)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              item.done
                ? "text-muted-foreground/70"
                : "hover:bg-muted/40 text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                item.done
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-amber-400/60",
              )}
            >
              {item.done && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className={cn("flex-1", item.done && "line-through")}>
              {item.label}
            </span>
            {!item.done && (
              <span className="flex items-center gap-0.5 font-mono text-[10px] text-primary">
                ir
                <ArrowRight className="h-2.5 w-2.5" />
              </span>
            )}
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
