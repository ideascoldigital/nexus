"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "@/hooks/use-resolved-theme";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, SlidersHorizontal, Sparkles } from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { getProject } from "@/services/projects";
import {
  detectAllRepositories,
  detectRepository,
  getStack,
  getStackStatus,
  saveStack,
} from "@/services/stack";
import { slugifyServiceName } from "@nexux/harness/compose";
import {
  SERVICE_CATALOG,
  SERVICE_COMMANDS,
} from "@/lib/stack/service-catalog";
import type {
  DetectionResult,
  StackGraph,
  StackNodeDTO,
  StackNodeInput,
  StackStatus,
  StackSuggestion,
} from "@/lib/stack/types";
import { stackNodeTypes } from "./stack-nodes";
import { LG_BREAKPOINT, useBelowBreakpoint } from "@/hooks/use-breakpoint";
import { StackSidebar, STACK_DRAG_MIME, type StackDragPayload } from "./stack-sidebar";
import { StackInspector } from "./stack-inspector";
import { StackToolbar } from "./stack-toolbar";
import { StackNodeList } from "./stack-node-list";
import { StackLogsPanel } from "./stack-logs-panel";
import { StackAssistantPanel } from "./stack-assistant-panel";
import { StackProposalPanel } from "./stack-proposal-panel";
import { FloatingPanel } from "./floating-panel";
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
  usePanelRef,
} from "@/components/ui/resizable";

// Full node config lives in node.data; label/liveState are display extras.
type CanvasNodeData = StackNodeInput & {
  label: string;
  liveState?: string;
  [key: string]: unknown;
};

type CanvasNode = Node<CanvasNodeData>;

function dtoToNode(
  dto: StackNodeDTO,
  detections: Record<string, DetectionResult>
): CanvasNode {
  const detection =
    dto.detection ??
    (dto.repositoryId ? detections[dto.repositoryId] ?? null : null);
  return {
    id: dto.id,
    type: dto.kind,
    position: { x: dto.posX, y: dto.posY },
    data: {
      id: dto.id,
      kind: dto.kind,
      repositoryId: dto.repositoryId,
      name: dto.name,
      runMode: dto.runMode,
      image: dto.image,
      dockerfile: dto.dockerfile,
      buildContext: dto.buildContext,
      command: dto.command,
      installCommand: dto.installCommand,
      buildCommand: dto.buildCommand,
      localCommand: dto.localCommand,
      stopCommand: dto.stopCommand,
      managesServices: dto.managesServices,
      workdir: dto.workdir,
      ports: dto.ports,
      env: dto.env,
      volumes: dto.volumes,
      detection,
      phases: dto.phases,
      posX: dto.posX,
      posY: dto.posY,
      label: dto.name,
    },
  };
}

function nodesToInputs(nodes: CanvasNode[]): StackNodeInput[] {
  return nodes.map((n) => ({
    id: n.data.id,
    kind: n.data.kind,
    repositoryId: n.data.repositoryId,
    name: n.data.name,
    runMode: n.data.runMode,
    image: n.data.image,
    dockerfile: n.data.dockerfile,
    buildContext: n.data.buildContext,
    command: n.data.command,
    installCommand: n.data.installCommand,
    buildCommand: n.data.buildCommand,
    localCommand: n.data.localCommand,
    stopCommand: n.data.stopCommand,
    managesServices: n.data.managesServices,
    workdir: n.data.workdir,
    ports: n.data.ports,
    env: n.data.env,
    volumes: n.data.volumes,
    phases: n.data.phases,
    posX: n.position.x,
    posY: n.position.y,
  }));
}

function liveStateFor(
  data: CanvasNodeData,
  status: StackStatus | undefined
): string | undefined {
  if (!status?.running) return undefined;
  if (data.runMode === "local") {
    const local = status.local.find((l) => l.nodeId === data.id);
    if (!local) return undefined;
    if (!local.running) return "stopped";
    return local.external ? `external:${local.port ?? ""}` : "running";
  }
  const svc = status.compose.find(
    (s) => s.service === slugifyServiceName(data.name)
  );
  return svc?.state;
}

