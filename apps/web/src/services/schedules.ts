// Client fetchers for scheduled agent tasks (TaskSchedule).

export type TaskScheduleSummary = {
  id: string;
  projectId: string;
  featureId: string | null;
  prompt: string | null;
  provider: "civo" | "aws" | "local";
  ephemeral: boolean;
  cron: string | null;
  runAt: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastTaskId: string | null;
  createdAt: string;
  feature: { title: string } | null;
};

export type CreateScheduleInput = {
  featureId?: string;
  prompt?: string;
  provider: "civo" | "aws" | "local";
  ephemeral: boolean;
  cron?: string;
  runAt?: string; // ISO datetime
};

async function parseError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}) as { error?: unknown });
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") throw new Error(err);
  if (err && typeof err === "object" && "formErrors" in err) {
    const forms = (err as { formErrors?: string[] }).formErrors;
    if (forms?.length) throw new Error(forms.join("; "));
  }
  throw new Error(fallback);
}

export async function getSchedules(
  projectId: string,
): Promise<TaskScheduleSummary[]> {
  const res = await fetch(`/api/projects/${projectId}/schedules`);
  if (!res.ok) return parseError(res, "Failed to load schedules");
  return res.json();
}

export async function createSchedule(
  projectId: string,
  data: CreateScheduleInput,
): Promise<TaskScheduleSummary> {
  const res = await fetch(`/api/projects/${projectId}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return parseError(res, "Failed to create schedule");
  return res.json();
}

export async function setScheduleEnabled(
  projectId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<TaskScheduleSummary> {
  const res = await fetch(
    `/api/projects/${projectId}/schedules/${scheduleId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) return parseError(res, "Failed to update schedule");
  return res.json();
}

export async function deleteSchedule(
  projectId: string,
  scheduleId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/schedules/${scheduleId}`,
    { method: "DELETE" },
  );
  if (!res.ok) return parseError(res, "Failed to delete schedule");
}
