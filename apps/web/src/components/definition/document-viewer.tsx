"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

import {
  getDocument,
  updateSection,
  type ProjectDocument,
  type Section,
} from "@/services/definition";
import { RevisionDrawer } from "./revision-drawer";
import ReactMarkdown from "react-markdown";

const STATUS_CLASS: Record<string, string> = {
  empty: "bg-muted text-muted-foreground",
  draft: "bg-amber-500/15 text-amber-400",
  approved: "bg-emerald-500/15 text-emerald-400",
};

function SectionCard({
  projectId,
  section,
  onOpenHistory,
}: {
  projectId: string;
  section: Section;
  onOpenHistory: (s: Section) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.content);

  const save = useMutation({
    mutationFn: () => updateSection(projectId, section.id, draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["definer-document", projectId] });
      setEditing(false);
    },
  });

  return (
    <Card className="border-border/50">
      {/* Wraps at phone width. Unwrapped, the title competed with the status
          pill, the owner and two buttons in one row and lost: it was truncated
          to 38px — "Ov…", "Proble…" — which is the one thing in the row you
          cannot do without. */}
      <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-y-1 space-y-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Given the row's slack before the metadata beside it, so a long
              section name shortens the owner rather than itself. */}
          <CardTitle className="min-w-0 flex-1 text-sm font-medium truncate">
            {section.title}
          </CardTitle>
          <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full ${STATUS_CLASS[section.status]}`}>
            {section.status}
          </span>
          <span className="hidden truncate text-[10px] text-muted-foreground sm:inline">
            owner: {section.ownerRole}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => onOpenHistory(section)}
          >
             History
          </Button>
          {editing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => {
                  setDraft(section.content);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-[11px]"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="font-mono text-xs"
          />
        ) : section.content ? (
          <div className="prose prose-sm prose-invert max-w-none text-xs">
            <ReactMarkdown>{section.content}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            Empty — talk to the specialists or edit manually.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function DocumentViewer({
  projectId,
  selectedPhaseKey,
}: {
  projectId: string;
  selectedPhaseKey: string | null;
}) {
  const { data: doc, isLoading } = useQuery<ProjectDocument>({
    queryKey: ["definer-document", projectId],
    queryFn: () => getDocument(projectId),
  });

  const [historySection, setHistorySection] = useState<Section | null>(null);

  const sections = useMemo(() => {
    if (!doc) return [];
    const all = [...doc.sections].sort((a, b) =>
      a.phaseKey === b.phaseKey ? a.order - b.order : a.phaseKey.localeCompare(b.phaseKey)
    );
    return selectedPhaseKey ? all.filter((s) => s.phaseKey === selectedPhaseKey) : all;
  }, [doc, selectedPhaseKey]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (!doc) {
    return (
      <Card className="border-border/50">
        <CardContent className="py-12 text-center text-xs text-muted-foreground">
          Document not initialized.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {sections.length === 0 ? (
          <Card className="border-border/50">
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No sections in this phase.
            </CardContent>
          </Card>
        ) : (
          sections.map((s) => (
            <SectionCard
              key={`${s.id}:${s.content.length}:${s.status}`}
              projectId={projectId}
              section={s}
              onOpenHistory={setHistorySection}
            />
          ))
        )}
      </div>
      <RevisionDrawer
        open={Boolean(historySection)}
        onOpenChange={(next) => !next && setHistorySection(null)}
        projectId={projectId}
        sectionId={historySection?.id ?? null}
        sectionTitle={historySection?.title ?? ""}
      />
    </>
  );
}
