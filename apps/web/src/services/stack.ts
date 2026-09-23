import type {
  ComposeResult,
  DetectionResult,
  StackAssistantReply,
  StackAssistantState,
  StackGraph,
  StackInheritance,
  StackLogLine,
  StackSaveInput,
  StackStatus,
  StackValidation,
  RepairResult,
} from "@/lib/stack/types";

export async function getStack(projectId: string): Promise<StackGraph> {
  const res = await fetch(`/api/projects/${projectId}/stack`);
  if (!res.ok) throw new Error("Failed to load stack");
  return res.json();
}

export async function saveStack(
  projectId: string,
  data: StackSaveInput
): Promise<{ ok: true } & StackGraph> {
  const res = await fetch(`/api/projects/${projectId}/stack`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err.error === "string" ? err.error : "Failed to save stack"
    );
  }
  return res.json();
}

export async function detectRepository(
  projectId: string,
  repositoryId: string
): Promise<DetectionResult> {
  const res = await fetch(`/api/projects/${projectId}/stack/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Detection failed");
  }
  return res.json();
}

export async function detectAllRepositories(
  projectId: string
): Promise<Record<string, DetectionResult>> {
  const res = await fetch(`/api/projects/${projectId}/stack/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Detection failed");
  }
  return res.json();
}

export async function generateComposeFile(
  projectId: string,
  opts: { dryRun?: boolean } = {}
): Promise<ComposeResult> {
  const res = await fetch(`/api/projects/${projectId}/stack/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Compose generation failed");
  }
  return res.json();
}

export async function stackUp(
  projectId: string
): Promise<{ ok: boolean; status: string; warnings?: string[] }> {
  const res = await fetch(`/api/projects/${projectId}/stack/up`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to start stack");
  }
  return res.json();
}

/** Run the canvas's install and build phases. Separate from Up — see the route. */
export async function stackPrepare(
  projectId: string
): Promise<{ ok: boolean; status: string; warnings?: string[] }> {
  const res = await fetch(`/api/projects/${projectId}/stack/prepare`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to prepare stack");
  }
  return res.json();
}

export async function stackDown(projectId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/projects/${projectId}/stack/down`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to stop stack");
  }
  return res.json();
}

export async function getStackStatus(
  projectId: string
): Promise<StackStatus> {
  const res = await fetch(`/api/projects/${projectId}/stack/status`);
  if (!res.ok) throw new Error("Failed to load stack status");
  return res.json();
}

export async function getStackLogs(
  projectId: string,
  since = 0
): Promise<StackLogLine[]> {
  const res = await fetch(
    `/api/projects/${projectId}/stack/logs?since=${since}`
  );
  if (!res.ok) throw new Error("Failed to load stack logs");
  return res.json();
}

// --- Stack assistant ---

export async function getStackAssistantState(
  projectId: string
): Promise<StackAssistantState> {
  const res = await fetch(`/api/projects/${projectId}/stack/assistant`);
  if (!res.ok) throw new Error("Failed to load stack assistant");
  return res.json();
}

export async function sendStackAssistantMessage(
  projectId: string,
  message: string,
  history: { role: string; content: string }[]
): Promise<StackAssistantReply> {
  const res = await fetch("/api/assistant/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "stack-assistant", projectId, message, history }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.details ?? err.error ?? "Assistant request failed");
  }
  return res.json();
}

// Streams ndjson log lines; returns an abort function.
export function streamStackLogs(
  projectId: string,
  onLine: (line: StackLogLine) => void,
  onError?: (err: Error) => void
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stack/logs?stream=1`,
        { signal: controller.signal }
      );
      if (!res.ok || !res.body) throw new Error("Cannot open log stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onLine(JSON.parse(line) as StackLogLine);
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err as Error);
      }
    }
  })();

  return () => controller.abort();
}

/** What the sandbox config inherits from the Stack canvas. */
export async function getStackInheritance(
  projectId: string
): Promise<StackInheritance> {
  const res = await fetch(`/api/projects/${projectId}/stack/inheritance`);
  if (!res.ok) throw new Error("Failed to load stack inheritance");
  return res.json();
}

/**
 * Spec 24 piece 4 — would this stack come up?
 *
 * POST because reading the observed half opens an SSH connection to the
 * project's sandbox: too expensive to sit behind something a browser may
 * prefetch.
 */
export async function validateStack(
  projectId: string
): Promise<StackValidation> {
  const res = await fetch(`/api/projects/${projectId}/stack/validate`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Validation failed");
  }
  return res.json();
}


/**
 * Spec 25 piece 2 — validate, patch, re-validate.
 *
 * Unlike `validateStack` this *writes*: it edits the stack definition and may
 * provision a container per round. The caller shows the diff it returns.
 */
export async function repairStack(
  projectId: string,
  maxRounds?: number
): Promise<RepairResult> {
  const res = await fetch(`/api/projects/${projectId}/stack/repair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(maxRounds ? { maxRounds } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Repair failed");
  }
  return res.json();
}
