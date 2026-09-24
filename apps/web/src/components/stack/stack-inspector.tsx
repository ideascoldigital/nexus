"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mergeEnv, parseDotenv } from "@/lib/stack/dotenv";
import { columnsOf, phasesOf } from "@/lib/stack/phases";
import type {
  EnvVar,
  MakeTarget,
  PortMapping,
  StackNodeInput,
  VolumeMapping,
} from "@/lib/stack/types";
import { StackPhaseEditor } from "./stack-phase-editor";

function scriptCommand(
  pm: "pnpm" | "npm" | "yarn" | null,
  script: string
): string {
  if (pm === "pnpm") return `pnpm ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  return script === "start" ? "npm start" : `npm run ${script}`;
}

/** Tooltip telling the user what a `make` target hides. */
function makeTargetHint(target: MakeTarget | null): string | undefined {
  if (!target?.usesDocker) return undefined;
  const parts = [
    target.detached
      ? "starts containers and exits"
      : "runs docker in the foreground",
  ];
  if (target.composeServices.length) {
    parts.push(`services: ${target.composeServices.join(", ")}`);
  }
  if (target.composeFiles.length) {
    parts.push(`compose: ${target.composeFiles.join(", ")}`);
  }
  return `make ${target.name} — ${parts.join(" · ")}`;
}

type Props = {
  node: StackNodeInput;
  onChange: (patch: Partial<StackNodeInput>) => void;
  onDelete: () => void;
  onRedetect: () => void;
  detecting: boolean;
};

function KeyValueEditor<T extends Record<string, string | number>>({
  label,
  items,
  fields,
  placeholders,
  onChange,
  numeric = [],
  secret = false,
  headerExtra,
}: {
  label: string;
  items: T[];
  fields: [keyof T & string, keyof T & string];
  placeholders: [string, string];
  onChange: (items: T[]) => void;
  numeric?: string[];
  /** Mask the value column until revealed — for env vars and other secrets. */
  secret?: boolean;
  headerExtra?: ReactNode;
}) {
  // Reveal is per row, plus a "show all" that flips every row at once.
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const allRevealed = items.length > 0 && revealed.size >= items.length;
  const toggleRow = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleAll = () =>
    setRevealed(allRevealed ? new Set() : new Set(items.map((_, i) => i)));

  const update = (i: number, field: string, raw: string) => {
    const value = numeric.includes(field) ? Number(raw) || 0 : raw;
    onChange(
      items.map((item, idx) =>
        idx === i ? ({ ...item, [field]: value } as T) : item
      )
    );
  };
  const empty = Object.fromEntries(
    fields.map((f) => [f, numeric.includes(f) ? 0 : ""])
  ) as T;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Label className="min-w-0 text-sm">{label}</Label>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
          {secret && items.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={toggleAll}
              title={allRevealed ? "Hide all values" : "Show all values"}
              aria-label={allRevealed ? "Hide all values" : "Show all values"}
            >
              {allRevealed ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => onChange([...items, empty])}
            title={`Add ${label.toLowerCase()} entry`}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {items.map((item, i) => {
        const hidden = secret && !revealed.has(i);
        // min-w-0 everywhere: flex items default to min-width:auto, so a long
        // pasted value would otherwise stretch the row past the panel.
        return (
          <div key={i} className="flex min-w-0 items-center gap-1">
            <Input
              className="h-9 min-w-0 flex-1 text-sm font-mono"
              placeholder={placeholders[0]}
              value={String(item[fields[0]])}
              onChange={(e) => update(i, fields[0], e.target.value)}
            />
            <Input
              className="h-9 min-w-0 flex-1 text-sm font-mono"
              type={hidden ? "password" : "text"}
              placeholder={placeholders[1]}
              value={String(item[fields[1]])}
              onChange={(e) => update(i, fields[1], e.target.value)}
              title={hidden ? undefined : String(item[fields[1]])}
            />
            {secret ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 shrink-0"
                onClick={() => toggleRow(i)}
                title={hidden ? "Show value" : "Hide value"}
                aria-label={hidden ? "Show value" : "Hide value"}
              >
                {hidden ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 shrink-0"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Node fields a phase is derived from — editing one invalidates the phases. */
const PHASE_COLUMNS: Array<keyof StackNodeInput> = [
  "runMode",
  "installCommand",
  "buildCommand",
  "localCommand",
  "stopCommand",
  "managesServices",
  "workdir",
];

export function StackInspector({
  node,
  onChange: onChangeRaw,
  onDelete,
  onRedetect,
  detecting,
}: Props) {
  // Phases win on save, so a command field edited here has to re-derive them —
  // otherwise typing a new command would appear to work and then be discarded
  // in favour of the phases the node already had.
  const onChange = (patch: Partial<StackNodeInput>) => {
    if ("phases" in patch || !PHASE_COLUMNS.some((k) => k in patch)) {
      onChangeRaw(patch);
      return;
    }
    onChangeRaw({ ...patch, phases: phasesOf({ ...node, ...patch }) });
  };

  const detection = node.detection;
  const isRepo = node.kind === "repo";
  const [envImportOpen, setEnvImportOpen] = useState(false);
  const [envText, setEnvText] = useState("");
  const envFileRef = useRef<HTMLInputElement | null>(null);
  const parsedEnv = envText.trim() ? parseDotenv(envText) : [];

  const applyEnvImport = () => {
    if (parsedEnv.length) {
      onChange({ env: mergeEnv(node.env ?? [], parsedEnv) });
    }
    setEnvImportOpen(false);
    setEnvText("");
  };
  // What a `make` target actually does, once its recipe has been read.
  const makeTarget = (name: string) =>
    detection?.makeTargetDetails?.find((t) => t.name === name) ?? null;
  // Make targets that read like teardown — offered next to the stop command.
  // The parsed recipe decides when it is available; the name is the fallback
  // for detections scanned before recipes were read.
  const stopTargets = (detection?.makeTargets ?? []).filter(
    (t) => makeTarget(t)?.teardown ?? /(^|-)(down|stop|kill|clean)$/.test(t)
  );

  return (
    // No chrome of its own: FloatingPanel owns the header and the close
    // button, so this renders identically whether it floats or is docked.
    <div className="flex h-full w-full min-w-0 flex-col bg-card/40">
      <div className="border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {isRepo ? "Repository node" : "Service node"}
        </span>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-sm">Name</Label>
          <Input
            className="h-9 text-sm"
            value={node.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">Run mode</Label>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={node.runMode === "docker" ? "default" : "outline"}
              className="flex-1 h-8 text-sm"
              onClick={() => onChange({ runMode: "docker" })}
            >
              Docker
            </Button>
            <Button
              size="sm"
              variant={node.runMode === "local" ? "default" : "outline"}
              className="flex-1 h-8 text-sm"
              onClick={() => onChange({ runMode: "local" })}
              disabled={!isRepo}
            >
              Local
            </Button>
          </div>
          {node.runMode === "local" ? (
            <p className="text-xs text-muted-foreground">
              Runs directly on your machine, like the Terminal tab.
            </p>
          ) : null}
        </div>

        {node.runMode === "docker" ? (
          <>
            {!isRepo ? (
              <div className="space-y-1.5">
                <Label className="text-sm">Image</Label>
                <Input
                  className="h-9 text-sm font-mono"
                  value={node.image ?? ""}
                  placeholder="postgres:17"
                  onChange={(e) => onChange({ image: e.target.value || null })}
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label className="text-sm">Dockerfile</Label>
                  <Input
                    className="h-9 text-sm font-mono"
                    value={node.dockerfile ?? ""}
                    placeholder={detection?.dockerfilePath ?? "Dockerfile"}
                    onChange={(e) =>
                      onChange({ dockerfile: e.target.value || null })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">Build context (subdir)</Label>
                  <Input
                    className="h-9 text-sm font-mono"
                    value={node.buildContext ?? ""}
                    placeholder="."
                    onChange={(e) =>
                      onChange({ buildContext: e.target.value || null })
                    }
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label className="text-sm">Command override</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.command ?? ""}
                placeholder="(image default)"
                onChange={(e) => onChange({ command: e.target.value || null })}
              />
            </div>
          </>
        ) : (
          <>
            {/* Install/build live here too: sandboxes inherit all three, so
                the canvas is the one place a repo's commands are described. */}
            <div className="space-y-1.5">
              <Label className="text-sm">Install command</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.installCommand ?? ""}
                placeholder={detection?.suggestedCommands.install ?? "pnpm install"}
                onChange={(e) =>
                  onChange({ installCommand: e.target.value || null })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Build command</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.buildCommand ?? ""}
                placeholder={detection?.suggestedCommands.build ?? "pnpm build"}
                onChange={(e) =>
                  onChange({ buildCommand: e.target.value || null })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Command</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.localCommand ?? ""}
                placeholder={detection?.suggestedCommands.dev ?? "npm run dev"}
                onChange={(e) =>
                  onChange({ localCommand: e.target.value || null })
                }
              />
              {detection?.suggestedCommands.dev && !node.localCommand ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() =>
                    onChange({
                      localCommand: detection.suggestedCommands.dev,
                    })
                  }
                >
                  Use &quot;{detection.suggestedCommands.dev}&quot;
                </Button>
              ) : null}
            </div>
            <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <Label className="min-w-0 text-sm">Starts background services</Label>
                <Switch
                  checked={node.managesServices}
                  onCheckedChange={(checked) =>
                    onChange({ managesServices: checked })
                  }
                  aria-label="Command starts background services"
                  className="mt-0.5 shrink-0"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                For commands that launch containers or a daemon and then exit,
                like <span className="font-mono">make docker-up</span>. Liveness
                is read from what they started, not from the process, and Down
                uses the stop command below.
              </p>
              {node.managesServices && !node.stopCommand?.trim() ? (
                <p className="text-[11px] text-amber-400">
                  Without a stop command, Down cannot shut these services down.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Stop command (optional)</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.stopCommand ?? ""}
                placeholder="make docker-down"
                onChange={(e) =>
                  onChange({ stopCommand: e.target.value || null })
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Runs on Down. Needed when the command above only launches
                something (containers, a daemon) and exits — killing it would
                leave that running.
              </p>
              {stopTargets.length > 0 && !node.stopCommand ? (
                <div className="flex flex-wrap gap-1">
                  {stopTargets.map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs font-mono"
                      onClick={() => onChange({ stopCommand: `make ${t}` })}
                    >
                      make {t}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Working dir (subdir)</Label>
              <Input
                className="h-9 text-sm font-mono"
                value={node.workdir ?? ""}
                placeholder="."
                onChange={(e) => onChange({ workdir: e.target.value || null })}
              />
            </div>
          </>
        )}

        <Separator />

        {/* Edits phases directly, then mirrors them back into the command
            fields above so both halves of the panel keep showing the same node
            — the server does the same on save. */}
        <StackPhaseEditor
          node={node}
          onChange={(patch) =>
            onChangeRaw(
              patch.phases
                ? { ...patch, ...columnsOf(patch.phases) }
                : patch
            )
          }
        />

        <Separator />

        <KeyValueEditor<PortMapping>
          label="Ports (host → container)"
          items={node.ports ?? []}
          fields={["host", "container"]}
          placeholders={["3000", "3000"]}
          numeric={["host", "container"]}
          onChange={(ports) => onChange({ ports })}
        />

        <KeyValueEditor<EnvVar>
          label="Environment"
          items={node.env ?? []}
          fields={["key", "value"]}
          placeholders={["KEY", "value"]}
          onChange={(env) => onChange({ env })}
          secret
          headerExtra={
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => setEnvImportOpen(true)}
              title="Import a .env file"
              aria-label="Import a .env file"
            >
              <Upload className="h-3 w-3" />
            </Button>
          }
        />

        <KeyValueEditor<VolumeMapping>
          label="Volumes (host/named → container)"
          items={node.volumes ?? []}
          fields={["host", "container"]}
          placeholders={["pgdata", "/var/lib/..."]}
          onChange={(volumes) => onChange({ volumes })}
        />

        {isRepo ? (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <Label className="min-w-0 text-sm">Detection</Label>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 text-xs"
                  onClick={onRedetect}
                  disabled={detecting}
                >
                  {detecting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  Re-detect
                </Button>
              </div>
              {detection ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline" className="text-[11px]">
                      Dockerfile {detection.hasDockerfile ? "✓" : "✗"}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      Makefile {detection.hasMakefile ? "✓" : "✗"}
                    </Badge>
                    {detection.packageManager ? (
                      <Badge variant="outline" className="text-[11px]">
                        {detection.packageManager}
                      </Badge>
                    ) : null}
                  </div>
                  {Object.keys(detection.scripts).length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Scripts — click to use as command
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {Object.keys(detection.scripts).map((s) => (
                          <button
                            key={s}
                            type="button"
                            title={detection.scripts[s]}
                            className="text-[11px] font-mono px-1.5 py-0.5 rounded border bg-secondary/50 hover:border-primary/60"
                            onClick={() =>
                              onChange({
                                localCommand: scriptCommand(
                                  detection.packageManager,
                                  s
                                ),
                              })
                            }
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(detection.makeTargets ?? []).length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Make targets — click to use as command
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {(detection.makeTargets ?? []).map((t) => {
                          const target = makeTarget(t);
                          return (
                            <button
                              key={t}
                              type="button"
                              title={makeTargetHint(target)}
                              className="text-[11px] font-mono px-1.5 py-0.5 rounded border bg-secondary/50 hover:border-primary/60"
                              onClick={() =>
                                // A target that only launches containers is a
                                // service launcher, not the app's command —
                                // picking it should say so on the node too.
                                onChange({
                                  localCommand: `make ${t}`,
                                  ...(target?.usesDocker && target.detached
                                    ? { managesServices: true }
                                    : {}),
                                })
                              }
                            >
                              {target?.usesDocker ? "🐳 " : ""}
                              {t}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not scanned yet.
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="border-t p-3">
        <Button
          size="sm"
          variant="destructive"
          className="w-full h-8 text-sm"
          onClick={onDelete}
        >
          Remove from canvas
        </Button>
      </div>

      <Dialog open={envImportOpen} onOpenChange={setEnvImportOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import .env</DialogTitle>
            <DialogDescription>
              Pick a file or paste its contents. Existing keys are overwritten,
              new ones appended. Values stay hidden in the list until revealed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => envFileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              Choose .env file
            </Button>
            <input
              ref={envFileRef}
              type="file"
              // .env has no useful MIME type; accept anything and parse text.
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) setEnvText(await file.text());
              }}
            />
          </div>

          {/* field-sizing-content makes the base Textarea grow to fit, so a
              real .env would push the dialog off-screen — cap it and scroll. */}
          <Textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={"# or paste here\nAPI_URL=https://example.com\nAPI_KEY=\"secret value\""}
            className="max-h-64 min-h-40 resize-none overflow-y-auto font-mono text-xs break-all [field-sizing:fixed]"
          />

          <p className="break-all text-[11px] text-muted-foreground">
            {parsedEnv.length
              ? `${parsedEnv.length} variable${parsedEnv.length === 1 ? "" : "s"} detected: ${parsedEnv
                  .slice(0, 6)
                  .map((v) => v.key)
                  .join(", ")}${parsedEnv.length > 6 ? "…" : ""}`
              : "No variables detected yet."}
          </p>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEnvImportOpen(false);
                setEnvText("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={applyEnvImport} disabled={!parsedEnv.length}>
              Import {parsedEnv.length || ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
