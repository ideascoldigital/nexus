/**
 * Client-side service wrappers for the project-definer workflow.
 */

export type PhaseStatus = 'locked' | 'active' | 'completed' | 'revisiting';
export type SectionStatus = 'empty' | 'draft' | 'approved';
export type DocumentStatus = 'draft' | 'in_review' | 'approved';

export interface Phase {
  id: string;
  projectId: string;
  key: string;
  order: number;
  status: PhaseStatus;
  title: string;
  summary: string | null;
}

export interface Section {
  id: string;
  documentId: string;
  phaseKey: string;
  key: string;
  title: string;
  content: string;
  ownerRole: string;
  order: number;
  status: SectionStatus;
}

export interface ProjectDocument {
  id: string;
  projectId: string;
  version: number;
  status: DocumentStatus;
  conversationId: string | null;
  sections: Section[];
}

export interface Revision {
  id: string;
  sectionId: string;
  content: string;
  authorRole: string;
  messageId: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  agentRole?: string;
  content: string;
  createdAt?: string;
}

export interface DefinerInitState {
  initialized: boolean;
  document: ProjectDocument | null;
  phases: Phase[];
  conversation: {
    id: string;
    messages: Array<{
      id: string;
      role: string;
      agentRole: string | null;
      content: string;
      createdAt: string;
      messageType: string;
    }>;
  } | null;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

export async function getDefinerState(projectId: string): Promise<DefinerInitState> {
  return jsonOrThrow(await fetch(`/api/projects/${projectId}/definer/init`));
}

export async function initDefiner(projectId: string) {
  return jsonOrThrow(
    await fetch(`/api/projects/${projectId}/definer/init`, { method: 'POST' })
  );
}

export async function getPhases(projectId: string): Promise<Phase[]> {
  return jsonOrThrow(await fetch(`/api/projects/${projectId}/phases`));
}

export async function setPhaseStatus(
  projectId: string,
  phaseKey: string,
  status: PhaseStatus
): Promise<Phase> {
  return jsonOrThrow(
    await fetch(`/api/projects/${projectId}/phases`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phaseKey, status }),
    })
  );
}

export async function getDocument(projectId: string): Promise<ProjectDocument> {
  return jsonOrThrow(await fetch(`/api/projects/${projectId}/document`));
}

export async function updateSection(
  projectId: string,
  sectionId: string,
  content: string,
  status?: SectionStatus
): Promise<Section> {
  return jsonOrThrow(
    await fetch(`/api/projects/${projectId}/document`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionId, content, status }),
    })
  );
}

export async function getRevisions(
  projectId: string,
  sectionId: string
): Promise<Revision[]> {
  return jsonOrThrow(
    await fetch(`/api/projects/${projectId}/document/sections/${sectionId}/revisions`)
  );
}

export async function restoreRevision(
  projectId: string,
  sectionId: string,
  revisionId: string
): Promise<Revision> {
  return jsonOrThrow(
    await fetch(`/api/projects/${projectId}/document/sections/${sectionId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revisionId }),
    })
  );
}

export interface DefinerTransfer {
  from?: string;
  to?: string;
  reason?: string;
}

export interface DefinerChatResponse {
  type: 'project-definer';
  transfers: DefinerTransfer[];
  finalRole: string;
  messages: Array<{ id: string; role: string; agentRole: string; content: string }>;
  documentId: string;
  conversationId: string;
}

export async function sendDefinerMessage(
  projectId: string,
  message: string,
  history: ChatMessage[]
): Promise<DefinerChatResponse> {
  return jsonOrThrow(
    await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'project-definer',
        message,
        history: history.map((m) => ({ role: m.role, content: m.content })),
        projectId,
      }),
    })
  );
}
