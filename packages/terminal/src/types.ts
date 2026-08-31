// Server-side types (Fase 0 stub)
// Will be expanded when implementing Tools, MCPs and interactive terminal

export type ProcessStatus = "running" | "stopped" | "error" | "completed";

export interface GlobalEvent {
  type: "process_started" | "process_stopped" | "process_error";
  sessionId: string;
  timestamp: string;
  details?: string;
}
