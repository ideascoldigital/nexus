"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { getRevisions, restoreRevision } from "@/services/definition";
import { formatDistanceToNow } from "date-fns";

export function RevisionDrawer({
  open,
  onOpenChange,
  projectId,
  sectionId,
  sectionTitle,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  projectId: string;
  sectionId: string | null;
  sectionTitle: string;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["definer-revisions", projectId, sectionId],
    queryFn: () => (sectionId ? getRevisions(projectId, sectionId) : Promise.resolve([])),
    enabled: open && Boolean(sectionId),
  });

  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      restoreRevision(projectId, sectionId!, revisionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["definer-document", projectId] });
      queryClient.invalidateQueries({ queryKey: ["definer-revisions", projectId, sectionId] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Revisions — {sectionTitle}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[60vh] pr-3">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !data || data.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              No revisions yet.
            </p>
          ) : (
            <div className="space-y-3">
              {data.map((rev) => (
                <div key={rev.id} className="rounded-lg border border-border/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{rev.authorRole}</span>
                      {" · "}
                      {formatDistanceToNow(new Date(rev.createdAt), { addSuffix: true })}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px]"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(rev.id)}
                    >
                      Restore
                    </Button>
                  </div>
                  <pre className="text-xs whitespace-pre-wrap font-mono bg-muted/40 rounded p-2 max-h-40 overflow-auto">
                    {rev.content || "(empty)"}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
