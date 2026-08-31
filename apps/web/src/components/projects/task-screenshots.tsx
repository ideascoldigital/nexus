"use client";

// Screenshots the agent captured for a task, served from the host's local
// store (collected off the sandbox after the run). Telegram already got
// them; this puts the same images next to the report in the UI. Thumbnails
// open a lightbox carousel — arrow keys / buttons move between shots.

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getTaskScreenshots, taskScreenshotUrl } from "@/services/tasks";

export function TaskScreenshots({
  projectId,
  taskId,
  enabled = true,
}: {
  projectId: string;
  taskId: string;
  /** Skip fetching while the run is still going — nothing is collected yet. */
  enabled?: boolean;
}) {
  const shots = useQuery({
    queryKey: ["task-screenshots", projectId, taskId],
    queryFn: () => getTaskScreenshots(projectId, taskId),
    enabled,
    // Collected once per run; a settled task never grows new images.
    staleTime: Infinity,
  });
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const files = shots.data ?? [];
  const count = files.length;
  const step = useCallback(
    (delta: number) =>
      setOpenIndex((i) =>
        i === null || count === 0 ? i : (i + delta + count) % count,
      ),
    [count],
  );

  if (count === 0) return null;
  const current = openIndex === null ? null : files[openIndex];
  const label = (name: string) =>
    name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

  return (
    <>
      <div className="flex flex-wrap gap-2 pt-1.5">
        {files.map((name, i) => (
          <button
            key={name}
            type="button"
            onClick={() => setOpenIndex(i)}
            title={name}
            className="block w-40 cursor-zoom-in overflow-hidden rounded-md border border-border/60 transition-colors hover:border-primary/50"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={taskScreenshotUrl(projectId, taskId, name)}
              alt={name}
              loading="lazy"
              className="block h-auto w-full"
            />
          </button>
        ))}
      </div>

      <Dialog
        open={current !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <DialogContent
          className="w-fit max-w-[95vw] gap-1.5 bg-black/90 p-2 ring-white/10 sm:max-w-[95vw]"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              step(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              step(-1);
            }
          }}
        >
          {current !== null && (
            <>
              <DialogTitle className="sr-only">{current}</DialogTitle>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={taskScreenshotUrl(projectId, taskId, current)}
                alt={current}
                className="max-h-[82vh] w-auto max-w-full rounded object-contain"
              />
              {count > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label="Previous screenshot"
                    className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => step(1)}
                    aria-label="Next screenshot"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </>
              )}
              <div className="flex items-center gap-2 px-1 text-[11px] text-white/70">
                <span className="min-w-0 flex-1 truncate">{label(current)}</span>
                {count > 1 && (
                  <span className="shrink-0 font-mono">
                    {(openIndex ?? 0) + 1} / {count}
                  </span>
                )}
                <a
                  href={taskScreenshotUrl(projectId, taskId, current)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex shrink-0 items-center gap-1 hover:text-white"
                  title="Open the original image in a new tab"
                >
                  <ExternalLink className="h-3 w-3" />
                  Original
                </a>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
