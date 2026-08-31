"use client";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { nodePhases } from "@/lib/stack/phases";
import type {
  ExecKind,
  PhaseRole,
  StackNodeInput,
  StackPhase,
} from "@/lib/stack/types";

const ROLES: Array<{ value: PhaseRole; label: string; hint: string }> = [
  { value: "install", label: "Install", hint: "Fetch dependencies" },
  { value: "build", label: "Build", hint: "Compile before running" },
  { value: "services", label: "Services", hint: "Bring infrastructure up" },
  { value: "run", label: "Run", hint: "Boot the app itself" },
  { value: "stop", label: "Stop", hint: "Tear down what was started" },
];

const EXECS: Array<{ value: ExecKind; label: string; hint: string }> = [
  { value: "host", label: "Host", hint: "A process on this machine" },
  { value: "compose", label: "Compose", hint: "A service Nexus generates" },
  {
    value: "compose-extern",
    label: "Repo compose",
    hint: "A compose file the repo owns",
  },
  { value: "container", label: "Container", hint: "A single image, no compose" },
];

/** Install and build prepare a checkout; they never run it. */
const HOST_ONLY_ROLES: PhaseRole[] = ["install", "build"];

type Props = {
  node: StackNodeInput;
  onChange: (patch: Partial<StackNodeInput>) => void;
};

/**
 * Edits a node's phases directly. The command fields above this panel stay the
 * quick path for the common node; this is what a mixed repo needs — one that
 * installs on the host, brings infra up in Docker, then runs the app.
 *
 * Phases are the source of truth on save, so an edit here wins over the fields
 * above: the server writes the command columns back from whatever is set here.
 */
export function StackPhaseEditor({ node, onChange }: Props) {
  // A node that has never been edited shows its derived phases, so the panel is
  // never blank and the first edit starts from what the node actually does.
  const phases = nodePhases(node);

  const commit = (next: StackPhase[]) => onChange({ phases: next });

  const patch = (index: number, changes: Partial<StackPhase>) =>
    commit(phases.map((p, i) => (i === index ? { ...p, ...changes } : p)));

  const remove = (index: number) =>
    commit(phases.filter((_, i) => i !== index));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= phases.length) return;
    const next = [...phases];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const add = () =>
    commit([
      ...phases,
      { role: "run", exec: "host", command: "", workdir: node.workdir ?? null },
    ]);

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm">Phases</Label>
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={add}>
          <Plus className="mr-1 h-3 w-3" />
          Add
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        The steps that make this node run, in order. Editing here overrides the
        command fields above.
      </p>

      {phases.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No phases yet — set a command above, or add one.
        </p>
      ) : null}

      {phases.map((phase, i) => {
        const hostOnly = HOST_ONLY_ROLES.includes(phase.role);
        return (
          <div
            key={i}
            className="space-y-1.5 rounded-md border border-border/40 bg-secondary/20 p-2"
          >
            <div className="flex items-center gap-1">
              <select
                aria-label="Phase role"
                className="h-7 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                value={phase.role}
                onChange={(e) => {
                  const role = e.target.value as PhaseRole;
                  patch(i, {
                    role,
                    // Install and build cannot be anything but host steps.
                    ...(HOST_ONLY_ROLES.includes(role)
                      ? { exec: "host" as ExecKind }
                      : {}),
                  });
                }}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value} title={r.hint}>
                    {r.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Phase execution"
                className="h-7 min-w-0 flex-1 rounded border bg-background px-1 text-[11px] disabled:opacity-50"
                value={phase.exec}
                disabled={hostOnly}
                title={
                  hostOnly
                    ? "Install and build prepare the checkout — they always run on the host"
                    : undefined
                }
                onChange={(e) =>
                  patch(i, { exec: e.target.value as ExecKind })
                }
              >
                {EXECS.map((x) => (
                  <option key={x.value} value={x.value} title={x.hint}>
                    {x.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                aria-label="Move phase up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                aria-label="Move phase down"
                disabled={i === phases.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                aria-label="Remove phase"
                onClick={() => remove(i)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>

            <Input
              className="h-8 font-mono text-xs"
              value={phase.command ?? ""}
              placeholder="command"
              aria-label="Phase command"
              onChange={(e) => patch(i, { command: e.target.value || null })}
            />

            {phase.exec !== "host" ? (
              <Input
                className="h-8 font-mono text-xs"
                value={phase.composePath ?? ""}
                placeholder="compose file (optional)"
                aria-label="Phase compose file"
                onChange={(e) =>
                  patch(i, { composePath: e.target.value || null })
                }
              />
            ) : null}

            {phase.provides?.length ? (
              <p className="text-[11px] text-muted-foreground">
                Starts: <span className="font-mono">{phase.provides.join(", ")}</span>
              </p>
            ) : null}

            {phase.role !== "stop" ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Exits after launching
                </span>
                <Switch
                  checked={!!phase.detached}
                  aria-label="Phase exits after launching"
                  onCheckedChange={(checked) =>
                    patch(i, { detached: checked || undefined })
                  }
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
