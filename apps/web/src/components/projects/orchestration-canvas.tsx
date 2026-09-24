"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles,
Loader2,
  AlertCircle,
  Search,
  GripVertical,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { LG_BREAKPOINT, useBelowBreakpoint } from "@/hooks/use-breakpoint";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getProjectOrchestration,
  updateProjectOrchestration,
  type OrchestrationData,
} from "@/services/projects";
import { getAgents, syncAgents, type AgentWithCount } from "@/services/agents";
import { SkillRecommendationsDialog } from "@/components/projects/skill-recommendations-dialog";
import {
  getSkills,
  syncSkills,
  updateProjectAgents,
  updateProjectSkills,
  type SkillWithCount,
} from "@/services/skills";

type AgentNodeData = {
  label: string;
  color: string;
  model: string;
  /** Remove from canvas AND detach from the project. */
  onRemove?: () => void;
};

type SkillNodeData = {
  label: string;
  source: string;
  description?: string | null;
  /** Remove from canvas AND detach from the project. */
  onRemove?: () => void;
};

function NodeRemoveButton({ onRemove }: { onRemove?: () => void }) {
  if (!onRemove) return null;
  return (
    <button
      type="button"
      // nodrag: keep the click from starting a canvas drag.
      className="nodrag absolute -top-2 -right-2 flex h-4.5 w-4.5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-destructive hover:border-destructive/50 group-hover:opacity-100"
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      title="Remove from project"
    >
      <X className="h-2.5 w-2.5" />
    </button>
  );
}

const DRAG_MIME = "application/x-nexux-orchestration";

type DragPayload =
  | { kind: "agent"; id: string; name: string; color: string; model: string }
  | {
      kind: "skill";
      id: string;
      name: string;
      source: string;
      description?: string | null;
    };

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  return (
    <div
      className="group relative rounded-md border bg-card px-3 py-2 shadow-sm min-w-[180px]"
      style={{ borderLeft: `4px solid ${data.color}` }}
    >
      <NodeRemoveButton onRemove={data.onRemove} />
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: data.color }}
        />
        <span className="text-sm font-medium">{data.label}</span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground uppercase tracking-wide">
        {data.model}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !bg-foreground/40"
      />
    </div>
  );
}

