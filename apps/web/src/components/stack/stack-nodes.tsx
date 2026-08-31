"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Container, FolderGit2, TerminalSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  DetectionResult,
  PortMapping,
  StackRunMode,
} from "@/lib/stack/types";

export type StackFlowNodeData = {
  label: string;
  kind: "repo" | "service";
  runMode: StackRunMode;
  image?: string | null;
  localCommand?: string | null;
  managesServices?: boolean;
  ports?: PortMapping[] | null;
  detection?: DetectionResult | null;
  // "running" | "stopped" | undefined (unknown / stack not up)
  liveState?: string;
};

export type StackFlowNode = Node<StackFlowNodeData>;

function StatusDot({ state }: { state?: string }) {
  if (!state) return null;
  // "external:<port>" — up, but started outside Nexus (a manual `pnpm dev`).
  const external = state.startsWith("external");
  const port = external ? state.split(":")[1] : null;
  const color = external
    ? "bg-emerald-500 ring-2 ring-amber-400/70"
    : state === "running"
      ? "bg-emerald-500"
      : state === "exited" || state === "stopped"
        ? "bg-red-500"
        : "bg-amber-500";
  return (
    <span
      className={`h-2 w-2 rounded-full ${color} shrink-0`}
      title={
        external
          ? `Running outside Nexus${port ? ` (port ${port} in use)` : ""} — Down will not stop it`
          : state
      }
    />
  );
}

function NodeShell({
  data,
  icon,
  accent,
}: {
  data: StackFlowNodeData;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div
      className="rounded-md border bg-card px-3.5 py-2.5 shadow-sm min-w-[230px]"
      style={{ borderLeft: `4px solid ${accent}` }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !bg-foreground/40"
      />
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-base font-semibold truncate flex-1">
          {data.label}
        </span>
        <StatusDot state={data.liveState} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[11px] gap-1">
          {data.runMode === "docker" ? (
            <Container className="h-2.5 w-2.5" />
          ) : (
            <TerminalSquare className="h-2.5 w-2.5" />
          )}
          {data.runMode}
        </Badge>
        {/* A local node that really drives containers — worth showing, since
            "local" alone reads as "just a process on the host". */}
        {data.runMode === "local" && data.managesServices ? (
          <Badge variant="outline" className="text-[11px] gap-1">
            <Container className="h-2.5 w-2.5" />
            services
          </Badge>
        ) : null}
        {data.kind === "repo" && data.detection?.hasDockerfile ? (
          <Badge variant="outline" className="text-[11px]">
            Dockerfile ✓
          </Badge>
        ) : null}
        {data.kind === "repo" && data.detection?.hasMakefile ? (
          <Badge variant="outline" className="text-[11px]">
            Makefile ✓
          </Badge>
        ) : null}
        {data.kind === "repo" && data.detection?.packageManager ? (
          <Badge variant="outline" className="text-[11px]">
            {data.detection.packageManager}
          </Badge>
        ) : null}
        {(data.ports ?? []).map((p) => (
          <Badge
            key={`${p.host}:${p.container}`}
            variant="secondary"
            className="text-[11px] tabular-nums"
          >
            :{p.host}
          </Badge>
        ))}
      </div>
      {data.runMode === "local" && data.localCommand ? (
        <div className="mt-1.5 text-xs font-mono text-muted-foreground truncate">
          $ {data.localCommand}
        </div>
      ) : null}
      {data.kind === "service" && data.image ? (
        <div className="mt-1.5 text-xs font-mono text-muted-foreground truncate">
          {data.image}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !bg-foreground/40"
      />
    </div>
  );
}

export function RepoNode({ data }: NodeProps<StackFlowNode>) {
  return (
    <NodeShell
      data={data}
      accent="#3b82f6"
      icon={<FolderGit2 className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
    />
  );
}

export function ServiceNode({ data }: NodeProps<StackFlowNode>) {
  return (
    <NodeShell
      data={data}
      accent="#a855f7"
      icon={<Container className="h-3.5 w-3.5 text-purple-400 shrink-0" />}
    />
  );
}

export const stackNodeTypes = { repo: RepoNode, service: ServiceNode };
