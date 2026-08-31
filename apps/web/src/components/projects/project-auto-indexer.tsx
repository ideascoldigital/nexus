"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getEmbedderHealth,
  getIndexStatus,
  runIndex,
} from "@/services/projects";

// Re-index at most this often per project (incremental builds are cheap —
// unchanged sources are skipped by content hash — but they still walk the
// repo filesystem).
const FRESH_TTL_MS = 10 * 60 * 1000;

/**
 * Invisible: keeps the project's search index warm. On project open, if the
 * embedder is healthy and the index is empty or stale, fires an incremental
 * build in the background. The server coalesces concurrent builds, and a
 * session guard keeps one attempt per project per browser session.
 */
export function ProjectAutoIndexer({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const guardKey = `nexux-auto-index-${projectId}`;
    if (sessionStorage.getItem(guardKey)) return;

    let cancelled = false;
    (async () => {
      try {
        const health = await getEmbedderHealth();
        if (!health.ollamaReachable || !health.modelPresent) return;

        const status = await getIndexStatus(projectId);
        const fresh =
          status.total > 0 &&
          status.lastIndexedAt !== null &&
          Date.now() - new Date(status.lastIndexedAt).getTime() < FRESH_TTL_MS;
        if (fresh || cancelled) return;

        sessionStorage.setItem(guardKey, String(Date.now()));
        await runIndex(projectId, "incremental");
        qc.invalidateQueries({
          queryKey: ["embedding-index-status", projectId],
        });
      } catch {
        // Best-effort: the Search tab still offers manual indexing.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, qc]);

  return null;
}
