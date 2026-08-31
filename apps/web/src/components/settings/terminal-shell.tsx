"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, SquareTerminal, Terminal as TerminalIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ShellOption = {
  id: string;
  label: string;
  kind: string;
  distro?: string;
};

type ShellsResponse = {
  shells: ShellOption[];
  defaultShellId: string;
  storedShellId: string | null;
  platform: string;
};

/**
 * Picks the shell new terminals open with. Per-terminal choice still overrides
 * it — this only decides what "no choice" means.
 *
 * The list is whatever the *server* machine can run (each WSL distro is its own
 * entry), so a browser pointed at a Nexus host configures that host, not the
 * laptop looking at it.
 */
export function TerminalShellSection() {
  const queryClient = useQueryClient();

  const info = useQuery({
    queryKey: ["terminal-shells"],
    queryFn: async (): Promise<ShellsResponse> => {
      const res = await fetch("/api/terminal/shells", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not list shells");
      return res.json();
    },
  });

  const setDefault = useMutation({
    mutationFn: async (shellId: string) => {
      const res = await fetch("/api/terminal/shells", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shellId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save the default shell");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["terminal-shells"] });
    },
  });

  const shells = info.data?.shells ?? [];
  const selected = info.data?.defaultShellId;
  // A stored id that no longer resolves (a WSL distro since unregistered, a
  // database moved between machines) is silently replaced by the platform
  // default — say so rather than showing a selection the user did not make.
  const storedMissing =
    info.data?.storedShellId != null &&
    info.data.storedShellId !== info.data.defaultShellId;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="h-5 w-5" />
          Terminal
        </CardTitle>
        <CardDescription>
          Which shell new terminals open with. Any terminal can still be opened
          in another one from the <span className="font-medium">New</span> menu.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {info.isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Detecting shells…
          </p>
        )}

        {info.isError && (
          <p className="text-sm text-destructive">
            Could not detect the shells on this machine.
          </p>
        )}

        {storedMissing && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            The saved shell (<code>{info.data?.storedShellId}</code>) is not
            available here — using {selected} instead.
          </p>
        )}

        {shells.length === 1 && (
          <p className="text-sm text-muted-foreground">
            This machine offers one shell:{" "}
            <span className="font-medium">{shells[0].label}</span>.
          </p>
        )}

        {shells.length > 1 && (
          <div className="flex flex-col gap-1">
            {shells.map((shell) => (
              <button
                key={shell.id}
                type="button"
                disabled={setDefault.isPending}
                onClick={() => setDefault.mutate(shell.id)}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  shell.id === selected
                    ? "border-primary bg-accent"
                    : "border-transparent hover:bg-accent/50"
                }`}
              >
                {shell.kind === "wsl" ? (
                  <SquareTerminal className="h-4 w-4 text-sky-400" />
                ) : (
                  <TerminalIcon className="h-4 w-4" />
                )}
                <span>{shell.label}</span>
                {shell.id === selected && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    default
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {setDefault.isError && (
          <p className="text-sm text-destructive">
            {(setDefault.error as Error).message}
          </p>
        )}

        {info.data?.platform === "win32" && (
          <p className="text-xs text-muted-foreground">
            A WSL terminal resolves its directory inside the distro: a Windows
            path is translated (<code>E:\workspace\x</code> →{" "}
            <code>/mnt/e/workspace/x</code>), and a path under{" "}
            <code>\\wsl.localhost\…</code> becomes the Linux path it maps to.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
