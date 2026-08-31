"use client";

// New-feature drawer: the form plus an index-aware assistant. Describe the
// idea in the chat — the assistant searches the project's semantic index,
// proposes a scoped title/description, and one click applies it to the form.

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, ImageIcon, Loader2, Paperclip, Sparkles, X } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { MarkdownReport } from "@/components/ui/markdown-report";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  askFeatureAssistant,
  createFeature,
  generateFeaturePlan,
  uploadFeatureAttachments,
  type FeatureAssistantReply,
} from "@/services/features";
import { Switch } from "@/components/ui/switch";
import { getDevPhases } from "@/services/dev-phases";
import {
  FEATURE_STATUSES,
  FEATURE_PRIORITIES,
  prModeToCreatePr,
  type FeaturePrMode,
} from "@/types";
import { statusConfig, priorityConfig } from "./feature-card";
import { PrModeField } from "./pr-mode-field";

const createFeatureFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["backlog", "todo", "queued", "in_progress", "in_review", "done"]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
});

type CreateFeatureFormValues = z.infer<typeof createFeatureFormSchema>;

type ChatMessage = { role: "user" | "assistant"; content: string };

interface CreateFeatureDialogProps {
  projectId: string;
  /** The trigger element — rendered *as* the sheet trigger, so it must be a
      single element (a real <button>), not arbitrary nodes. */
  children: React.ReactElement;
}

export function CreateFeatureDialog({
  projectId,
  children,
}: CreateFeatureDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [devPhaseId, setDevPhaseId] = useState<string>("");
  const [prMode, setPrMode] = useState<FeaturePrMode>("inherit");
  const [planFirst, setPlanFirst] = useState(false);
  // Files picked before the feature exists — uploaded right after create.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  // --- assistant chat (resets when the drawer closes) ---
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [suggestion, setSuggestion] = useState<FeatureAssistantReply["feature"]>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  const devPhases = useQuery({
    queryKey: ["dev-phases", projectId],
    queryFn: () => getDevPhases(projectId),
    enabled: open,
  });

  const form = useForm<CreateFeatureFormValues>({
    resolver: zodResolver(createFeatureFormSchema),
    defaultValues: {
      title: "",
      description: "",
      status: "backlog",
      priority: "medium",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: CreateFeatureFormValues) => {
      const feature = await createFeature(projectId, {
        ...data,
        createPr: prModeToCreatePr(prMode),
        devPhaseId: devPhaseId || null,
      });
      // Feature first, then files — a failed upload leaves the feature
      // created and surfaces the error without losing the form.
      if (pendingFiles.length > 0) {
        await uploadFeatureAttachments(projectId, feature.id, pendingFiles);
      }
      // Best-effort: the feature exists either way; a missing dev sandbox
      // only means the plan run didn't start, and the dialog says so.
      if (planFirst) {
        await generateFeaturePlan(projectId, feature.id).catch((err) =>
          toast({
            title: "Could not start the plan",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          }),
        );
      }
      return feature;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["features", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dev-phases", projectId] });
      setOpen(false);
      setDevPhaseId("");
      setPrMode("inherit");
      setPlanFirst(false);
      setPendingFiles([]);
      form.reset();
    },
  });

  const assistant = useMutation({
    mutationFn: (message: string) =>
      askFeatureAssistant(projectId, message, chat),
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

  function onSubmit(data: CreateFeatureFormValues) {
    mutation.mutate(data);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          form.reset();
          setChat([]);
          setChatInput("");
          setSuggestion(null);
          setPendingFiles([]);
          setPrMode("inherit");
        }
      }}
    >
      {/* The caller passes its own <Button> — render it *as* the trigger.
          Wrapping it in a <span> instead makes Base UI warn about losing
          native button semantics. */}
      <SheetTrigger render={children} />
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b border-border/60 px-4 py-3">
          <SheetTitle className="text-sm">New Feature</SheetTitle>
          <SheetDescription className="text-xs">
            Describe the idea to the assistant — it knows this project&apos;s
            code via the search index — or fill the form directly.
          </SheetDescription>
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
                      {m.content}
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
                placeholder="e.g. quiero exportar el reporte mensual a PDF…"
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
            id="create-feature-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4 px-4 py-4"
          >
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
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
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
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
                    if (files.length > 0)
                      setPendingFiles((prev) => [...prev, ...files].slice(0, 10));
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => attachInputRef.current?.click()}
                >
                  <Paperclip className="h-3 w-3" />
                  Add files
                </Button>
              </div>
              {pendingFiles.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {pendingFiles.map((f, i) => (
                    <span
                      key={`${f.name}-${i}`}
                      className="inline-flex max-w-60 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[10px]"
                    >
                      {f.type.startsWith("image/") ? (
                        <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingFiles((prev) =>
                            prev.filter((_, j) => j !== i),
                          )
                        }
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title="Remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  Designs, docs, screenshots… uploaded with the feature and
                  sent to the sandbox when it runs (max 10, 25 MB).
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
                      val as CreateFeatureFormValues["status"],
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
                      val as CreateFeatureFormValues["priority"],
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
              id="create-feature-pr-mode"
              value={prMode}
              onChange={setPrMode}
            />

            <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
              <span className="space-y-0.5">
                <span className="block text-sm">Plan first on the dev sandbox</span>
                <span className="block text-[11px] text-muted-foreground">
                  A read-only Claude plan-mode run explores the real checkouts
                  and saves an implementation plan — without interrupting
                  whatever is already running there.
                </span>
              </span>
              <Switch
                checked={planFirst}
                onCheckedChange={setPlanFirst}
                aria-label="Plan first on the dev sandbox"
              />
            </label>

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

            {mutation.isError && (
              <p className="text-xs text-destructive">
                {mutation.error.message}
              </p>
            )}
          </form>
        </div>

        {/* Pinned actions */}
        <div className="border-t border-border/60 px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-feature-form"
              disabled={mutation.isPending}
              className="gap-1.5"
            >
              {mutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Create Feature
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
