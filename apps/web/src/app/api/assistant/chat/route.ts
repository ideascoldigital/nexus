/**
 * POST /api/assistant/chat
 *
 * Chat with the AI assistant. Supports 5 types:
 *  - agent / skill / code: single-agent flows from agents-generator service
 *  - project-definer: orchestrator + specialists, requires projectId
 *  - stack-assistant: tool-calling stack advisor, requires projectId
 */

import { NextRequest, NextResponse } from 'next/server';
import { runAgent } from '@/services/agents-generator';
import {
  runDefinerTurn,
  initDefinerForProject,
  persistDefinerTurn,
} from '@/services/project-definer-agents';
import {
  initStackAssistant,
  runStackAssistantTurn,
  persistStackAssistantTurn,
} from '@/services/stack-assistant-agent';
import type { InlineMessage } from '@ideascol/agents-generator-sdk';

const SINGLE_TYPES = ['agent', 'skill', 'code'] as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, message, history, projectId } = body;

    if (!type || ![...SINGLE_TYPES, 'project-definer', 'stack-assistant'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid type. Must be: agent, skill, code, project-definer, or stack-assistant' },
        { status: 400 }
      );
    }

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    const formattedHistory: InlineMessage[] = (history || []).map(
      (msg: { role: string; content: string }) => ({
        role: msg.role,
        content: msg.content,
      } as InlineMessage)
    );

    if (type === 'project-definer') {
      if (!projectId || typeof projectId !== 'string') {
        return NextResponse.json(
          { error: 'projectId required for project-definer' },
          { status: 400 }
        );
      }

      const init = await initDefinerForProject(projectId);
      const turn = await runDefinerTurn(message, formattedHistory);
      const persisted = await persistDefinerTurn(
        init.conversationId,
        init.documentId,
        message,
        turn
      );

      return NextResponse.json({
        type: 'project-definer',
        transfers: turn.transfers,
        finalRole: turn.finalRole,
        messages: persisted.messages,
        documentId: init.documentId,
        conversationId: init.conversationId,
      });
    }

    if (type === 'stack-assistant') {
      if (!projectId || typeof projectId !== 'string') {
        return NextResponse.json(
          { error: 'projectId required for stack-assistant' },
          { status: 400 }
        );
      }

      const conversation = await initStackAssistant(projectId);
      const turn = await runStackAssistantTurn(projectId, message, formattedHistory);
      await persistStackAssistantTurn(conversation.id, message, turn);

      return NextResponse.json({
        type: 'stack-assistant',
        message: turn.message,
        suggestions: turn.suggestions,
        toolCalls: turn.toolCalls,
        conversationId: conversation.id,
      });
    }

    const result = await runAgent(
      type as 'agent' | 'skill' | 'code',
      message,
      formattedHistory
    );

    return NextResponse.json({
      message: result.message,
      message_id: result.message_id,
      tool_results: result.tool_results,
    });
  } catch (error: unknown) {
    console.error('Assistant chat error:', error);
    const msg = error instanceof Error ? error.message : String(error);

    if (msg.includes('OpenAI API key not configured')) {
      return NextResponse.json(
        {
          error: 'OpenAI API key not configured',
          details: 'Please add your OpenAI API key in Settings before using the assistant.'
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to chat with assistant', details: msg },
      { status: 500 }
    );
  }
}
