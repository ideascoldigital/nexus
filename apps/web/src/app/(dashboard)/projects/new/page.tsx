"use client";

// Unified project creation flow: basics+repos → definition → stack →
// orchestrate (skills & agents) — one page, one pass. Each step reuses the
// full tab component so nothing is a stripped-down duplicate; the wizard just
// sequences them. Search indexing kicks off right after creation.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import type { Project, Repository } from "@nexux/db";
import {
  BookOpenText,
  Boxes,
  Check,
  FolderGit2,
  Loader2,
  Workflow,
} from "lucide-react";

import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectCreateForm } from "@/components/projects/project-create-form";
import { OrchestrationCanvas } from "@/components/projects/orchestration-canvas";
import { StackCanvas } from "@/components/stack/stack-canvas";
import { ProjectDefinition } from "@/components/definition/project-definition";
import { initDefiner, getDefinerState } from "@/services/definition";
import { runIndex } from "@/services/projects";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "project", title: "Project", icon: FolderGit2 },
  { key: "definition", title: "Definition", icon: BookOpenText },
  { key: "stack", title: "Stack", icon: Boxes },
  { key: "orchestrate", title: "Orchestrate", icon: Workflow },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export default function NewProjectPage() {
  const router = useRouter();
  const [step, setStep] = useState<StepKey>("project");
  const [project, setProject] = useState<
    (Project & { repositories: Repository[] }) | null
  >(null);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  const definerMutation = useMutation({
    mutationFn: async (projectId: string) => {
      await initDefiner(projectId);
      return getDefinerState(projectId);
    },
  });

  const handleCreated = (p: Project & { repositories: Repository[] }) => {
    setProject(p);
    setStep("definition");
    // Seed the definition workflow and warm the search index in the
    // background — both are idempotent and non-blocking.
    definerMutation.mutate(p.id);
    void runIndex(p.id, "incremental").catch(() => undefined);
  };

  const finish = () => {
    if (project) router.push(`/projects/${project.id}`);
  };

  return (
    <>
      <AppHeader title="New Project" />
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 space-y-6">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              render={<Link href="/projects" />}
            >
              Projects
            </Button>
            {project && (
              <Button variant="ghost" size="sm" onClick={finish}>
                Skip to project →
              </Button>
            )}
          </div>

          {/* Stepper */}
          <div className="flex items-center gap-2">
            {STEPS.map((s, i) => {
              const done = i < stepIndex;
              const active = s.key === step;
              const reachable = project !== null || i === 0;
              return (
                <div key={s.key} className="flex items-center gap-2 flex-1">
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => reachable && setStep(s.key)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : done
                          ? "border-border text-foreground hover:bg-muted/40"
                          : "border-border/50 text-muted-foreground",
                      !reachable && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    {done ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <s.icon className="h-3 w-3" />
                    )}
                    <span className="font-mono uppercase tracking-wide">
                      {i + 1}
                    </span>
                    {s.title}
                  </button>
                  {i < STEPS.length - 1 && (
                    <div className="h-px flex-1 bg-border/60" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Step 1 — basics + repositories */}
          {step === "project" && (
            <Card className="border-border/50 w-full max-w-3xl mx-auto">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Project & repositories
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ProjectCreateForm onCreated={handleCreated} />
              </CardContent>
            </Card>
          )}

          {/* Step 2 — definition workflow (the real thing, embedded) */}
          {step === "definition" && project && (
            <div className="space-y-3">
              {definerMutation.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Setting up the definition workflow…
                </p>
              )}
              {definerMutation.isError && (
                <p className="text-xs text-destructive">
                  Could not initialize the definition workflow:{" "}
                  {(definerMutation.error as Error).message}. You can retry
                  from the project&apos;s Overview later.
                </p>
              )}
              {definerMutation.isSuccess && (
                <>
                  <p className="text-xs text-muted-foreground max-w-3xl">
                    Describe what you&apos;re building in the chat — a
                    multi-role agent panel fills in the phased planning
                    document (discovery → requirements → architecture →
                    finance → risks → finalization). Continue whenever you
                    want; it stays available on the project&apos;s Overview.
                  </p>
                  <ProjectDefinition projectId={project.id} />
                </>
              )}
            </div>
          )}

          {/* Step 3 — stack canvas (full component) */}
          {step === "stack" && project && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground max-w-3xl">
                Define how this project runs: drag your repositories and the
                services they need (PostgreSQL, Redis, …). Services defined
                here run locally with <span className="font-medium">Run stack</span>{" "}
                and are provisioned automatically into every sandbox.
              </p>
              <StackCanvas projectId={project.id} />
            </div>
          )}

          {/* Step 4 — skills & agents via orchestration */}
          {step === "orchestrate" && project && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground max-w-3xl">
                Attach agents and skills by dragging them from the catalog, and
                connect an agent to a skill to grant it that capability.
              </p>
              <OrchestrationCanvas projectId={project.id} />
            </div>
          )}
        </div>
      </div>

      {/* Fixed footer — navigation stays visible however tall the step is. */}
      <div className="border-t border-border/40 bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          {project && stepIndex > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(STEPS[stepIndex - 1].key)}
            >
              Back
            </Button>
          )}
          {!project && (
            <p className="text-xs text-muted-foreground">
              Create the project to continue to Definition, Stack and
              Orchestrate.
            </p>
          )}
          <div className="ml-auto flex items-center gap-2">
            {project && step !== "orchestrate" && (
              <Button
                size="sm"
                onClick={() => setStep(STEPS[stepIndex + 1].key)}
                className="gap-1.5"
              >
                Continue to {STEPS[stepIndex + 1].title}
              </Button>
            )}
            {project && step === "orchestrate" && (
              <Button size="sm" onClick={finish} className="gap-1.5">
                Finish — open project
              </Button>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
