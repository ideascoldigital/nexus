import type { ClaudeStreamEvent } from "./claude";

// Client -> Server messages
export type ClientMessage =
  | { type: "send_message"; sessionId: string; content: string }
  | { type: "stop_process"; sessionId: string }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string };

// Server -> Client messages
export type ServerMessage =
  | {
      type: "claude_stream";
      sessionId: string;
      data: ClaudeStreamEvent;
    }
  | {
      type: "process_status";
      sessionId: string;
      status: "running" | "stopped" | "error" | "completed";
    }
  | { type: "error"; sessionId: string; error: string }
  | {
      type: "buffered_output";
      sessionId: string;
      messages: ClaudeStreamEvent[];
    };

// Process start request
export interface ProcessStartRequest {
  sessionId: string;
  workingDirectory: string;
  prompt: string;
  agent?: string;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  resume?: boolean;
  maxBudgetUsd?: number;
  skills?: string[];
}

// Process status response
export interface ProcessStatusResponse {
  sessionId: string;
  status: "running" | "stopped" | "error" | "completed";
  pid?: number;
  startedAt?: string;
}
