"use client";

// Edit-feature drawer: same index-aware assistant as creation, seeded with
// the current feature so it can refine scope/acceptance criteria in place.
// Also shows the feature's run history (PRs/previews) and linked issues.

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Check, Copy, FileText, GitPullRequest, ImageIcon, Loader2, Maximize2, Paperclip, Sparkles, Trash2, X } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { TaskScreenshots } from "@/components/projects/task-screenshots";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  askFeatureAssistant,
  updateFeature,
  deleteFeature,
  generateFeaturePlan,
  getFeaturePlan,
  setFeaturePlanStatus,
  uploadFeatureAttachments,
  deleteFeatureAttachment,
  type FeatureAssistantReply,
  type FeatureAttachment,
} from "@/services/features";
import { getDevPhases } from "@/services/dev-phases";
import { getTask, getTasks, type TaskSummary } from "@/services/tasks";
import { AutoScrollLog } from "@/components/ui/auto-scroll-log";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FeatureWithCounts } from "@/services/features";
import {
  FEATURE_STATUSES,
  FEATURE_PRIORITIES,
  createPrToPrMode,
  prModeToCreatePr,
  type FeaturePrMode,
} from "@/types";
import { prLabel, statusConfig, priorityConfig } from "./feature-card";
import { PrModeField } from "./pr-mode-field";
import { IssuePicker, LinkedIssuesList } from "@/components/github/issue-picker";
import {
  ClickUpTaskPicker,
  LinkedClickUpTasksList,
} from "@/components/clickup/clickup-task-picker";
import {
  GitLabIssuePicker,
  LinkedGitLabIssuesList,
} from "@/components/gitlab/gitlab-issue-picker";

const editFeatureFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["backlog", "todo", "queued", "in_progress", "in_review", "done"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
});

type EditFeatureFormValues = z.infer<typeof editFeatureFormSchema>;

type ChatMessage = { role: "user" | "assistant"; content: string };

