"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FlaskConical, Loader2, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { describeSimilarity } from "@/lib/embedding-test";
import {
  getEmbedderHealth,
  installEmbeddingModel,
  testEmbeddings,
  type InstallProgress,
} from "@/services/projects";

const QUERY_KEY = ["embedder-health"];

/**
 * The local embedding model behind semantic search and ⌘K: whether it is
 * there, installing it, and — the part that was missing — trying it. Two texts
 * that mean the same thing should score well above two that do not; if they
 * do, search has what it needs.
 */
export function EmbeddingsSection() {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: QUERY_KEY, queryFn: getEmbedderHealth });
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [a, setA] = useState("How do I reset my password?");
  const [b, setB] = useState("I forgot my login credentials");

  const install = useMutation({
    mutationFn: () => installEmbeddingModel(setProgress),
    onSettled: () => {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const run = useMutation({
    mutationFn: () => testEmbeddings([a, b].map((t) => t.trim()).filter(Boolean)),
  });

  const h = health.data;
  const ready = Boolean(h?.ollamaReachable && h?.modelPresent);
  const pct =
    progress?.total && progress.completed ? Math.round((progress.completed / progress.total) * 100) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Embeddings
        </CardTitle>
        <CardDescription>
          The local model behind semantic search and ⌘K — {h?.modelName ?? "nomic-embed-text"} on
          Ollama. Nothing leaves this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {health.isLoading ? (
            <span className="text-muted-foreground">Checking…</span>
          ) : (
            <>
              <Badge variant="outline" className={h?.ollamaReachable ? "text-emerald-400" : "text-destructive"}>
                Ollama {h?.ollamaReachable ? "answering" : "not answering"}
              </Badge>
              <Badge variant="outline" className={h?.modelPresent ? "text-emerald-400" : "text-amber-400"}>
                model {h?.modelPresent ? "installed" : "missing"}
              </Badge>
              <code className="text-muted-foreground">{h?.host}</code>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => health.refetch()}>
                Check again
              </Button>
            </>
          )}
        </div>
        {h && !h.ollamaReachable && (
          <p className="text-xs text-muted-foreground">
            Start Ollama (the app, or <code>ollama serve</code>). The address comes from the{" "}
            <code>OLLAMA_URL</code> environment variable of this server.
          </p>
        )}
        {h?.ollamaReachable && !h.modelPresent && (
          <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
            {install.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {install.isPending
              ? `Installing ${h.modelName}${pct !== null ? ` · ${pct}%` : ""}`
              : `Install ${h.modelName} (~275 MB)`}
          </Button>
        )}
        {install.isError && (
          <p className="text-xs text-destructive">{(install.error as Error).message}</p>
        )}

        <div className="space-y-2 rounded-md border border-border/50 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <FlaskConical className="h-3.5 w-3.5" />
            Try it
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Textarea value={a} onChange={(e) => setA(e.target.value)} rows={2} maxLength={2000} aria-label="First text" />
            <Textarea
              value={b}
              onChange={(e) => setB(e.target.value)}
              rows={2}
              maxLength={2000}
              aria-label="Second text"
              placeholder="Optional — leave empty to embed one text"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => run.mutate()}
            disabled={!ready || run.isPending || !a.trim()}
          >
            {run.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Embed and compare
          </Button>
          {run.isError && <p className="text-xs text-destructive">{(run.error as Error).message}</p>}
          {run.data && (
            <div className="space-y-1 font-mono text-xs">
              {run.data.similarity !== null && (
                <p className="text-sm">
                  similarity <strong>{run.data.similarity.toFixed(3)}</strong>{" "}
                  <span className="font-sans text-muted-foreground">
                    — {describeSimilarity(run.data.similarity)}
                  </span>
                </p>
              )}
              <p className="text-muted-foreground">
                {run.data.dimensions} dimensions ·{" "}
                {run.data.results.map((r) => `${r.latencyMs} ms`).join(" / ")}
                {run.data.results[0]?.latencyMs > 300 && " (the first call loads the model)"}
              </p>
              <p className="truncate text-muted-foreground" title="The first values of the first vector">
                [{run.data.results[0]?.preview.join(", ")}, …]
              </p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            For this model, related texts score around 0.65 and up; unrelated ones
            well below 0.5. If related pairs don&apos;t beat unrelated ones,
            search results won&apos;t either.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
