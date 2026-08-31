"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getConversation } from "@/services/conversations";
import { RealTerminal } from "@/components/terminal/real-terminal";
import { AppHeader } from "@/components/layout/app-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function ConversationPage() {
  const params = useParams<{ projectId: string; conversationId: string }>();

  const { data: conversation, isLoading } = useQuery({
    queryKey: ["conversation", params.projectId, params.conversationId],
    queryFn: () => getConversation(params.projectId, params.conversationId),
  });

  if (isLoading) {
    return (
      <>
        <AppHeader title="Loading..." />
        <div className="flex-1 flex items-center justify-center">
          <Skeleton className="h-8 w-48" />
        </div>
      </>
    );
  }

  if (!conversation) {
    return (
      <>
        <AppHeader title="Not Found" />
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Conversation not found
        </div>
      </>
    );
  }

  return (
    <>
      <AppHeader
        title={
          conversation.name ||
          `Conversation ${conversation.sessionId.slice(0, 8)}`
        }
      />
      <div className="flex-1 min-h-0">
        <RealTerminal workingDirectory={conversation.project.repositories[0]?.localPath || undefined} />
      </div>
    </>
  );
}