/** Fill the canvas: a thin margin, and room to zoom past 1:1 for tiny stacks. */
const FIT_VIEW_OPTIONS = { padding: 0.04, maxZoom: 1.75, minZoom: 0.15 };

/**
 * Dependency edges read "source depends on target", which the default hairline
 * bezier does not convey at all: give them weight, an arrow, and a label so the
 * direction is legible at a glance.
 */
const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep" as const,
  animated: true,
  label: "depends on",
  labelShowBg: true,
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
  labelBgStyle: { fill: "#0b0f17", fillOpacity: 0.85 },
  labelStyle: { fill: "#93a4bf", fontSize: 11 },
  style: { stroke: "#7c8db5", strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 18,
    height: 18,
    color: "#7c8db5",
  },
};

let tmpCounter = 0;
const nextTmpId = () => `tmp-${++tmpCounter}-${Math.random().toString(36).slice(2, 8)}`;

function CanvasInner({
  projectId,
  onOpenSandboxes,
}: {
  projectId: string;
  onOpenSandboxes?: () => void;
}) {
  const theme = useResolvedTheme();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [logsOpen, setLogsOpen] = useState(false);
  const logsPanelRef = usePanelRef();
  useEffect(() => {
    if (logsOpen) logsPanelRef.current?.expand();
    else logsPanelRef.current?.collapse();
  }, [logsOpen, logsPanelRef]);
  // Refit whenever the canvas viewport changes size — dragging the sidebar or
  // opening the logs would otherwise leave the graph off-centre and cramped.
  const flowWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = flowWrapRef.current;
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitView]);

  const stackQuery = useQuery({
    queryKey: ["project-stack", projectId],
    queryFn: () => getStack(projectId),
  });

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
  });
  const repositories = useMemo(
    () => projectQuery.data?.repositories ?? [],
    [projectQuery.data]
  );

  const detectionsQuery = useQuery({
    queryKey: ["stack-detections", projectId],
    queryFn: () => detectAllRepositories(projectId),
    enabled: repositories.length > 0,
    staleTime: 60_000,
  });
  const detections = useMemo(
    () => detectionsQuery.data ?? {},
    [detectionsQuery.data]
  );

  const statusQuery = useQuery({
    queryKey: ["stack-status", projectId],
    queryFn: () => getStackStatus(projectId),
    refetchInterval: (q) => (q.state.data?.running ? 3000 : 10_000),
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;

  // A canvas needs width to be a canvas; below lg it becomes a read-only list.
  const narrow = useBelowBreakpoint(LG_BREAKPOINT);

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [rightPanel, setRightPanel] = useState<
    "inspector" | "assistant" | "propose" | null
  >(
    null
  );

  // ReactFlow re-emits selection on rerenders — only react to real changes,
  // otherwise the inspector steals the panel back from the assistant.
  const handleSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: Node[] }) => {
      const id = sel[0]?.id ?? null;
      if (id === selectedIdRef.current) return;
      selectedIdRef.current = id;
      setSelectedId(id);
      setRightPanel((p) => (id ? "inspector" : p === "inspector" ? null : p));
    },
    []
  );

  // Rebuild canvas from server state (initial load + after save) — state
  // adjustment during render keyed on the query result reference.
  const [loadedGraph, setLoadedGraph] = useState<StackGraph | null>(null);
  if (stackQuery.data && stackQuery.data !== loadedGraph) {
    setLoadedGraph(stackQuery.data);
    setNodes(stackQuery.data.nodes.map((n) => dtoToNode(n, detections)));
    setEdges(
      stackQuery.data.edges.map((e) => ({
        ...DEFAULT_EDGE_OPTIONS,
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
      }))
    );
    setDirty(false);
  }

  // Merge fresh detections + live status into node data
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const detection =
          n.data.detection ??
          (n.data.repositoryId ? detections[n.data.repositoryId] ?? null : null);
        const liveState = liveStateFor(n.data, status);
        if (detection === n.data.detection && liveState === n.data.liveState) {
          return n;
        }
        return { ...n, data: { ...n.data, detection, liveState } };
      })
    );
  }, [detections, status, setNodes]);

  const onCanvasRepoIds = useMemo(
    () =>
      new Set(
        nodes
          .map((n) => n.data.repositoryId)
          .filter((id): id is string => !!id)
      ),
    [nodes]
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      saveStack(projectId, {
        nodes: nodesToInputs(nodes),
        edges: edges.map((e) => ({ sourceId: e.source, targetId: e.target })),
      }),
    onSuccess: () => {
      toast({ title: "Stack saved" });
      selectedIdRef.current = null;
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["project-stack", projectId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const detectMutation = useMutation({
    mutationFn: (repositoryId: string) =>
      detectRepository(projectId, repositoryId),
    onSuccess: (result, repositoryId) => {
      qc.setQueryData(
        ["stack-detections", projectId],
        (prev: Record<string, DetectionResult> | undefined) => ({
          ...(prev ?? {}),
          [repositoryId]: result,
        })
      );
      setNodes((nds) =>
        nds.map((n) =>
          n.data.repositoryId === repositoryId
            ? { ...n, data: { ...n.data, detection: result } }
            : n
        )
      );
    },
    onError: (err: Error) =>
      toast({
        title: "Detection failed",
        description: err.message,
        variant: "destructive",
      }),
  });

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      setEdges((eds) =>
        addEdge(
          {
            ...DEFAULT_EDGE_OPTIONS,
            ...conn,
            id: `tmp-edge-${conn.source}-${conn.target}`,
          },
          eds
        )
      );
      setDirty(true);
    },
    [setEdges]
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      if (
        changes.some(
          (c) =>
            c.type === "remove" ||
            (c.type === "position" && c.dragging === false)
        )
      ) {
        setDirty(true);
      }
    },
    [onNodesChange]
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type === "remove" || c.type === "add")) {
        setDirty(true);
      }
    },
    [onEdgesChange]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData(STACK_DRAG_MIME);
      if (!raw) return;
      const payload = JSON.parse(raw) as StackDragPayload;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      let data: CanvasNodeData;
      if (payload.kind === "repo") {
        if (onCanvasRepoIds.has(payload.repositoryId)) return;
        const detection = detections[payload.repositoryId] ?? null;
        const hasDockerfile = detection?.hasDockerfile ?? false;
        data = {
          id: nextTmpId(),
          kind: "repo",
          repositoryId: payload.repositoryId,
          name: payload.name,
          runMode: hasDockerfile ? "docker" : "local",
          // Derived server-side from the columns on save.
          phases: null,
          image: null,
          dockerfile: detection?.dockerfilePath ?? null,
          buildContext: null,
          command: null,
          installCommand: detection?.suggestedCommands.install ?? null,
          buildCommand: detection?.suggestedCommands.build ?? null,
          localCommand: detection?.suggestedCommands.dev ?? null,
          stopCommand: null,
          managesServices: false,
          workdir: null,
          ports: null,
          env: null,
          volumes: null,
          detection,
          posX: position.x,
          posY: position.y,
          label: payload.name,
        };
      } else {
        const def = SERVICE_CATALOG.find((s) => s.key === payload.serviceKey);
        if (!def) return;
        data = {
          id: nextTmpId(),
          kind: "service",
          repositoryId: null,
          name: def.name,
          runMode: "docker",
          // Derived server-side from the columns on save.
          phases: null,
          image: def.image,
          dockerfile: null,
          buildContext: null,
          command: SERVICE_COMMANDS[def.key] ?? null,
          installCommand: null,
          buildCommand: null,
          localCommand: null,
          stopCommand: null,
          managesServices: false,
          workdir: null,
          ports: def.ports,
          env: def.env,
          volumes: def.volumes,
          detection: null,
          posX: position.x,
          posY: position.y,
          label: def.name,
        };
      }

      setNodes((nds) =>
        nds.concat({
          id: data.id,
          type: data.kind,
          position,
          data,
        })
      );
      selectedIdRef.current = data.id;
      setSelectedId(data.id);
      setRightPanel("inspector");
      setDirty(true);
    },
    [screenToFlowPosition, onCanvasRepoIds, detections, setNodes]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  const patchSelected = useCallback(
    (patch: Partial<StackNodeInput>) => {
      if (!selectedId) return;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...patch,
                  label: patch.name ?? n.data.name,
                },
              }
            : n
        )
      );
      setDirty(true);
    },
    [selectedId, setNodes]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) =>
      eds.filter((e) => e.source !== selectedId && e.target !== selectedId)
    );
    selectedIdRef.current = null;
    setSelectedId(null);
    setDirty(true);
  }, [selectedId, setNodes, setEdges]);

  // Apply an assistant suggestion to the canvas. Returns false when the
  // target can't be resolved (stale nodeId/repositoryId).
  const applySuggestion = useCallback(
    (s: StackSuggestion): boolean => {
      const freePosition = () => ({
        x: 120 + (nodes.length % 5) * 60,
        y: 120 + nodes.length * 40,
      });

      /**
       * Draw the arrows a suggestion asked for.
       *
       * Runs inside setEdges so it sees nodes added earlier in this same
       * apply — "create postgres" and "the api depends on it" usually arrive
       * as one reply, and the target's id does not exist until the first half
       * has run.
       *
       * A name that matches nothing is skipped silently: the agent naming a
       * service the user never accepted is a wrong arrow, and drawing it
       * would put a dependency on the canvas that nobody asked for.
       */
      const linkDependencies = (sourceId: string, names?: string[]) => {
        if (!names?.length) return;
        setNodes((currentNodes) => {
          setEdges((eds) => {
            // Resolve by every name the same node answers to. The agent is
            // told to use catalog keys ("postgres"), while the node it just
            // created carries the catalog's display name ("PostgreSQL") — so
            // matching the visible name alone drops exactly the arrow the
            // agent was most confident about.
            const byName = new Map<string, string>();
            for (const n of currentNodes) {
              const alias = (v?: string | null) => {
                if (!v) return;
                const k = v.toLowerCase();
                if (!byName.has(k)) byName.set(k, n.id);
              };
              alias(n.data.name);
              const fromCatalog = SERVICE_CATALOG.find(
                (d) => d.name === n.data.name || d.image === n.data.image,
              );
              alias(fromCatalog?.key);
              // "postgres:17" → "postgres", for a raw image with no catalog
              // entry.
              alias(n.data.image?.split(":")[0]?.split("/").pop());
            }
            let next = eds;
            for (const name of names) {
              const targetId = byName.get(name.trim().toLowerCase());
              // Never a self-edge: a cycle of one is a validation error the
              // user would have to undo by hand.
              if (!targetId || targetId === sourceId) continue;
              if (
                next.some((e) => e.source === sourceId && e.target === targetId)
              ) {
                continue;
              }
              next = next.concat({
                ...DEFAULT_EDGE_OPTIONS,
                id: `tmp-edge-${sourceId}-${targetId}`,
                source: sourceId,
                target: targetId,
              });
            }
            return next;
          });
          return currentNodes;
        });
      };

      if (s.createService) {
        const def = s.createService.catalogKey
          ? SERVICE_CATALOG.find((d) => d.key === s.createService!.catalogKey)
          : undefined;
        if (!def && !s.createService.image) {
          toast({ title: "Unknown service in suggestion", variant: "destructive" });
          return false;
        }
        const position = freePosition();
        const data: CanvasNodeData = {
          id: nextTmpId(),
          kind: "service",
          repositoryId: null,
          name: s.createService.name ?? def?.name ?? s.createService.image!,
          runMode: "docker",
          // Derived server-side from the columns on save.
          phases: null,
          image: s.patch?.image ?? def?.image ?? s.createService.image ?? null,
          dockerfile: null,
          buildContext: null,
          command:
            s.patch?.command ??
            (def ? SERVICE_COMMANDS[def.key] ?? null : null),
          installCommand: null,
          buildCommand: null,
          localCommand: null,
          stopCommand: null,
          managesServices: false,
          workdir: null,
          ports: s.patch?.ports ?? def?.ports ?? null,
          env: s.patch?.env ?? def?.env ?? null,
          volumes: s.patch?.volumes ?? def?.volumes ?? null,
          detection: null,
          posX: position.x,
          posY: position.y,
          label: s.createService.name ?? def?.name ?? s.createService.image!,
        };
        setNodes((nds) =>
          nds.concat({ id: data.id, type: "service", position, data })
        );
        linkDependencies(data.id, s.dependsOn);
        setDirty(true);
        return true;
      }

      // Patch an existing node (by nodeId or repositoryId)...
      //
      // `createNode` opts out: a repository can hold several runnable units —
      // an API and a queue worker in one checkout — and without it a second
      // suggestion for the same repo silently patches the first instead of
      // adding the second, so the node you asked for goes missing.
      const target = s.createNode
        ? undefined
        : nodes.find(
            (n) =>
              (s.nodeId && n.id === s.nodeId) ||
              (s.repositoryId && n.data.repositoryId === s.repositoryId)
          );
      if (target) {
        // A suggestion may carry only edges: "the api needs the database" is
        // a complete thought with nothing to patch.
        if (s.patch) {
          setNodes((nds) =>
            nds.map((n) =>
              n.id === target.id ? { ...n, data: { ...n.data, ...s.patch } } : n
            )
          );
          setDirty(true);
        }
        linkDependencies(target.id, s.dependsOn);
        if (s.dependsOn?.length) setDirty(true);
        return true;
      }

      // ...or create a repo node when the repo isn't on the canvas yet.
      if (s.repositoryId) {
        const repo = repositories.find((r) => r.id === s.repositoryId);
        if (!repo) {
          toast({ title: "Repository not found", variant: "destructive" });
          return false;
        }
        const detection = detections[repo.id] ?? null;
        const position = freePosition();
        const data: CanvasNodeData = {
          id: nextTmpId(),
          kind: "repo",
          repositoryId: repo.id,
          // The unit's own name when the suggestion names one, so two nodes
          // from one repo are distinguishable on the canvas.
          name: s.createNode?.name ?? repo.name,
          runMode:
            s.patch?.runMode ?? (detection?.hasDockerfile ? "docker" : "local"),
          // Derived server-side from the columns on save.
          phases: null,
          image: null,
          dockerfile: s.patch?.dockerfile ?? detection?.dockerfilePath ?? null,
          buildContext: s.patch?.buildContext ?? null,
          command: s.patch?.command ?? null,
          installCommand:
            s.patch?.installCommand ??
            detection?.suggestedCommands.install ??
            null,
          buildCommand:
            s.patch?.buildCommand ?? detection?.suggestedCommands.build ?? null,
          localCommand:
            s.patch?.localCommand ?? detection?.suggestedCommands.dev ?? null,
          stopCommand: s.patch?.stopCommand ?? null,
          managesServices: s.patch?.managesServices ?? false,
          workdir: s.patch?.workdir ?? s.createNode?.workdir ?? null,
          ports: s.patch?.ports ?? null,
          env: s.patch?.env ?? null,
          volumes: s.patch?.volumes ?? null,
          detection,
          posX: position.x,
          posY: position.y,
          label: repo.name,
        };
        setNodes((nds) =>
          nds.concat({ id: data.id, type: "repo", position, data })
        );
        linkDependencies(data.id, s.dependsOn);
        setDirty(true);
        return true;
      }

      toast({
        title: "Suggestion targets a node that no longer exists",
        variant: "destructive",
      });
      return false;
    },
    [nodes, repositories, detections, setNodes, setEdges, toast]
  );

  if (stackQuery.isLoading || projectQuery.isLoading) {
    return (
      <div className="flex h-[600px] items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading stack...
      </div>
    );
  }

  if (stackQuery.isError || projectQuery.isError) {
    return (
      <div className="flex h-[600px] items-center justify-center text-destructive">
        <AlertCircle className="h-4 w-4 mr-2" />
        Failed to load stack.
      </div>
    );
  }

  return (
    <div className="space-y-3 mt-4">
      <StackToolbar
        projectId={projectId}
        dirty={dirty}
        saving={saveMutation.isPending}
        onSave={() => saveMutation.mutateAsync()}
        status={status}
        onStatusChanged={() => statusQuery.refetch()}
        assistantOpen={rightPanel === "assistant"}
        proposeOpen={rightPanel === "propose"}
        onTogglePropose={() =>
          setRightPanel((p) => (p === "propose" ? null : "propose"))
        }
        onToggleAssistant={() =>
          setRightPanel((p) => (p === "assistant" ? null : "assistant"))
        }
      />
      {/* Below lg the canvas is 180px of viewport — a node graph nobody can
          read, for an interaction (dragging) a phone does not offer. The list
          answers what the canvas is for on a small screen: what is in this
          stack and what depends on what. */}
      {narrow ? (
        <div className="rounded-lg border bg-background p-3">
          <StackNodeList
            nodes={stackQuery.data?.nodes ?? []}
            edges={stackQuery.data?.edges ?? []}
          />
        </div>
      ) : (
      <ResizableGroup
        orientation="vertical"
        persistId="stack-shell"
        className="h-[calc(100vh-240px)] min-h-[560px] rounded-lg border bg-background overflow-hidden"
      >
        <ResizablePanel id="board" minSize="30%">
        <ResizableGroup persistId="stack-canvas" className="h-full">
          <ResizablePanel id="palette" defaultSize="15rem" minSize="8rem" maxSize="40%">
            <StackSidebar
              repositories={repositories}
              detections={detections}
              onCanvasRepoIds={onCanvasRepoIds}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="flow"
            minSize="20%"
            elementRef={flowWrapRef}
            onDrop={onDrop}
            onDragOver={onDragOver}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={stackNodeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onSelectionChange={handleSelectionChange}
              // Follows the page: pinned to dark, a light theme got light node text on
              // white cards (the nodes are bg-card, React Flow colours the text).
              colorMode={theme}
              fitView
              // Default fitView caps at zoom 1, so a two-node stack sits tiny
              // in the middle of the canvas. Let it scale up and keep a small
              // margin instead.
              fitViewOptions={FIT_VIEW_OPTIONS}
              minZoom={0.15}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
              deleteKeyCode={["Backspace", "Delete"]}
            >
              <Background gap={16} />
              <Controls />
              {/* The default minimap eats a third of a narrow canvas. */}
              <MiniMap
                pannable
                zoomable
                maskColor={theme === "dark" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.12)"}
                nodeColor={(n) => (n.type === "repo" ? "#3b82f6" : "#a855f7")}
                className="!m-2 !h-20 !w-32 rounded-md border border-border/60 !bg-background/80"
              />
              {stackQuery.isSuccess && nodes.length === 0 && (
                <Panel position="top-center" className="pointer-events-none mt-16">
                  <div className="max-w-sm rounded-lg border border-border/60 bg-background/90 p-4 text-center shadow-lg backdrop-blur">
                    <p className="text-sm font-medium">Your stack is empty</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Drag a repository or a service (PostgreSQL, Redis, …)
                      from the sidebar. Services defined here run locally with{" "}
                      <span className="font-medium">Run stack</span> and are
                      provisioned automatically into every sandbox.
                    </p>
                    {onOpenSandboxes && (
                      <button
                        type="button"
                        onClick={onOpenSandboxes}
                        className="pointer-events-auto mt-2 text-xs underline underline-offset-2 text-sky-400 hover:text-sky-300"
                      >
                        Configure sandboxes →
                      </button>
                    )}
                  </div>
                </Panel>
              )}
            </ReactFlow>
          </ResizablePanel>
        </ResizableGroup>
        </ResizablePanel>
        {logsOpen && <ResizableHandle direction="vertical" />}
        {/* Collapsing the logs shrinks the panel to its header bar; expanding
            restores the last dragged height. */}
        <ResizablePanel
          id="logs"
          panelRef={logsPanelRef}
          collapsible
          collapsedSize="2.25rem"
          defaultSize="14rem"
          minSize="6rem"
          maxSize="70%"
          disabled={!logsOpen}
        >
          <StackLogsPanel
            projectId={projectId}
            active={running}
            onOpenChange={setLogsOpen}
          />
        </ResizablePanel>
      </ResizableGroup>
      )}

      {/* Outside the split: a chat about the canvas should not take width from
          the canvas you are describing to it. FloatingPanel lets the user dock
          it beside the board when a conversation gets long enough to want a
          column of its own. */}
      {rightPanel === "propose" ? (
        <FloatingPanel
          id="stack-propose"
          title="What do you need?"
          icon={<Sparkles className="h-4 w-4 shrink-0 text-primary" />}
          onClose={() => setRightPanel(null)}
        >
          <StackProposalPanel
            projectId={projectId}
            onApplySuggestion={applySuggestion}
          />
        </FloatingPanel>
      ) : null}

      {/* The inspector floats for a sharper reason than the chat does: as a
          panel in the split it took its width from the canvas, so *selecting*
          a node resized the board and slid that node out from under the
          pointer — which made dragging feel broken, because the thing you had
          just grabbed had moved. Floating, a click changes nothing but the
          selection. */}
      {rightPanel === "inspector" && selectedNode ? (
        <FloatingPanel
          id="stack-inspector"
          title={selectedNode.data.name || "Node"}
          icon={<SlidersHorizontal className="h-4 w-4 shrink-0 text-primary" />}
          onClose={() => {
            selectedIdRef.current = null;
            setSelectedId(null);
            setRightPanel(null);
          }}
        >
          <StackInspector
            projectId={projectId}
            node={{
              ...selectedNode.data,
              posX: selectedNode.position.x,
              posY: selectedNode.position.y,
            }}
            onChange={patchSelected}
            onDelete={deleteSelected}
            onRedetect={() => {
              if (selectedNode.data.repositoryId) {
                detectMutation.mutate(selectedNode.data.repositoryId);
              }
            }}
            detecting={detectMutation.isPending}
          />
        </FloatingPanel>
      ) : null}

      {rightPanel === "assistant" ? (
        <FloatingPanel
          id="stack-assistant"
          title="Stack assistant"
          icon={<Sparkles className="h-4 w-4 shrink-0 text-primary" />}
          onClose={() => setRightPanel(null)}
        >
          <StackAssistantPanel
            projectId={projectId}
            onApplySuggestion={applySuggestion}
          />
        </FloatingPanel>
      ) : null}
    </div>
  );
}

export function StackCanvas({
  projectId,
  onOpenSandboxes,
}: {
  projectId: string;
  onOpenSandboxes?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} onOpenSandboxes={onOpenSandboxes} />
    </ReactFlowProvider>
  );
}
