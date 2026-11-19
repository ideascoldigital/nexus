"use client";

// Seed data for a database service node (spec 29): the backup every new
// sandbox restores into this service, right after it starts and before the
// repos run their migrations.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FolderOpen, Loader2, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { engineOfImage } from "@/lib/seed/format";
import {
  deleteSeed,
  getSeeds,
  seedFromPath,
  updateSeed,
  uploadSeed,
  type SeedSummary,
} from "@/services/seeds";

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const ENGINE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL/MariaDB", mongo: "MongoDB" } as const;

export function SeedDataCard({
  projectId,
  nodeId,
  image,
}: {
  projectId: string;
  nodeId: string;
  image: string | null;
}) {
  const engine = engineOfImage(image);
  const saved = !nodeId.startsWith("tmp-");
  const qc = useQueryClient();
  const seeds = useQuery({
    queryKey: ["project-seeds", projectId],
    queryFn: () => getSeeds(projectId),
    enabled: !!engine && saved,
  });
  const seed = seeds.data?.seeds.find((s) => s.stackNodeId === nodeId) ?? null;

  const [sensitive, setSensitive] = useState(true);
  const [localPath, setLocalPath] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["project-seeds", projectId] });

  const attach = useMutation({
    mutationFn: (source: { file: File } | { path: string }) => {
      setError(null);
      // A replacement keeps the current seed's flag; the switch below is only
      // shown for a first seed, so one row never carries two of them.
      const isSensitive = seed ? seed.sensitive : sensitive;
      return "file" in source
        ? uploadSeed(projectId, { nodeId, file: source.file, sensitive: isSensitive, onProgress: setProgress })
        : seedFromPath(projectId, { nodeId, path: source.path, sensitive: isSensitive });
    },
    onSuccess: () => {
      setLocalPath("");
      void refresh();
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => setProgress(null),
  });
  const patch = useMutation({
    mutationFn: (p: { sensitive?: boolean; enabled?: boolean }) => updateSeed(projectId, seed!.id, p),
    onSuccess: () => void refresh(),
    onError: (err: Error) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteSeed(projectId, seed!.id),
    onSuccess: () => {
      setConfirmRemove(false);
      void refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Only a database gets the card at all: a seed for redis is not a thing.
  if (!engine) return null;

  const busy = attach.isPending;
  const picker = (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) attach.mutate({ file });
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 w-full gap-1.5 text-xs"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {progress !== null ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading {Math.round(progress * 100)}%
          </>
        ) : busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the file…
          </>
        ) : (
          <>
            <Upload className="h-3.5 w-3.5" /> {seed ? "Replace with a file…" : "Upload a dump…"}
          </>
        )}
      </Button>
      {seeds.data?.canPickLocalFile && (
        <div className="flex gap-1.5">
          <Input
            className="h-8 font-mono text-xs"
            placeholder="/path/on/this/machine/dump.sql.gz"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            disabled={busy}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1 px-2 text-xs"
            disabled={busy || !localPath.trim()}
            onClick={() => attach.mutate({ path: localPath.trim() })}
            title="Read the file where it is — no upload, no size limit"
          >
            <FolderOpen className="h-3.5 w-3.5" /> Use
          </Button>
        </div>
      )}
      {!seed && (
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Contains real people&apos;s data</span>
          <Switch checked={sensitive} onCheckedChange={setSensitive} disabled={busy} />
        </label>
      )}
      <p className="text-[11px] text-muted-foreground">
        {ENGINE_LABEL[engine]} dump: plain SQL
        {engine === "postgres" ? " or pg_dump -Fc" : engine === "mongo" ? " — mongodump --archive" : ""}, optionally
        gzipped. Upload limit {seeds.data ? formatBytes(seeds.data.maxUploadBytes) : "…"}
        {seeds.data?.canPickLocalFile ? "; a path on this machine has none." : "."}
      </p>
    </div>
  );

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5 text-sm">
        <Database className="h-3.5 w-3.5" /> Seed data
      </Label>
      {!saved ? (
        <p className="text-xs text-muted-foreground">Save the canvas to attach a database backup to this service.</p>
      ) : seeds.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : seed ? (
        <SeedRow
          seed={seed}
          onToggle={(p) => patch.mutate(p)}
          pending={patch.isPending}
          confirmRemove={confirmRemove}
          onRemove={() => (confirmRemove ? remove.mutate() : setConfirmRemove(true))}
          onCancelRemove={() => setConfirmRemove(false)}
          removing={remove.isPending}
        >
          {picker}
        </SeedRow>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            A backup every new sandbox restores into this service, before the repos run their migrations.
          </p>
          {picker}
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SeedRow({
  seed,
  onToggle,
  pending,
  confirmRemove,
  onRemove,
  onCancelRemove,
  removing,
  children,
}: {
  seed: SeedSummary;
  onToggle: (p: { sensitive?: boolean; enabled?: boolean }) => void;
  pending: boolean;
  confirmRemove: boolean;
  onRemove: () => void;
  onCancelRemove: () => void;
  removing: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs" title={seed.fileName}>
          {seed.fileName}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {seed.formatLabel}
          {seed.gzipped ? " (gzip)" : ""} · {formatBytes(seed.sizeBytes)} ·{" "}
          {new Date(seed.createdAt).toLocaleDateString()}
        </p>
      </div>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>Restore into new sandboxes</span>
        <Switch checked={seed.enabled} disabled={pending} onCheckedChange={(enabled) => onToggle({ enabled })} />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>Contains real people&apos;s data</span>
        <Switch checked={seed.sensitive} disabled={pending} onCheckedChange={(sensitive) => onToggle({ sensitive })} />
      </label>
      {children}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={confirmRemove ? "destructive" : "ghost"}
          className="h-7 gap-1 px-2 text-xs"
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          {confirmRemove ? "Delete the file" : "Remove"}
        </Button>
        {confirmRemove && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onCancelRemove}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
