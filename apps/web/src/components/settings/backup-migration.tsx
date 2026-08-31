"use client";

/**
 * Backup & migration panel. Spec: `specs/18-config-export-import.md`.
 *
 * Two halves with deliberately different shapes:
 *
 * - **Export** is one click. The only decision that changes what leaves the
 *   machine is "include secrets", which reveals a passphrase field because a
 *   sealed file is the only form secrets are allowed to travel in.
 * - **Import** is never one click. Dropping a file runs a *dry run* and shows
 *   the plan; Apply is a second, separate action. `replace` adds a third gate,
 *   because it deletes rows the file does not carry.
 */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Download,
  FileJson,
  Loader2,
  Lock,
  Upload,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { NO_AUTOFILL } from "@/lib/utils";
import { getProjects } from "@/services/projects";
import {
  MIN_PASSPHRASE,
  commitImport,
  downloadExport,
  fileIsEncrypted,
  previewImport,
  type ImportMode,
  type ImportPlan,
} from "@/services/export";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Sum a plan's per-model counts into one create/update/delete triple. */
function totals(plan: ImportPlan) {
  let create = 0;
  let update = 0;
  let del = 0;
  for (const project of plan.projects) {
    for (const c of Object.values(project.counts)) {
      create += c.create;
      update += c.update;
      del += c.delete;
    }
  }
  return { create, update, delete: del };
}

