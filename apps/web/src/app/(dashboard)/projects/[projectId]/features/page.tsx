"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AppHeader } from "@/components/layout/app-header";
import { FeatureList } from "@/components/features/feature-list";
import { getProject } from "@/services/projects";

export default function FeaturesPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
  });

  const title = project
    ? `${project.name} / Features`
    : "Features";

  return (
    <>
      <AppHeader title={title} />
      <div className="flex-1 overflow-auto">
        <div className="w-full px-4 py-4">
          <FeatureList projectId={projectId} />
        </div>
      </div>
    </>
  );
}
