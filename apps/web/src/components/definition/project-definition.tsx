"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPhases } from "@/services/definition";
import { PhaseNavigator } from "./phase-navigator";
import { DocumentViewer } from "./document-viewer";
import { MultiRoleChat } from "./multi-role-chat";

export function ProjectDefinition({ projectId }: { projectId: string }) {
  const [explicitPhase, setExplicitPhase] = useState<string | null>(null);

  const { data: phases } = useQuery({
    queryKey: ["definer-phases", projectId],
    queryFn: () => getPhases(projectId),
  });

  const activePhase = phases?.find((p) => p.status === "active") ?? phases?.[0];
  const selectedPhaseKey = explicitPhase ?? activePhase?.key ?? null;

  return (
    <div className="mt-4 grid grid-cols-12 gap-4 h-[calc(100vh-220px)] min-h-[600px]">
      <div className="col-span-12 lg:col-span-3 min-h-0 overflow-auto">
        <PhaseNavigator
          projectId={projectId}
          selectedPhaseKey={selectedPhaseKey}
          onSelectPhase={setExplicitPhase}
        />
      </div>
      <div className="col-span-12 lg:col-span-5 min-h-0 overflow-auto">
        <DocumentViewer projectId={projectId} selectedPhaseKey={selectedPhaseKey} />
      </div>
      <div className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
        <MultiRoleChat projectId={projectId} />
      </div>
    </div>
  );
}
