"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Loader2,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  getEmbedderHealth,
  installEmbeddingModel,
  getIndexStatus,
  runIndex,
  dropIndex,
  searchProject,
  type SearchHit,
  type GroupedSearchResults,
  type InstallProgress,
} from "@/services/projects";

type Props = { projectId: string };

export function ProjectSearchSetup({ projectId }: Props) {
  const qc = useQueryClient();

  const health = useQuery({
    queryKey: ["embedder-health"],
    queryFn: getEmbedderHealth,
    refetchInterval: 10_000,
  });

  const status = useQuery({
    queryKey: ["embedding-index-status", projectId],
    queryFn: () => getIndexStatus(projectId),
  });

  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const installMutation = useMutation({
    mutationFn: async () => {
      setInstallProgress({ status: "starting" });
      await installEmbeddingModel((p) => setInstallProgress(p));
      setInstallProgress({ done: true, status: "complete" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["embedder-health"] });
    },
  });

  const indexMutation = useMutation({
    mutationFn: (mode: "incremental" | "full") => runIndex(projectId, mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["embedding-index-status", projectId] });
    },
  });

  const dropMutation = useMutation({
    mutationFn: () => dropIndex(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["embedding-index-status", projectId] });
    },
  });

  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<GroupedSearchResults | null>(null);
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [k, setK] = useState(8);
  const searchMutation = useMutation({
    mutationFn: (q: string) =>
      searchProject(projectId, q, {
        k,
        sourceTypes: activeFilters.length ? activeFilters : undefined,
      }),
    onSuccess: (data) => setGroups(data),
  });

  function toggleFilter(t: string) {
    setActiveFilters((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  const ollamaOk = health.data?.ollamaReachable === true;
  const modelOk = health.data?.modelPresent === true;
  const indexedCount = status.data?.total ?? 0;
  const ready = ollamaOk && modelOk;

  return (
    <div className="mt-4 space-y-4">
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" />
            Semantic search setup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <StatusPill
              ok={ollamaOk}
              loading={health.isLoading}
              label="Ollama"
              detail={health.data?.host ?? "127.0.0.1:11434"}
            />
            <StatusPill
              ok={modelOk}
              loading={health.isLoading}
              label="Model"
              detail={health.data?.modelName ?? "nomic-embed-text"}
            />
            <StatusPill
              ok={indexedCount > 0}
              loading={status.isLoading}
              label="Index"
              detail={
                indexedCount > 0
                  ? `${indexedCount} sources`
                  : "empty"
              }
            />
          </div>

          {!ollamaOk && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300/90">
              Ollama not running at <code>{health.data?.host ?? "127.0.0.1:11434"}</code>.
              Install from{" "}
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                ollama.com/download
              </a>
              {" "}then refresh.
            </div>
          )}

          {ollamaOk && !modelOk && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Model <code>nomic-embed-text</code> not installed (~274 MB).
              </p>
              <Button
                size="sm"
                onClick={() => installMutation.mutate()}
                disabled={installMutation.isPending}
              >
                {installMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Install model
              </Button>
              {installProgress && (
                <InstallProgressBar progress={installProgress} />
              )}
            </div>
          )}

          {ready && (
            <>
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Index</p>
                    <p className="text-xs text-muted-foreground">
                      {status.data?.lastIndexedAt
                        ? `Last indexed ${formatDistanceToNow(
                            new Date(status.data.lastIndexedAt),
                            { addSuffix: true },
                          )}`
                        : "Never indexed"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => indexMutation.mutate("incremental")}
                      disabled={indexMutation.isPending}
                    >
                      {indexMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                      Index
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => indexMutation.mutate("full")}
                      disabled={indexMutation.isPending}
                    >
                      Full reindex
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dropMutation.mutate()}
                      disabled={dropMutation.isPending || indexedCount === 0}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>

                {indexMutation.data && (
                  <div className="rounded-md border border-border/50 bg-muted/30 p-3 text-xs">
                    <div className="font-medium mb-1 flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      Indexing complete ({indexMutation.data.durationMs} ms)
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-muted-foreground">
                      <Stat label="Scanned" value={indexMutation.data.scanned} />
                      <Stat label="Embedded" value={indexMutation.data.embedded} />
                      <Stat label="Skipped" value={indexMutation.data.skipped} />
                      <Stat label="Removed" value={indexMutation.data.removed} />
                    </div>
                  </div>
                )}

                {indexMutation.error && (
                  <p className="text-xs text-destructive">
                    {(indexMutation.error as Error).message}
                  </p>
                )}

                {status.data && status.data.counts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {status.data.counts.map((c) => (
                      <Badge
                        key={`${c.sourceType}-${c.provider}`}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {c.sourceType}: {c._count} ({c._sum.chunkCount ?? 0} chunks)
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {ready && indexedCount > 0 && (
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Search className="h-4 w-4" />
              Search
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.data && status.data.counts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Array.from(new Set(status.data.counts.map((c) => c.sourceType))).map(
                  (t) => {
                    const active = activeFilters.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleFilter(t)}
                        className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                          active
                            ? "border-violet-500/40 bg-violet-500/15 text-violet-200"
                            : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                        }`}
                      >
                        {t}
                      </button>
                    );
                  },
                )}
                {activeFilters.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveFilters([])}
                    className="rounded-full px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    clear
                  </button>
                )}
              </div>
            )}

            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim()) searchMutation.mutate(query.trim());
              }}
            >
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask about your code, docs or features..."
                className="flex-1"
              />
              <select
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
                title="Results per category"
                className="rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                {[4, 8, 12, 20, 30, 50].map((n) => (
                  <option key={n} value={n}>
                    {n} / cat
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                size="sm"
                disabled={searchMutation.isPending || !query.trim()}
              >
                {searchMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Search"
                )}
              </Button>
            </form>

            {searchMutation.error && (
              <p className="text-xs text-destructive">
                {(searchMutation.error as Error).message}
              </p>
            )}

            {groups && (
              <div className="space-y-4">
                <BucketSection title="Repositories" hits={groups.repos} />
                <BucketSection title="Conversations" hits={groups.conversations} />
                <BucketSection title="Project data" hits={groups.projectData} />
                {groups.repos.length === 0 &&
                  groups.conversations.length === 0 &&
                  groups.projectData.length === 0 && (
                    <p className="text-xs text-muted-foreground">No results.</p>
                  )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusPill({
  ok,
  loading,
  label,
  detail,
}: {
  ok: boolean;
  loading: boolean;
  label: string;
  detail: string;
}) {
  const color = loading
    ? "border-border bg-muted/30 text-muted-foreground"
    : ok
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : "border-amber-500/20 bg-amber-500/10 text-amber-300";

  const Icon = loading ? Loader2 : ok ? CheckCircle2 : AlertCircle;

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${color}`}
    >
      <Icon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      <span className="font-medium">{label}</span>
      <span className="opacity-70">{detail}</span>
    </div>
  );
}

function InstallProgressBar({ progress }: { progress: InstallProgress }) {
  const pct =
    progress.total && progress.completed
      ? Math.min(100, Math.floor((progress.completed / progress.total) * 100))
      : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{progress.status ?? "pulling..."}</span>
        {pct !== null && <span>{pct}%</span>}
      </div>
      <div className="h-1 w-full rounded bg-muted">
        <div
          className="h-1 rounded bg-violet-500 transition-all"
          style={{ width: `${pct ?? (progress.done ? 100 : 5)}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-foreground tabular-nums">{value}</div>
      <div className="text-[10px]">{label}</div>
    </div>
  );
}

function BucketSection({ title, hits }: { title: string; hits: SearchHit[] }) {
  if (!hits.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-[10px] text-muted-foreground">({hits.length})</span>
      </div>
      <div className="space-y-2">
        {hits.map((hit, idx) => (
          <SearchResult
            key={`${hit.bucket}-${hit.sourceType}-${hit.sourceId}-${hit.chunkIndex}-${idx}`}
            hit={hit}
          />
        ))}
      </div>
    </div>
  );
}

function SearchResult({ hit }: { hit: SearchHit }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono truncate">{hit.filePath}</span>
          {hit.startLine ? (
            <span className="text-[10px] text-muted-foreground">
              :{hit.startLine}-{hit.endLine}
            </span>
          ) : null}
        </div>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {hit.sourceType}
        </Badge>
      </div>
      {hit.heading && (
        <div className="mt-1 text-[11px] font-medium text-muted-foreground">
          {hit.heading}
        </div>
      )}
      <pre className="mt-1 max-h-32 overflow-hidden text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap line-clamp-6">
        {hit.snippet}
      </pre>
      <div className="mt-1 text-[10px] text-muted-foreground">
        score {hit.score.toFixed(3)}
      </div>
    </div>
  );
}
