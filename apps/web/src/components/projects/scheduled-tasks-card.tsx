"use client";

// Scheduled agent tasks: cron or one-shot runs that launch an ephemeral
// sandbox, run the task (PR included) and destroy the sandbox afterwards.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CalendarClock,
  Loader2,
  Recycle,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getFeatures } from "@/services/features";
import {
  createSchedule,
  deleteSchedule,
  getSchedules,
  setScheduleEnabled,
  type TaskScheduleSummary,
} from "@/services/schedules";

const CRON_PRESETS = [
  { label: "Cada noche (02:00)", cron: "0 2 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Cada hora", cron: "0 * * * *" },
  { label: "Lunes 08:00", cron: "0 8 * * 1" },
];

function cadenceLabel(s: TaskScheduleSummary): string {
  if (s.cron) return `cron ${s.cron}`;
  if (s.runAt) return `una vez · ${new Date(s.runAt).toLocaleString()}`;
  return "—";
}

export function ScheduledTasksCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);

  // Form state
  const [featureId, setFeatureId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<"civo" | "aws" | "local">("local");
  const [ephemeral, setEphemeral] = useState(true);
  const [mode, setMode] = useState<"cron" | "once">("cron");
  const [cron, setCron] = useState("0 2 * * *");
  const [runAt, setRunAt] = useState("");

  const schedules = useQuery({
    queryKey: ["schedules", projectId],
    queryFn: () => getSchedules(projectId),
    refetchInterval: 30_000,
  });

  const features = useQuery({
    queryKey: ["features", projectId],
    queryFn: () => getFeatures(projectId),
    enabled: creating,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["schedules", projectId] });

  const createMutation = useMutation({
    mutationFn: () =>
      createSchedule(projectId, {
        featureId: featureId || undefined,
        prompt: prompt.trim() || undefined,
        provider,
        ephemeral,
        cron: mode === "cron" ? cron.trim() : undefined,
        runAt: mode === "once" && runAt ? new Date(runAt).toISOString() : undefined,
      }),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setFeatureId("");
      setPrompt("");
      toast({ title: "Schedule created" });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not create",
        description: err.message,
        variant: "destructive",
      }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setScheduleEnabled(projectId, id, enabled),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSchedule(projectId, id),
    onSuccess: invalidate,
  });

  const list = schedules.data ?? [];

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            Scheduled tasks
          </span>
          <Button
            size="sm"
            variant={creating ? "ghost" : "outline"}
            className="gap-1.5"
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "Cancel" : "New schedule"}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {creating && (
          <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Feature (or leave empty and use a prompt)</Label>
              <Select
                value={featureId || "none"}
                onValueChange={(v) => setFeatureId(v === "none" ? "" : (v ?? ""))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      value === "none" || !value
                        ? "No feature — free prompt"
                        : (features.data?.find((f) => f.id === value)?.title ??
                          String(value))
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No feature — free prompt</SelectItem>
                  {(features.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-prompt" className="text-xs">
                Prompt {featureId ? "(opcional — reemplaza el de la feature)" : ""}
              </Label>
              <Textarea
                id="schedule-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Actualiza las dependencias y abre un PR si los tests pasan."
                rows={2}
                className="text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">Cadencia</Label>
                <Select
                  value={mode}
                  onValueChange={(v) => v && setMode(v as "cron" | "once")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v) => (v === "cron" ? "Recurrente (cron)" : "Una vez")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">Recurrente (cron)</SelectItem>
                    <SelectItem value="once">Una vez</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Sandbox</Label>
                <Select
                  value={provider}
                  onValueChange={(v) =>
                    v && setProvider(v as "civo" | "aws" | "local")
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">local (Docker, gratis)</SelectItem>
                    <SelectItem value="civo">civo</SelectItem>
                    <SelectItem value="aws">aws</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {mode === "cron" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="schedule-cron" className="text-xs">
                  Cron expression
                </Label>
                <Input
                  id="schedule-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  className="h-8 font-mono text-xs"
                  placeholder="0 2 * * *"
                />
                <div className="flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.cron}
                      type="button"
                      onClick={() => setCron(p.cron)}
                      className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                        cron === p.cron
                          ? "border-primary text-primary"
                          : "border-border/60 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="schedule-runat" className="text-xs">
                  Fecha y hora
                </Label>
                <Input
                  id="schedule-runat"
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}

            <label className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs">
                <Recycle className="h-3.5 w-3.5 text-primary" />
                Ephemeral — destroy the sandbox when the task finishes
              </span>
              <Switch size="sm" checked={ephemeral} onCheckedChange={setEphemeral} />
            </label>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={
                  createMutation.isPending ||
                  (!featureId && !prompt.trim()) ||
                  (mode === "once" && !runAt)
                }
                className="gap-1.5"
              >
                {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Crear schedule
              </Button>
            </div>
          </div>
        )}

        {list.length === 0 && !creating && (
          <p className="text-xs text-muted-foreground">
            No schedules yet. Schedule a task and Nexus runs the whole
            cycle: launches the sandbox, runs Claude, opens the PR and
            destroys the sandbox.
          </p>
        )}

        {list.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
          >
            <Switch
              size="sm"
              checked={s.enabled}
              onCheckedChange={(v) =>
                toggleMutation.mutate({ id: s.id, enabled: v })
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {s.feature?.title ?? s.prompt?.slice(0, 60) ?? "—"}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {cadenceLabel(s)} · {s.provider}
                {s.ephemeral ? " · ephemeral" : ""}
                {s.enabled && s.nextRunAt
                  ? ` · next ${formatDistanceToNow(new Date(s.nextRunAt), { addSuffix: true })}`
                  : ""}
                {s.lastRunAt
                  ? ` · last ${formatDistanceToNow(new Date(s.lastRunAt), { addSuffix: true })}`
                  : ""}
              </p>
            </div>
            {s.ephemeral && (
              <Badge variant="outline" className="text-[9px] text-primary border-primary/30">
                <Recycle className="mr-1 h-2.5 w-2.5" />
                auto-destroy
              </Badge>
            )}
            <button
              type="button"
              onClick={() => deleteMutation.mutate(s.id)}
              className="p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
              title="Delete schedule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