interface EditFeatureDialogProps {
  projectId: string;
  feature: FeatureWithCounts | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditFeatureDialog({
  projectId,
  feature,
  open,
  onOpenChange,
}: EditFeatureDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [devPhaseId, setDevPhaseId] = useState<string>("");
  const [prMode, setPrMode] = useState<FeaturePrMode>("inherit");
  const queryClient = useQueryClient();

  // Attachments live outside the form: they upload/remove immediately.
  const [attachments, setAttachments] = useState<FeatureAttachment[]>([]);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const invalidateFeatures = () =>
    queryClient.invalidateQueries({ queryKey: ["features", projectId] });
  const uploadAttachments = useMutation({
    mutationFn: (files: File[]) =>
      uploadFeatureAttachments(projectId, feature!.id, files),
    onSuccess: (list) => {
      setAttachments(list);
      invalidateFeatures();
    },
  });
  const removeAttachment = useMutation({
    mutationFn: (name: string) =>
      deleteFeatureAttachment(projectId, feature!.id, name),
    onSuccess: (list) => {
      setAttachments(list);
      invalidateFeatures();
    },
  });

  // --- assistant chat (resets when the drawer closes / feature changes) ---
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [suggestion, setSuggestion] =
    useState<FeatureAssistantReply["feature"]>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  const devPhases = useQuery({
    queryKey: ["dev-phases", projectId],
    queryFn: () => getDevPhases(projectId),
    enabled: open,
  });

  // Agent runs on this feature — with their PRs/previews, so the drawer shows
  // the full history without hunting through the Sandboxes tab.
  const tasks = useQuery({
    queryKey: ["tasks", projectId, feature?.id],
    queryFn: () => getTasks(projectId, feature!.id),
    enabled: open && feature !== null,
  });

  const form = useForm<EditFeatureFormValues>({
    resolver: zodResolver(editFeatureFormSchema),
    defaultValues: {
      title: "",
      description: "",
      status: "backlog",
      priority: "medium",
    },
  });

  // Reset form when feature changes
  useEffect(() => {
    if (feature) {
      form.reset({
        title: feature.title,
        description: feature.description ?? "",
        status: feature.status as EditFeatureFormValues["status"],
        priority: feature.priority as EditFeatureFormValues["priority"],
      });
      setDevPhaseId(feature.devPhaseId ?? "");
      setPrMode(createPrToPrMode(feature.createPr));
      setChat([]);
      setChatInput("");
      setSuggestion(null);
    }
  }, [feature, form]);

  useEffect(() => {
    const list =
      (feature?.attachments as FeatureAttachment[] | null | undefined) ?? [];
    setAttachments(list.map((a) => ({ name: a.name, mime: a.mime, size: a.size })));
  }, [feature]);

  const updateMutation = useMutation({
    mutationFn: (data: EditFeatureFormValues) =>
      updateFeature(projectId, feature!.id, {
        ...data,
        createPr: prModeToCreatePr(prMode),
        devPhaseId: devPhaseId || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      onOpenChange(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteFeature(projectId, feature!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      onOpenChange(false);
    },
  });

  const assistant = useMutation({
    mutationFn: (message: string) => {
      // First turn carries the feature being edited; later turns rely on the
      // chat history the API receives back.
      const payload =
        chat.length === 0 && feature
          ? `The user is EDITING an existing feature of this project.\nCurrent title: ${form.getValues("title")}\nCurrent description: ${form.getValues("description") || "(empty)"}\n\nUSER REQUEST:\n${message}`
          : message;
      return askFeatureAssistant(projectId, payload, chat);
    },
    onSuccess: (reply, message) => {
      setChat((prev) => [
        ...prev,
        { role: "user", content: message },
        { role: "assistant", content: reply.message },
      ]);
      if (reply.feature) setSuggestion(reply.feature);
      setChatInput("");
    },
  });

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, assistant.isPending]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text || assistant.isPending) return;
    assistant.mutate(text);
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    form.setValue("title", suggestion.title, { shouldValidate: true });
    form.setValue("description", suggestion.description);
  };

  function onSubmit(data: EditFeatureFormValues) {
    updateMutation.mutate(data);
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMutation.mutate();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setConfirmDelete(false);
          setChat([]);
          setChatInput("");
          setSuggestion(null);
        }
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b border-border/60 px-4 py-3">
          <SheetTitle className="text-sm">Edit Feature</SheetTitle>
          <SheetDescription className="text-xs">
            Refine it with the assistant — it knows this project&apos;s code —
            or edit directly. Runs, PRs and issues live here too.
          </SheetDescription>
          {(feature?.prUrls?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {feature!.prUrls!.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={url}
                  className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 transition-colors hover:bg-violet-500/20"
                >
                  <GitPullRequest className="h-2.5 w-2.5" />
                  {prLabel(url)}
                </a>
              ))}
            </div>
          )}
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Assistant */}
          <div className="space-y-3 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Assistant
            </div>
            {chat.length > 0 && (
              <div
                ref={chatRef}
                className="max-h-64 space-y-2 overflow-y-auto pr-1"
              >
                {chat.map((m, i) =>
                  m.role === "user" ? (
                    <div
                      key={i}
                      className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-primary/15 px-3 py-1.5 text-xs whitespace-pre-wrap"
                    >
                      {m.content.replace(/^The user is EDITING[\s\S]*?USER REQUEST:\n/, "")}
                    </div>
                  ) : (
                    <div
                      key={i}
                      className="w-fit max-w-[92%] rounded-lg rounded-bl-sm border border-border/60 bg-muted/30 px-3 py-2"
                    >
                      <MarkdownReport>{m.content}</MarkdownReport>
                    </div>
                  ),
                )}
                {assistant.isPending && (
                  <div className="flex w-fit items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Searching the project & thinking…
                  </div>
                )}
              </div>
            )}
            {suggestion && (
              <div className="space-y-1 rounded-md border border-primary/40 bg-primary/10 p-2.5">
                <p className="text-xs font-medium">{suggestion.title}</p>
                <p className="line-clamp-3 text-[11px] text-muted-foreground">
                  {suggestion.description}
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="mt-1 h-6 px-2 text-[11px]"
                  onClick={applySuggestion}
                >
                  Apply to form
                </Button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
                placeholder="e.g. narrow the scope, add acceptance criteria…"
                rows={2}
                className="max-h-40 min-h-[52px] resize-none overflow-y-auto text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={sendChat}
                disabled={!chatInput.trim() || assistant.isPending}
                className="gap-1.5"
              >
                {assistant.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Ask
              </Button>
            </div>
            {assistant.isError && (
              <p className="text-[11px] text-destructive">
                {(assistant.error as Error).message}
              </p>
            )}
          </div>

          <Separator />

          {/* Form */}
          <form
            id="edit-feature-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4 px-4 py-4"
          >
            <div className="space-y-2">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                placeholder="Feature title"
                {...form.register("title")}
                aria-invalid={!!form.formState.errors.title}
              />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.title.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                placeholder="Optional description..."
                rows={5}
                {...form.register("description")}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Attachments</Label>
                <input
                  ref={attachInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) uploadAttachments.mutate(files);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={uploadAttachments.isPending}
                >
                  {uploadAttachments.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Paperclip className="h-3 w-3" />
                  )}
                  Add files
                </Button>
              </div>
              {attachments.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {attachments.map((a) => (
                    <span
                      key={a.name}
                      className="inline-flex max-w-60 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px]"
                    >
                      {a.mime.startsWith("image/") ? (
                        <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{a.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {a.size < 1024 * 1024
                          ? `${Math.max(1, Math.round(a.size / 1024))} KB`
                          : `${(a.size / 1024 / 1024).toFixed(1)} MB`}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment.mutate(a.name)}
                        disabled={removeAttachment.isPending}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title="Remove attachment"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  Designs, docs, screenshots… sent to the sandbox with the
                  feature (max 10, 25 MB).
                </p>
              )}
              {(uploadAttachments.isError || removeAttachment.isError) && (
                <p className="text-[11px] text-destructive">
                  {((uploadAttachments.error ?? removeAttachment.error) as Error)
                    ?.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.watch("status")}
                  onValueChange={(val) =>
                    form.setValue(
                      "status",
                      val as EditFeatureFormValues["status"],
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEATURE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusConfig[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={form.watch("priority")}
                  onValueChange={(val) =>
                    form.setValue(
                      "priority",
                      val as EditFeatureFormValues["priority"],
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEATURE_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {priorityConfig[p].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <PrModeField
              id="edit-feature-pr-mode"
              value={prMode}
              onChange={setPrMode}
            />

            {(devPhases.data?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <Label>Dev phase</Label>
                <Select
                  value={devPhaseId}
                  onValueChange={(val) => setDevPhaseId((val as string) ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v) =>
                        devPhases.data?.find((p) => p.id === v)?.name ?? "None"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {devPhases.data?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </form>

          {/* Implementation plan — read-only plan mode on the dev sandbox */}
          {feature && (
            <>
              <Separator />
              <FeaturePlanSection projectId={projectId} featureId={feature.id} />
            </>
          )}

          {/* Agent runs + their PRs/previews for this feature */}
          {feature && (tasks.data?.length ?? 0) > 0 && (
            <>
              <Separator />
              <div className="space-y-2 px-4 py-4">
                <Label className="text-sm font-medium">
                  Runs & pull requests
                </Label>
                <div className="max-h-72 space-y-1.5 overflow-y-auto">
                  {tasks.data!.map((t) => (
                    <FeatureRunRow key={t.id} projectId={projectId} task={t} />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* GitHub Issues */}
          {feature && (
            <>
              <Separator />
              <div className="space-y-2 px-4 py-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">GitHub Issues</Label>
                  <IssuePicker projectId={projectId} featureId={feature.id} />
                </div>
                <LinkedIssuesList projectId={projectId} featureId={feature.id} />
              </div>
            </>
          )}

          {/* GitLab Issues */}
          {feature && (
            <>
              <Separator />
              <div className="space-y-2 px-4 py-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">GitLab Issues</Label>
                  <GitLabIssuePicker projectId={projectId} featureId={feature.id} />
                </div>
                <LinkedGitLabIssuesList projectId={projectId} featureId={feature.id} />
              </div>
            </>
          )}

          {/* ClickUp Tasks */}
          {feature && (
            <>
              <Separator />
              <div className="space-y-2 px-4 py-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">ClickUp Tasks</Label>
                  <ClickUpTaskPicker projectId={projectId} featureId={feature.id} />
                </div>
                <LinkedClickUpTasksList projectId={projectId} featureId={feature.id} />
              </div>
            </>
          )}
        </div>

        {/* Pinned actions */}
        <div className="border-t border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmDelete
                ? "Confirm Delete"
                : deleteMutation.isPending
                  ? "Deleting..."
                  : "Delete"}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="edit-feature-form"
                disabled={updateMutation.isPending}
                className="gap-1.5"
              >
                {updateMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Save Changes
              </Button>
            </div>
          </div>
          {(updateMutation.isError || deleteMutation.isError) && (
            <p className="mt-2 text-xs text-destructive">
              {updateMutation.error?.message || deleteMutation.error?.message}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const PLAN_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  pending_review: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  approved: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  rejected: "bg-red-500/10 text-red-300 border-red-500/20",
};

/**
 * The feature's implementation plan: a read-only Claude plan-mode run on the
 * dev sandbox (it cannot edit anything, so it runs alongside live work). The
 * saved plan is handed to the implementing agent when the feature runs.
 */
function FeaturePlanSection({
  projectId,
  featureId,
}: {
  projectId: string;
  featureId: string;
}) {
  const qc = useQueryClient();
  const [readerOpen, setReaderOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const planQuery = useQuery({
    queryKey: ["feature-plan", projectId, featureId],
    queryFn: () => getFeaturePlan(projectId, featureId),
    // While a plan is being generated, poll until it lands.
    refetchInterval: (q) => (q.state.data?.running ? 5000 : false),
  });
  const plan = planQuery.data?.plan ?? null;
  const running = planQuery.data?.running ?? false;
  const sandboxName = planQuery.data?.sandboxName ?? null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["feature-plan", projectId, featureId] });
    qc.invalidateQueries({ queryKey: ["tasks", projectId, featureId] });
    qc.invalidateQueries({ queryKey: ["features", projectId] });
  };

  const generate = useMutation({
    mutationFn: (text?: string) =>
      generateFeaturePlan(projectId, featureId, text),
    onSuccess: () => {
      setFollowUp("");
      invalidate();
    },
  });

  const sendFollowUp = () => {
    const text = followUp.trim();
    if (!text || running || generate.isPending) return;
    // Back to the section: the "planning on…" state lives there.
    setReaderOpen(false);
    generate.mutate(text);
  };

  // Rendered twice (section + reader modal) over the same state, so a
  // half-typed follow-up survives opening or closing the reader.
  const followUpComposer =
    plan && !running ? (
      <div className="flex items-end gap-2">
        <Textarea
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendFollowUp();
            }
          }}
          placeholder="Follow up on the plan — e.g. “split step 3”, “consider migrations”…"
          className="min-h-[38px] flex-1 resize-none text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={sendFollowUp}
          disabled={!followUp.trim() || generate.isPending}
          className="h-8 shrink-0 gap-1.5 text-xs"
          title="Revise the plan — resumes the planning session on the dev sandbox"
        >
          {generate.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Follow up
        </Button>
      </div>
    ) : null;
  const review = useMutation({
    mutationFn: (status: "approved" | "rejected") =>
      setFeaturePlanStatus(projectId, featureId, plan!.id, status),
    onSuccess: invalidate,
  });

  const copyPlan = () => {
    if (!plan) return;
    void copyText(plan.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div className="space-y-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-sm font-medium">Plan</Label>
        {plan && (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] ${PLAN_STATUS_STYLES[plan.status] ?? PLAN_STATUS_STYLES.draft}`}
          >
            {plan.status.replace("_", " ")}
          </span>
        )}
        {running && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            planning on{" "}
            <code className="font-mono">{sandboxName ?? "the dev sandbox"}</code>…
          </span>
        )}
        {!running && plan && sandboxName && (
          <span className="text-[11px] text-muted-foreground">
            planned on <code className="font-mono">{sandboxName}</code>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {plan && (
            <Button
              size="sm"
              variant="ghost"
              onClick={copyPlan}
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              title="Copy the plan as markdown"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          {plan && plan.status !== "approved" && !running && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => review.mutate("approved")}
              disabled={review.isPending}
              className="h-7 text-xs"
            >
              Approve
            </Button>
          )}
          {plan && plan.status !== "rejected" && !running && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => review.mutate("rejected")}
              disabled={review.isPending}
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
            >
              Reject
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => generate.mutate(undefined)}
            disabled={running || generate.isPending}
            className="h-7 gap-1.5 text-xs"
            title="Read-only Claude plan-mode run against the sandbox's real checkouts — runs alongside current work without interrupting it"
          >
            {generate.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {plan ? "Regenerate" : "Generate plan"}
          </Button>
        </div>
      </div>
      {!plan && !running && (
        <p className="text-[11px] text-muted-foreground">
          Plans run in read-only plan mode on the dev sandbox — against the
          real checkouts, without interrupting whatever is running there. The
          saved plan is handed to the agent that implements this feature.
        </p>
      )}
      {generate.isError && (
        <p className="text-xs text-destructive">
          {(generate.error as Error).message}
        </p>
      )}
      {plan && (
        <button
          type="button"
          onClick={() => setReaderOpen(true)}
          title="Open the plan in a full-size reader"
          className="group relative block w-full cursor-zoom-in rounded-md border border-border/40 bg-background/40 p-2.5 text-left transition-colors hover:border-border"
        >
          {/* Collapsed preview — the real reading happens in the modal. */}
          <div className="pointer-events-none max-h-40 overflow-hidden">
            <MarkdownReport>{plan.content}</MarkdownReport>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center rounded-b-md bg-gradient-to-t from-background to-transparent pb-2">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground group-hover:text-foreground">
              <Maximize2 className="h-3 w-3" />
              Open full plan
            </span>
          </div>
        </button>
      )}

      {followUpComposer}

      {plan && (
        <Dialog open={readerOpen} onOpenChange={setReaderOpen}>
          <DialogContent className="flex max-h-[88vh] w-full flex-col gap-3 sm:max-w-3xl">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-8">
                {plan.title}
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-normal ${PLAN_STATUS_STYLES[plan.status] ?? PLAN_STATUS_STYLES.draft}`}
                >
                  {plan.status.replace("_", " ")}
                </span>
                {sandboxName && (
                  <span className="font-mono text-[10px] font-normal text-muted-foreground">
                    planned on {sandboxName}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={copyPlan}
                  className="ml-auto h-7 gap-1.5 text-xs font-normal text-muted-foreground"
                  title="Copy the plan as markdown"
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <MarkdownReport>{plan.content}</MarkdownReport>
            </div>
            <div className="shrink-0">{followUpComposer}</div>
            {plan.status !== "approved" && (
              <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => review.mutate("rejected")}
                  disabled={review.isPending}
                  className="text-muted-foreground hover:text-destructive"
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    review.mutate("approved");
                    setReaderOpen(false);
                  }}
                  disabled={review.isPending}
                >
                  Approve plan
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** One agent run of this feature — expandable to its live log and report. */
function FeatureRunRow({
  projectId,
  task,
}: {
  projectId: string;
  task: TaskSummary;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = task.status === "running" || task.status === "queued";

  const detail = useQuery({
    queryKey: ["task", projectId, task.id],
    queryFn: () => getTask(projectId, task.id),
    enabled: expanded,
    refetchInterval: expanded && active ? 3000 : false,
  });

  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-muted/20">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={expanded ? "Hide log" : "Show log"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span
          className={
            task.status === "completed"
              ? "text-emerald-400"
              : task.status === "error"
                ? "text-destructive"
                : "flex items-center gap-1 text-amber-300"
          }
        >
          {active && <Loader2 className="h-3 w-3 animate-spin" />}
          {task.status}
        </span>
        {task.kind !== "task" && (
          <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
            {task.kind}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {task.branch ?? task.prompt.slice(0, 60)}
        </span>
        {/* Which machine ran it — the answer to "where did this go?" */}
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          title={`Sandbox: ${task.sandbox.name}`}
        >
          {task.sandbox.name}
        </span>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-primary underline-offset-2 hover:underline"
          >
            PR ↗
          </a>
        )}
        {task.previewUrl && (
          <a
            href={task.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-sky-300 underline-offset-2 hover:underline"
          >
            Preview ↗
          </a>
        )}
        {task.costUsd != null && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            ${task.costUsd.toFixed(2)}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
        </span>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-border/40 px-2.5 py-2">
          {detail.isLoading && (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading log…
            </p>
          )}
          {detail.data?.result && (
            <div className="rounded-md border border-border/40 bg-background/40 p-2">
              <MarkdownReport>{detail.data.result}</MarkdownReport>
            </div>
          )}
          {/* Product screenshots collected for this run — same set Telegram gets. */}
          <TaskScreenshots
            projectId={projectId}
            taskId={task.id}
            enabled={expanded && !active}
          />
          {detail.data?.log && (
            <AutoScrollLog text={detail.data.log} className="max-h-48 p-0" />
          )}
        </div>
      )}
    </div>
  );
}