function SkillNode({ data }: NodeProps<Node<SkillNodeData>>) {
  return (
    <div className="group relative rounded-md border bg-card px-3 py-2 shadow-sm min-w-[180px]">
      <NodeRemoveButton onRemove={data.onRemove} />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !bg-foreground/40"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{data.label}</span>
        <Badge variant="outline" className="text-[10px]">
          {data.source}
        </Badge>
      </div>
      {data.description ? (
        <div className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
          {data.description}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = { agent: AgentNode, skill: SkillNode };

const COL_AGENT_X = 40;
const COL_SKILL_X = 480;
const ROW_HEIGHT = 110;

function buildNodes(data: OrchestrationData): Node[] {
  const agentNodes: Node[] = data.agents.map((a, i) => ({
    id: `agent:${a.id}`,
    type: "agent",
    position: { x: COL_AGENT_X, y: 40 + i * ROW_HEIGHT },
    data: { label: a.name, color: a.color, model: a.model },
  }));
  const skillNodes: Node[] = data.skills.map((s, i) => ({
    id: `skill:${s.id}`,
    type: "skill",
    position: { x: COL_SKILL_X, y: 40 + i * ROW_HEIGHT },
    data: { label: s.name, source: s.source, description: s.description },
  }));
  return [...agentNodes, ...skillNodes];
}

function buildEdges(data: OrchestrationData): Edge[] {
  return data.edges.map((e) => ({
    id: e.id,
    source: `agent:${e.agentId}`,
    target: `skill:${e.skillId}`,
    animated: e.scope === "global",
    style: e.scope === "global" ? { strokeDasharray: "4 4" } : undefined,
    data: { scope: e.scope },
  }));
}

function edgesToPayload(
  edges: Edge[]
): { agentId: string; skillId: string }[] {
  return edges
    .filter((e) => (e.data as { scope?: string } | undefined)?.scope !== "global")
    .map((e) => ({
      agentId: e.source.replace(/^agent:/, ""),
      skillId: e.target.replace(/^skill:/, ""),
    }));
}

type CatalogProps = {
  agents: AgentWithCount[];
  skills: SkillWithCount[];
  attachedAgentIds: Set<string>;
  attachedSkillIds: Set<string>;
  onSyncAgents: () => void;
  onSyncSkills: () => void;
  onRecommend: (kind: "skills" | "agents") => void;
  syncing: boolean;
};

function CatalogSidebar({
  agents,
  skills,
  attachedAgentIds,
  attachedSkillIds,
  onSyncAgents,
  onSyncSkills,
  onRecommend,
  syncing,
}: CatalogProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"agents" | "skills">("agents");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const sources = useMemo(() => {
    const s = new Set<string>();
    skills.forEach((sk) => s.add(sk.source));
    return ["all", ...Array.from(s).sort()];
  }, [skills]);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) =>
      q ? a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q) : true
    );
  }, [agents, query]);

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [skills, query, sourceFilter]);

  const onDragStart = (e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col gap-2 border-r bg-card/40 p-3">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={tab === "agents" ? "default" : "outline"}
          className="flex-1 h-7 text-xs"
          onClick={() => setTab("agents")}
        >
          Agents ({agents.length})
        </Button>
        <Button
          size="sm"
          variant={tab === "skills" ? "default" : "outline"}
          className="flex-1 h-7 text-xs"
          onClick={() => setTab("skills")}
        >
          Skills ({skills.length})
        </Button>
      </div>

      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 border-primary/40 text-xs text-primary hover:text-primary"
        onClick={() => onRecommend(tab)}
        title="AI-rank the best fits for this project from its definition, dependencies and stack"
      >
        <Sparkles className="h-3 w-3" />
        {tab === "skills" ? "Recommend skills" : "Recommend agents"}
      </Button>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search..."
          className="h-7 pl-7 text-xs"
        />
      </div>

      {tab === "skills" ? (
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                sourceFilter === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto -mx-1 px-1 space-y-1">
        {tab === "agents"
          ? filteredAgents.map((a) => {
              const attached = attachedAgentIds.has(a.id);
              return (
                <div
                  key={a.id}
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, {
                      kind: "agent",
                      id: a.id,
                      name: a.name,
                      color: a.color,
                      model: a.model,
                    })
                  }
                  className={`group flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs cursor-grab active:cursor-grabbing ${
                    attached ? "opacity-50" : "hover:border-primary/60"
                  }`}
                  title={a.description ?? a.name}
                >
                  <GripVertical className="h-3 w-3 text-muted-foreground" />
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="truncate flex-1">{a.name}</span>
                  {attached ? (
                    <Badge variant="outline" className="text-[9px]">on</Badge>
                  ) : null}
                </div>
              );
            })
          : filteredSkills.map((s) => {
              const attached = attachedSkillIds.has(s.id);
              return (
                <div
                  key={s.id}
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, {
                      kind: "skill",
                      id: s.id,
                      name: s.name,
                      source: s.source,
                      description: s.description,
                    })
                  }
                  className={`group flex flex-col gap-0.5 rounded-md border bg-background px-2 py-1.5 text-xs cursor-grab active:cursor-grabbing ${
                    attached ? "opacity-50" : "hover:border-primary/60"
                  }`}
                  title={s.description ?? s.name}
                >
                  <div className="flex items-center gap-2">
                    <GripVertical className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate flex-1 font-medium">{s.name}</span>
                    <Badge variant="outline" className="text-[9px]">
                      {s.source}
                    </Badge>
                    {attached ? (
                      <Badge variant="outline" className="text-[9px]">on</Badge>
                    ) : null}
                  </div>
                  {s.description ? (
                    <span className="text-[10px] text-muted-foreground line-clamp-2 ml-5">
                      {s.description}
                    </span>
                  ) : null}
                </div>
              );
            })}
        {(tab === "agents" ? filteredAgents.length : filteredSkills.length) === 0 ? (
          <div className="text-[11px] text-muted-foreground text-center py-4">
            No matches
          </div>
        ) : null}
      </div>

      {/* Catalog sync lived in the removed Skills & Agents tab — kept here. */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={syncing}
        onClick={tab === "agents" ? onSyncAgents : onSyncSkills}
        title="Import built-in and on-disk catalog entries"
      >
        {syncing ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : null}
        Sync {tab} catalog
      </Button>
    </div>
  );
}