export function BackupMigrationSection() {
  return (
    <div className="space-y-6">
      <ExportCard />
      <ImportCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportCard() {
  const { toast } = useToast();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [template, setTemplate] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  // Fetched lazily: the list only matters once "only selected" is on.
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: getProjects,
    enabled: onlySelected,
  });

  const secretsAllowed = !template;
  const passphraseTooShort =
    secretsAllowed && includeSecrets && passphrase.length < MIN_PASSPHRASE;
  const nothingSelected = onlySelected && selectedIds.size === 0;

  const toggleProject = (id: string, on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const run = async () => {
    setBusy(true);
    try {
      const filename = await downloadExport({
        scope: onlySelected
          ? { kind: "project", projectIds: [...selectedIds] }
          : { kind: "all" },
        template,
        includeSecrets: secretsAllowed && includeSecrets,
        includeConversations: !template && includeConversations,
        passphrase:
          secretsAllowed && includeSecrets ? passphrase : undefined,
      });
      toast({ title: "Export downloaded", description: filename });
      setPassphrase("");
    } catch (err) {
      toast({
        title: "Export failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export configuration
        </CardTitle>
        <CardDescription>
          Projects, repositories, the Stack canvas, sandbox settings, roadmap,
          agents and skills as one JSON file — for moving this install to
          another machine, or as a backup. Running sandboxes and search indexes
          are never included: they describe this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium">
              Only selected projects
            </Label>
            <p className="text-sm text-muted-foreground">
              Export a subset instead of the whole install — the file to send a
              teammate. Their import only touches the projects it carries.
            </p>
          </div>
          <Switch checked={onlySelected} onCheckedChange={setOnlySelected} />
        </div>

        {onlySelected && (
          <div className="space-y-2 rounded-lg border p-4">
            {projects === undefined ? (
              <p className="text-sm text-muted-foreground">Loading projects…</p>
            ) : projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">No projects yet.</p>
            ) : (
              projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm">{p.name}</span>
                  <Switch
                    checked={selectedIds.has(p.id)}
                    onCheckedChange={(on) => toggleProject(p.id, on)}
                  />
                </div>
              ))
            )}
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium">As template</Label>
            <p className="text-sm text-muted-foreground">
              Structure only: repositories, stack, sandbox settings, agents,
              skills and env var keys — without features, documents, schedules,
              conversations or secrets. For a teammate starting fresh.
            </p>
          </div>
          <Switch checked={template} onCheckedChange={setTemplate} />
        </div>

        {!template && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-base font-medium">Include secrets</Label>
            <p className="text-sm text-muted-foreground">
              Environment variable values, credential tokens and API keys.
              Without this they export as keys with empty values — the
              destination gets a checklist to fill in.
            </p>
          </div>
          <Switch checked={includeSecrets} onCheckedChange={setIncludeSecrets} />
        </div>
        )}

        {!template && includeSecrets && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-amber-600" />
              <Label htmlFor="export-passphrase" className="font-medium">
                Passphrase
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              The file is encrypted with this passphrase. There is no recovery —
              lose it and the export is unreadable.
            </p>
            <Input
              id="export-passphrase"
              type="password"
              autoComplete="new-password"
              {...NO_AUTOFILL}
              placeholder={`At least ${MIN_PASSPHRASE} characters`}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        )}

        {!template && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-base font-medium">
                Include conversations
              </Label>
              <p className="text-sm text-muted-foreground">
                Chat history and messages. Large, and closer to a log than
                configuration.
              </p>
            </div>
            <Switch
              checked={includeConversations}
              onCheckedChange={setIncludeConversations}
            />
          </div>
        )}

        <Button
          onClick={run}
          disabled={busy || passphraseTooShort || nothingSelected}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-1.5" />
          )}
          Download export
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ImportCard() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [filename, setFilename] = useState<string | null>(null);
  const [data, setData] = useState<unknown>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [pathRoot, setPathRoot] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const reset = () => {
    setFilename(null);
    setData(null);
    setEncrypted(false);
    setPassphrase("");
    setPlan(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    // The plan belongs to the previous file — drop it before anything else, or
    // a failed parse would leave a stale plan next to a new filename.
    setPlan(null);
    setPassphrase("");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setData(parsed);
      setFilename(file.name);
      setEncrypted(fileIsEncrypted(parsed));
    } catch {
      reset();
      toast({
        title: "Could not read that file",
        description: "It is not valid JSON.",
        variant: "destructive",
      });
    }
  };

  const preview = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const result = await previewImport({
        data,
        mode,
        pathRoot: pathRoot || undefined,
        passphrase: encrypted ? passphrase : undefined,
      });
      setPlan(result);
    } catch (err) {
      setPlan(null);
      toast({
        title: "Preview failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const result = await commitImport({
        data,
        mode,
        pathRoot: pathRoot || undefined,
        passphrase: encrypted ? passphrase : undefined,
      });
      setPlan(result);
      if (result.ok) {
        const t = totals(result);
        toast({
          title: "Import applied",
          description: `${result.projects.length} project(s) · ${t.create} created · ${t.update} updated${t.delete ? ` · ${t.delete} deleted` : ""}`,
        });
        // A full reload is the honest move: this rewrites projects, catalogs
        // and settings, so every cached query on the page is now suspect.
        setTimeout(() => window.location.reload(), 1200);
      } else {
        toast({
          title: "Import refused",
          description: result.errors[0] ?? "See the details below.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Import failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const needsPassphrase = encrypted && passphrase.length === 0;
  const canPreview = !!data && !busy && !needsPassphrase;
  const canApply = !!plan && plan.ok && !busy;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Import configuration
        </CardTitle>
        <CardDescription>
          Read a Nexus export written by this or another install. Nothing is
          written until you review the plan and apply it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="import-file">Export file</Label>
          <div className="flex items-center gap-3">
            <Input
              id="import-file"
              ref={fileInput}
              type="file"
              accept=".json,.enc,application/json"
              onChange={(e) => void onPick(e.target.files?.[0])}
              className="max-w-md"
            />
            {filename && (
              <Badge variant="secondary" className="gap-1.5">
                <FileJson className="h-3.5 w-3.5" />
                {filename}
              </Badge>
            )}
            {encrypted && (
              <Badge variant="outline" className="gap-1.5">
                <Lock className="h-3.5 w-3.5" />
                Encrypted
              </Badge>
            )}
          </div>
        </div>

        {encrypted && (
          <div className="space-y-2">
            <Label htmlFor="import-passphrase">Passphrase</Label>
            <Input
              id="import-passphrase"
              type="password"
              autoComplete="off"
              {...NO_AUTOFILL}
              placeholder="The passphrase this file was sealed with"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="max-w-md"
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="import-path-root">Workspace root on this machine</Label>
          <p className="text-sm text-muted-foreground">
            Where this machine keeps its project folders. Paths in the file are
            stored relative to the source machine&apos;s root and are rebased
            onto this one. Leave it blank to use this install&apos;s own
            workspace, which is the one directory it is guaranteed to be able to
            clone into.
          </p>
          <Input
            id="import-path-root"
            placeholder="This install's workspace"
            value={pathRoot}
            onChange={(e) => setPathRoot(e.target.value)}
            className="max-w-md font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-mode">Mode</Label>
          <Select
            value={mode}
            onValueChange={(v) => {
              setMode(v as ImportMode);
              // The plan is mode-specific — `replace` counts deletions that
              // `merge` does not. Showing the old one would understate it.
              setPlan(null);
            }}
          >
            <SelectTrigger id="import-mode" className="max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="merge">
                Merge — add and update, never delete
              </SelectItem>
              <SelectItem value="replace">
                Replace — make these projects match the file exactly
              </SelectItem>
            </SelectContent>
          </Select>
          {mode === "replace" && (
            <p className="text-sm text-amber-600 flex items-start gap-1.5">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              Rows the file does not carry will be deleted from the projects it
              contains. Sandboxes and search indexes are never touched.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={preview} disabled={!canPreview}>
            {busy && !plan ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Preview changes
          </Button>
          <Button
            onClick={() => {
              if (mode === "replace") setConfirmReplace(true);
              else void apply();
            }}
            disabled={!canApply}
          >
            {busy && plan ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Apply import
          </Button>
          {(filename || plan) && (
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Clear
            </Button>
          )}
        </div>

        {plan && <PlanReport plan={plan} />}
      </CardContent>

      <AlertDialog
        open={confirmReplace}
        onOpenChange={(open) => {
          if (!open) setConfirmReplace(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace these projects?</AlertDialogTitle>
            <AlertDialogDescription>
              {plan
                ? `${totals(plan).delete} row(s) not present in the file will be deleted across ${plan.projects.length} project(s), along with ${totals(plan).create} created and ${totals(plan).update} updated. This cannot be undone.`
                : "Rows not present in the file will be deleted. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReplace(false);
                void apply();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Plan report
// ---------------------------------------------------------------------------

function CountPills({
  counts,
}: {
  counts: { create: number; update: number; delete: number };
}) {
  return (
    <span className="flex gap-1.5 text-xs">
      {counts.create > 0 && (
        <span className="text-emerald-600">+{counts.create}</span>
      )}
      {counts.update > 0 && (
        <span className="text-muted-foreground">~{counts.update}</span>
      )}
      {counts.delete > 0 && (
        <span className="text-destructive">−{counts.delete}</span>
      )}
      {counts.create === 0 && counts.update === 0 && counts.delete === 0 && (
        <span className="text-muted-foreground">—</span>
      )}
    </span>
  );
}

function PlanReport({ plan }: { plan: ImportPlan }) {
  const t = totals(plan);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {plan.dryRun ? "Planned changes" : "Applied"}
          </span>
          <Badge variant={plan.ok ? "secondary" : "destructive"}>
            {plan.ok ? plan.mode : "refused"}
          </Badge>
        </div>
        <span className="text-sm text-muted-foreground">
          {t.create} created · {t.update} updated
          {t.delete > 0 ? ` · ${t.delete} deleted` : ""}
        </span>
      </div>

      {plan.errors.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3">
          {plan.errors.map((e) => (
            <p key={e} className="text-sm text-destructive flex gap-1.5">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {e}
            </p>
          ))}
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className="space-y-1">
          {plan.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-600 flex gap-1.5">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}

      {plan.projects.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Project</th>
                <th className="pb-2 pr-4 font-medium">Repos</th>
                <th className="pb-2 pr-4 font-medium">Stack</th>
                <th className="pb-2 pr-4 font-medium">Features</th>
                <th className="pb-2 pr-4 font-medium">Env vars</th>
                <th className="pb-2 font-medium">Schedules</th>
              </tr>
            </thead>
            <tbody>
              {plan.projects.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-2 pr-4">
                    <span className="font-medium">{p.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {p.action}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <CountPills counts={p.counts.repositories} />
                  </td>
                  <td className="py-2 pr-4">
                    <CountPills counts={p.counts.stackNodes} />
                  </td>
                  <td className="py-2 pr-4">
                    <CountPills counts={p.counts.features} />
                  </td>
                  <td className="py-2 pr-4">
                    <CountPills counts={p.counts.envVars} />
                  </td>
                  <td className="py-2">
                    <CountPills counts={p.counts.schedules} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* What the import cannot do for you — a checklist, not a failure. */}
      <div className="space-y-1.5 text-sm text-muted-foreground">
        {plan.credentials.needsSecret.length > 0 && (
          <p>
            <span className="font-medium text-foreground">
              {plan.credentials.needsSecret.length} credential(s) need their
              secret:
            </span>{" "}
            {plan.credentials.needsSecret.join(", ")} — add the values in
            Settings.
          </p>
        )}
        {plan.envVars.needsValue > 0 && (
          <p>
            <span className="font-medium text-foreground">
              {plan.envVars.needsValue} environment variable(s) arrive empty
            </span>{" "}
            — the keys are there, the values are not.
          </p>
        )}
        {plan.schedules.importedDisabled > 0 && (
          <p>
            <span className="font-medium text-foreground">
              {plan.schedules.importedDisabled} schedule(s) arrive disabled
            </span>{" "}
            — enable them here once you have turned them off on the source, or
            both installs will run the same tasks.
          </p>
        )}
        {plan.projects.some((p) => p.paths.some((x) => !x.existsOnDisk)) && (
          <p>
            Some project folders do not exist on this machine yet. That is fine
            for a configuration import — clone the repositories afterwards.
          </p>
        )}
      </div>
    </div>
  );
}
