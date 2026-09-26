"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AppWindow, Loader2 } from "lucide-react";

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
import { NO_AUTOFILL } from "@/lib/utils";
import {
  getDesktopConfig,
  resetDesktopConfig,
  saveDesktopConfig,
  type DesktopConfigView,
} from "@/services/desktop-config";

const QUERY_KEY = ["desktop-config"];

/**
 * Where the desktop app keeps its data (`~/.nexux/native.json`). Editable from
 * any Nexux on this machine — from `pnpm dev` it points the installed app at
 * the dev database; from the app itself it moves the app. Applies on the
 * app's next launch either way.
 */
export function DesktopAppSection() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: QUERY_KEY, queryFn: getDesktopConfig });
  const [databasePath, setDatabasePath] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [saved, setSaved] = useState(false);

  // Seed the fields from the file once it loads (and after each save).
  const file = config.data?.file;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- form seeded from server state
    setDatabasePath(file?.databasePath ?? "");
    setDataDir(file?.dataDir ?? "");
  }, [file?.databasePath, file?.dataDir]);

  const onDone = (view: DesktopConfigView) => {
    qc.setQueryData(QUERY_KEY, view);
    setSaved(true);
  };
  const save = useMutation({ mutationFn: saveDesktopConfig, onSuccess: onDone });
  const reset = useMutation({ mutationFn: resetDesktopConfig, onSuccess: onDone });

  const view = config.data;
  const busy = save.isPending || reset.isPending;
  const dirty =
    databasePath.trim() !== (file?.databasePath ?? "") || dataDir.trim() !== (file?.dataDir ?? "");
  const isApp = view?.thisServer.isDesktopApp ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AppWindow className="h-5 w-5" />
          Desktop app data
        </CardTitle>
        <CardDescription>
          Which database and data folder the desktop app opens. Point it at the
          same database as <code>pnpm dev</code> to test the packaged app on
          your real projects and settings. Only one Nexux can run against a
          database at a time — the second one says which is running.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {config.isLoading || !view ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {view.fileError && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {view.fileError} The desktop app won&apos;t start until this is
                  fixed — saving below replaces the file.
                </span>
              </p>
            )}

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="desktop-db">Database file</Label>
                {view.thisServer.databasePath !== view.effective?.databasePath && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setDatabasePath(view.thisServer.databasePath);
                      setSaved(false);
                    }}
                  >
                    Use this server&apos;s database
                  </Button>
                )}
              </div>
              <Input
                id="desktop-db"
                {...NO_AUTOFILL}
                className="font-mono text-xs"
                placeholder={`default: ${view.effective?.dataDir ?? "~/.nexux"}/nexux.db`}
                value={databasePath}
                onChange={(e) => {
                  setDatabasePath(e.target.value);
                  setSaved(false);
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="desktop-data">Data folder</Label>
              <Input
                id="desktop-data"
                {...NO_AUTOFILL}
                className="font-mono text-xs"
                placeholder="default: ~/.nexux"
                value={dataDir}
                onChange={(e) => {
                  setDataDir(e.target.value);
                  setSaved(false);
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                SSH keys, sandbox working folders and search indexes. Leave it
                empty unless you know you want them elsewhere — <code>pnpm dev</code>{" "}
                uses <code>{view.thisServer.dataDir}</code>.
              </p>
            </div>

            {view.effective && (
              <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                <div>
                  Next launch opens{" "}
                  <code className="break-all">{view.effective.databasePath}</code>
                  {!view.effective.databaseExists && (
                    <span className="text-amber-300/90">
                      {" "}
                      — doesn&apos;t exist yet; the app will create an empty one
                    </span>
                  )}
                </div>
                <div>
                  Saved in <code className="break-all">{view.configPath}</code>
                </div>
              </div>
            )}

            {(save.error || reset.error) && (
              <p className="text-xs text-destructive">
                {((save.error ?? reset.error) as Error).message}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={busy || !dirty}
                onClick={() => save.mutate({ databasePath, dataDir })}
              >
                {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
              {view.file && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => reset.mutate()}
                >
                  Back to defaults
                </Button>
              )}
              {saved && !dirty && (
                <span className="text-xs text-muted-foreground">
                  {isApp
                    ? "Saved. Quit and reopen Nexus to switch."
                    : "Saved. Applies the next time the desktop app opens."}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
