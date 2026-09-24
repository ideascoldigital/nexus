"use client";

// The sandbox browser, filling a tab of its own.
//
// The panel inside the sandbox card answers "did it load"; this answers "let
// me work in it". Same session, same noVNC canvas — it simply gets the window
// instead of a few hundred pixels of a column.
//
// The session is fetched here rather than handed over in the URL: the VNC
// password would otherwise travel in a link that lands in history, gets copied
// into a chat, and outlives the session it unlocks.

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Globe, Loader2 } from "lucide-react";

import { VncScreen } from "@/components/projects/vnc-screen";
import { getBrowserSession } from "@/services/sandbox";

export default function SandboxBrowserPage({
  params,
}: {
  params: Promise<{ projectId: string; sandboxId: string }>;
}) {
  const { projectId, sandboxId } = use(params);

  const { data: session, isLoading } = useQuery({
    queryKey: ["browser-session", projectId, sandboxId],
    queryFn: () => getBrowserSession(projectId, sandboxId),
    // The forward can drop without the page hearing about it; this is the same
    // cadence the panel polls at.
    refetchInterval: 5_000,
  });

  const live = session?.status === "running" && session.localUrl;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Link
          href={`/projects/${projectId}?tab=sandboxes`}
          className="tap-target inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to the project
        </Link>
        <Globe className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Browser</span>
        {session?.status && session.status !== "stopped" ? (
          <span className="text-[10px] text-muted-foreground">
            {session.status}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading the session…
        </div>
      ) : live ? (
        <div className="min-h-0 flex-1">
          <VncScreen
            url={session.localUrl!}
            password={session.token ?? ""}
            className="h-full min-h-0 w-full"
            fill
          />
        </div>
      ) : (
        // Starting one from here would leave the card that owns this session
        // showing a stale "stopped", so the start button stays in one place.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm">No browser is running on this sandbox.</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Start one from the sandbox card on the project&apos;s Sandboxes
            tab, then open this tab again.
          </p>
        </div>
      )}
    </div>
  );
}
