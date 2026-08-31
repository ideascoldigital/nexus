"use client";

// Export just this project — the "send it to a teammate" path. Same engine as
// Settings → Backup & Migration (services/export), scoped to one project, with
// the template switch front and center: a template carries the structure
// (repos, stack, sandbox config, agents/skills, env var keys) and none of the
// work product or secrets.

import { useState } from "react";

import { Download, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { downloadExport, MIN_PASSPHRASE } from "@/services/export";

export function ExportProjectDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const passphraseTooShort =
    includeSecrets && passphrase.length < MIN_PASSPHRASE;

  const run = async () => {
    setBusy(true);
    try {
      const filename = await downloadExport({
        scope: { kind: "project", projectIds: [projectId] },
        template,
        includeSecrets: template ? false : includeSecrets,
        includeConversations: template ? false : includeConversations,
        passphrase: !template && includeSecrets ? passphrase : undefined,
      });
      toast({ title: "Export downloaded", description: filename });
      setPassphrase("");
      setOpen(false);
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Export failed",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        nativeButton={true}
        render={
          <Button variant="outline" size="sm">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export {projectName}</DialogTitle>
          <DialogDescription>
            One JSON file with this project&apos;s configuration. Import it from
            Settings → Backup &amp; Migration on another install.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="font-medium">As template</Label>
              <p className="text-sm text-muted-foreground">
                Structure only — repositories, stack, sandbox settings, agents
                and skills. No features, documents, conversations or secrets: a
                teammate starts clean.
              </p>
            </div>
            <Switch checked={template} onCheckedChange={setTemplate} />
          </div>

          {!template && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="font-medium">Include conversations</Label>
                  <p className="text-sm text-muted-foreground">
                    Chat history and messages.
                  </p>
                </div>
                <Switch
                  checked={includeConversations}
                  onCheckedChange={setIncludeConversations}
                />
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="font-medium">Include secrets</Label>
                  <p className="text-sm text-muted-foreground">
                    Env values, tokens and API keys — the file is encrypted
                    with a passphrase.
                  </p>
                </div>
                <Switch
                  checked={includeSecrets}
                  onCheckedChange={setIncludeSecrets}
                />
              </div>

              {includeSecrets && (
                <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-amber-600" />
                    <Label htmlFor="project-export-passphrase">
                      Passphrase
                    </Label>
                  </div>
                  <Input
                    id="project-export-passphrase"
                    type="password"
                    autoComplete="new-password"
                    placeholder={`At least ${MIN_PASSPHRASE} characters`}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button onClick={run} disabled={busy || passphraseTooShort}>
            {busy ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-1.5" />
            )}
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
