"use client";

// The browser running on one sandbox (spec 23).
//
// Two services on one instance cannot be tested through tunnels: each process
// gets its own random public hostname, so a front end's API_URL is wrong from
// the viewer's browser whatever it says. This browser runs *inside* the
// sandbox, where both services are plain localhost ports that already agree —
// so the app's own configuration is the thing being tested, not a rewritten
// copy of it.
//
// The iframe equivalent is a canvas driven by noVNC over the SSH forward the
// server opened; nothing here talks to the sandbox directly.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  ScrollText,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { VncScreen } from "@/components/projects/vnc-screen";
import { useToast } from "@/hooks/use-toast";
import {
  ApiError,
  getBrowserSession,
  getBrowserSessionLog,
  listSandboxProcesses,
  navigateBrowserSession,
  startBrowserSession,
  stopBrowserSession,
  type BrowserSessionView,
} from "@/services/sandbox";

const LIVE = new Set(["running", "starting"]);

/**
 * The ports worth offering as shortcuts: every port the sandbox's own
 * processes serve on. `checkPorts` covers the launchers, whose `port` is null
 * by design — their shell exits once the containers are detached.
 */
function shortcutPorts(
  processes: { port: number | null; checkPorts: number[]; label: string }[],
): { port: number; label: string }[] {
  const seen = new Map<number, string>();
  for (const proc of processes) {
    for (const port of [proc.port, ...(proc.checkPorts ?? [])]) {
      if (typeof port === "number" && port > 0 && !seen.has(port)) {
        seen.set(port, proc.label);
      }
    }
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([port, label]) => ({ port, label }));
}

export function SandboxBrowserPanel({
  projectId,
  sandboxId,
  provider,
}: {
  projectId: string;
  sandboxId: string;
  /** Which transport serves the session — the two differ, and the caption
   * claiming an SSH forward is wrong for a container, which has no sshd. */
  provider?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  // Maximize fills the app window rather than the card. The sandbox card is a
  // few hundred pixels of a column, which is enough to see that a page loaded
  // and not enough to work in.
  const [maximized, setMaximized] = useState(false);
  const [log, setLog] = useState("");
  const [url, setUrl] = useState("http://localhost:3000");

  const sessionKey = ["browser-session", projectId, sandboxId];

  const { data: session, isLoading } = useQuery({
    queryKey: sessionKey,
    queryFn: () => getBrowserSession(projectId, sandboxId),
    // While starting, the row changes without anything here acting.
    refetchInterval: (q) =>
      LIVE.has((q.state.data as BrowserSessionView | null)?.status ?? "")
        ? 3000
        : false,
  });

  // The shortcuts come from the processes the sandbox already knows how to
  // run, so the bar offers the app's real ports rather than a guess.
  const { data: processes } = useQuery({
    queryKey: ["sandbox-processes", projectId, sandboxId],
    queryFn: () => listSandboxProcesses(projectId, sandboxId),
  });

  const start = useMutation({
    mutationFn: () => startBrowserSession(projectId, sandboxId),
    onSuccess: (next) => {
      queryClient.setQueryData(sessionKey, next);
    },
    onError: (err) => {
      toast({
        title: "The browser did not start",
        description:
          err instanceof ApiError ? err.message : "Check the session log.",
        variant: "destructive",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () => stopBrowserSession(projectId, sandboxId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    },
  });

  // Navigation goes over CDP, not over VNC: VNC carries pixels and input and
  // has no concept of a URL.
  const go = useMutation({
    mutationFn: (next: string) =>
      navigateBrowserSession(projectId, sandboxId, next),
    onError: (err) => {
      toast({
        title: "Could not open that address",
        description:
          err instanceof ApiError
            ? err.message
            : "The session may have stopped.",
        variant: "destructive",
      });
    },
  });

  // Escape leaves the maximized view. A layer covering the whole window needs
  // the exit every other full-screen surface has trained people to reach for.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const running = session?.status === "running" && session.localUrl;

  return (
    <div
      className={
        maximized
          ? "fixed inset-0 z-50 flex flex-col gap-2 overflow-auto bg-background p-4"
          : "space-y-2"
      }
    >
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Browser</span>
        {session?.status && session.status !== "stopped" && (
          <span className="text-[10px] text-muted-foreground">
            {session.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {running && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMaximized((m) => !m)}
                title={maximized ? "Restore (Esc)" : "Maximize"}
                aria-label={maximized ? "Restore" : "Maximize"}
              >
                {maximized ? (
                  <Minimize2 className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </Button>
              {/* A tab of its own, for working in it beside the editor rather
                  than inside a card. The route re-fetches the session, so the
                  VNC password never travels in a URL that lands in history. */}
              <a
                href={`/projects/${projectId}/sandboxes/${sandboxId}/browser`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in a new tab"
                aria-label="Open in a new tab"
                className="tap-target inline-flex h-8 items-center rounded-lg px-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:h-7"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
          {running ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              {stop.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3" />
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => start.mutate()}
              disabled={start.isPending || isLoading}
              title="Run a browser inside the sandbox"
            >
              {start.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              setShowLog((v) => !v);
              if (!showLog) {
                setLog(await getBrowserSessionLog(projectId, sandboxId));
              }
            }}
            title="Session log"
          >
            <ScrollText className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {session?.error && (
        <p className="text-[11px] text-destructive">{session.error}</p>
      )}

      {running && (
        // Maximized, the canvas takes the leftover height instead of its fixed
        // 420px — the address bar and the port shortcuts keep their own.
        <div
          className={
            maximized
              ? "flex min-h-0 flex-1 flex-col gap-2"
              : "flex flex-col gap-2"
          }
        >
          <div className="flex flex-wrap items-center gap-1">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go.mutate(url);
              }}
              className="h-7 flex-1 rounded-md border bg-background px-2 text-xs"
              placeholder="http://localhost:3000"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go.mutate(url)}
              disabled={go.isPending}
              title="Open this address in the session"
            >
              {go.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
          {shortcutPorts(processes ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {shortcutPorts(processes ?? []).map(({ port, label }) => (
                <button
                  key={port}
                  type="button"
                  onClick={() => {
                    const next = `http://localhost:${port}`;
                    setUrl(next);
                    go.mutate(next);
                  }}
                  className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  title={`${label} — localhost:${port} inside the sandbox`}
                >
                  :{port}
                </button>
              ))}
            </div>
          )}
          <div className={maximized ? "min-h-0 flex-1" : ""}>
            <VncScreen
              url={session!.localUrl!}
              password={session!.token ?? ""}
              className={maximized ? "h-full min-h-0 w-full" : "h-[420px] w-full"}
              fill={maximized}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Runs inside the sandbox, so <code>localhost</code> here is the
            sandbox&apos;s own — the app&apos;s API URL resolves without any
            rewriting.{" "}
            {provider === "local"
              ? "Reached over a port docker publishes on this machine's loopback, not a public tunnel."
              : "Reached over an SSH forward from this machine, not a public tunnel."}
          </p>
        </div>
      )}

      {showLog && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[10px]">
          {log || "(empty)"}
        </pre>
      )}
    </div>
  );
}
