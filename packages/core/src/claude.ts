// Claude CLI stream-json event types

export type ClaudeStreamEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeResultEvent
  | ClaudeRateLimitEvent;

export interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: string[];
  model: string;
  cwd: string;
  agents?: string[];
  skills?: string[];
}

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    content: ClaudeContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  session_id: string;
}

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  duration_ms: number;
  total_cost_usd: number;
  session_id: string;
  result: string;
  usage?: Record<string, unknown>;
}

export interface ClaudeRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
}