function CanvasInner({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["project-orchestration", projectId],
    queryFn: () => getProjectOrchestration(projectId),
  });

  const { data: catalogAgents = [] } = useQuery({
    queryKey: ["catalog-agents"],
    queryFn: getAgents,
  });

  const { data: catalogSkills = [] } = useQuery({
    queryKey: ["catalog-skills"],
    queryFn: getSkills,
  });

  // Below lg the canvas is a strip of dots — the graph is unreadable and
  // dragging, which is the point of it, is not what a phone offers.
  const narrow = useBelowBreakpoint(LG_BREAKPOINT);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [dirty, setDirty] = useState(false);

  // Stable indirection so injecting onRemove into node data doesn't retrigger
  // this effect (the mutation object changes identity every render).
  const removeNodeRef = useRef<(nodeId: string) => void>(() => {});

  useEffect(() => {
    if (!data) return;
    setNodes(
      buildNodes(data).map((n) => ({
        ...n,
        data: { ...n.data, onRemove: () => removeNodeRef.current(n.id) },
      })),
    );
    setEdges(buildEdges(data));
    setDirty(false);
  }, [data, setNodes, setEdges]);

  const [recommendKind, setRecommendKind] = useState<"skills" | "agents" | null>(null);

  const attachedAgentIds = useMemo(
    () => new Set(data?.agents.map((a) => a.id) ?? []),
    [data]
  );
  const attachedSkillIds = useMemo(
    () => new Set(data?.skills.map((s) => s.id) ?? []),
    [data]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source?.startsWith("agent:")) return;
      if (!conn.target?.startsWith("skill:")) return;
      setEdges((eds) =>
        addEdge(
          {
            ...conn,
            id: `new-${conn.source}-${conn.target}-${Date.now()}`,
            data: { scope: "project" },
          },
          eds
        )
      );
      setDirty(true);
    },
    [setEdges]
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

  const saveMutation = useMutation({
    mutationFn: () =>
      updateProjectOrchestration(projectId, edgesToPayload(edges)),
    onSuccess: () => {
      toast({ title: "Orchestration saved" });
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["project-orchestration", projectId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const attachAgentMutation = useMutation({
    mutationFn: (agentId: string) =>
      updateProjectAgents(projectId, [
        ...Array.from(attachedAgentIds),
        agentId,
      ]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-orchestration", projectId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Attach failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const attachSkillMutation = useMutation({
    mutationFn: (skillId: string) =>
      updateProjectSkills(projectId, [
        ...Array.from(attachedSkillIds),
        skillId,
      ]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-orchestration", projectId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Attach failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Deleting a node from the canvas detaches the agent/skill from the
  // project (this was the removed Skills & Agents tab's uncheck action).
  const detachMutation = useMutation({
    mutationFn: async (removed: { agents: string[]; skills: string[] }) => {
      if (removed.agents.length > 0) {
        await updateProjectAgents(
          projectId,
          Array.from(attachedAgentIds).filter(
            (id) => !removed.agents.includes(id),
          ),
        );
      }
      if (removed.skills.length > 0) {
        await updateProjectSkills(
          projectId,
          Array.from(attachedSkillIds).filter(
            (id) => !removed.skills.includes(id),
          ),
        );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-orchestration", projectId] });
      toast({ title: "Removed from project" });
    },
    onError: (err: Error) => {
      toast({
        title: "Detach failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const removed = {
        agents: deleted
          .filter((n) => n.id.startsWith("agent:"))
          .map((n) => n.id.slice("agent:".length)),
        skills: deleted
          .filter((n) => n.id.startsWith("skill:"))
          .map((n) => n.id.slice("skill:".length)),
      };
      if (removed.agents.length > 0 || removed.skills.length > 0) {
        detachMutation.mutate(removed);
      }
    },
    [detachMutation],
  );

  // Per-node ✕ button: drop it from the canvas and detach it — the keyboard
  // path (select + Backspace) still works, but wasn't discoverable.
  removeNodeRef.current = (nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) =>
      eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
    );
    detachMutation.mutate({
      agents: nodeId.startsWith("agent:") ? [nodeId.slice("agent:".length)] : [],
      skills: nodeId.startsWith("skill:") ? [nodeId.slice("skill:".length)] : [],
    });
  };

  const syncAgentsMutation = useMutation({
    mutationFn: syncAgents,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["catalog-agents"] });
      toast({ title: `Agents synced (${r.synced} new, ${r.total} total)` });
    },
    onError: (err: Error) =>
      toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const syncSkillsMutation = useMutation({
    mutationFn: syncSkills,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["catalog-skills"] });
      toast({ title: `Skills synced (${r.synced} new, ${r.total} total)` });
    },
    onError: (err: Error) =>
      toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      const payload = JSON.parse(raw) as DragPayload;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      if (payload.kind === "agent") {
        const nodeId = `agent:${payload.id}`;
        if (nodes.some((n) => n.id === nodeId)) return;
        setNodes((nds) =>
          nds.concat({
            id: nodeId,
            type: "agent",
            position,
            data: {
              label: payload.name,
              color: payload.color,
              model: payload.model,
              onRemove: () => removeNodeRef.current(nodeId),
            },
          })
        );
        if (!attachedAgentIds.has(payload.id)) {
          attachAgentMutation.mutate(payload.id);
        }
      } else {
        const nodeId = `skill:${payload.id}`;
        if (nodes.some((n) => n.id === nodeId)) return;
        setNodes((nds) =>
          nds.concat({
            id: nodeId,
            type: "skill",
            position,
            data: {
              label: payload.name,
              source: payload.source,
              description: payload.description,
              onRemove: () => removeNodeRef.current(nodeId),
            },
          })
        );
        if (!attachedSkillIds.has(payload.id)) {
          attachSkillMutation.mutate(payload.id);
        }
      }
    },
    [
      nodes,
      setNodes,
      screenToFlowPosition,
      attachedAgentIds,
      attachedSkillIds,
      attachAgentMutation,
      attachSkillMutation,
    ]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-[600px] items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading orchestration...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-[600px] items-center justify-center text-destructive">
        <AlertCircle className="h-4 w-4 mr-2" />
        Failed to load orchestration.
      </div>
    );
  }

  return (
    <div className="space-y-3 mt-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Drag from sidebar to canvas to add. Drag agent handle to skill to
          grant capability. Dashed = global edge.
        </div>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
        >
          {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </div>
      {narrow ? (
        <div className="rounded-lg border bg-background p-3">
          {nodes.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No agents or skills wired yet. Open this project on a larger
              screen to connect them.
            </p>
          ) : (
            <div className="space-y-2">
              {nodes.map((n) => {
                const label = String(
                  (n.data as { label?: unknown })?.label ?? n.id,
                );
                const edgeCount = edges.filter(
                  (e) => e.source === n.id || e.target === n.id,
                ).length;
                return (
                  <div
                    key={n.id}
                    className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 p-3"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {n.type}
                      {edgeCount ? ` · ${edgeCount} link${edgeCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
      <div className="flex h-[700px] rounded-lg border bg-background overflow-hidden">
        <CatalogSidebar
          onRecommend={(kind) => setRecommendKind(kind)}
          agents={catalogAgents}
          skills={catalogSkills}
          attachedAgentIds={attachedAgentIds}
          attachedSkillIds={attachedSkillIds}
          onSyncAgents={() => syncAgentsMutation.mutate()}
          onSyncSkills={() => syncSkillsMutation.mutate()}
          syncing={syncAgentsMutation.isPending || syncSkillsMutation.isPending}
        />
        <div ref={wrapperRef} className="flex-1" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodesDelete={onNodesDelete}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            colorMode="dark"
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap
              pannable
              zoomable
              maskColor="rgba(0,0,0,0.6)"
              nodeColor={(n) =>
                n.type === "agent"
                  ? ((n.data as { color?: string } | undefined)?.color ?? "#3b82f6")
                  : "#64748b"
              }
            />
          </ReactFlow>
        </div>
      </div>
      )}
      {recommendKind && (
        <SkillRecommendationsDialog
          projectId={projectId}
          kind={recommendKind}
          open={true}
          onOpenChange={(next) => {
            if (!next) setRecommendKind(null);
          }}
          attachedIds={
            recommendKind === "skills" ? attachedSkillIds : attachedAgentIds
          }
          onApplied={() => {
            qc.invalidateQueries({ queryKey: ["project-orchestration", projectId] });
          }}
        />
      )}
    </div>
  );
}

export function OrchestrationCanvas({ projectId }: { projectId: string }) {
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} />
    </ReactFlowProvider>
  );
}
