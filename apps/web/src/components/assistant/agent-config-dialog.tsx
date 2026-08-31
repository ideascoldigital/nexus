"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AssistantChat } from "./assistant-chat";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const AGENT_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#06b6d4",
  "#6366f1",
];

const createAgentSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  systemPrompt: z.string().min(1, "System prompt is required"),
  model: z.string(),
  color: z.string(),
});

type CreateAgentForm = z.infer<typeof createAgentSchema>;

interface AgentConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: CreateAgentForm) => void;
  isSaving?: boolean;
}

export function AgentConfigDialog({
  open,
  onOpenChange,
  onSave,
  isSaving,
}: AgentConfigDialogProps) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    setValue,
    reset,
  } = useForm<CreateAgentForm>({
    resolver: zodResolver(createAgentSchema),
    defaultValues: {
      model: "claude-opus-4",
      color: AGENT_COLORS[0],
    },
  });

  const handleConfigGenerated = (config: Partial<CreateAgentForm>) => {
    // Auto-fill the form with generated config
    if (config.name) setValue("name", config.name);
    if (config.description) setValue("description", config.description);
    if (config.systemPrompt) setValue("systemPrompt", config.systemPrompt);
    if (config.model) setValue("model", config.model);
    if (config.color) setValue("color", config.color);
  };

  const onSubmit = (data: CreateAgentForm) => {
    onSave(data);
    reset();
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      reset();
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-7xl max-h-[90vh] p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Create New Agent with AI Assistant</DialogTitle>
          <DialogDescription>
            Chat with the AI assistant on the right to generate configuration, or edit manually on the left
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden border-t">
          {/* Left Side - Manual Form */}
          <div className="flex-1 border-r">
            <ScrollArea className="h-[calc(90vh-180px)]">
              <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., frontend-expert"
                    {...register("name")}
                  />
                  {errors.name && (
                    <p className="text-sm text-destructive">{errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Input
                    id="description"
                    placeholder="Brief description of what this agent does"
                    {...register("description")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="systemPrompt">System Prompt</Label>
                  <Textarea
                    id="systemPrompt"
                    placeholder="You are an expert in..."
                    rows={8}
                    {...register("systemPrompt")}
                  />
                  {errors.systemPrompt && (
                    <p className="text-sm text-destructive">
                      {errors.systemPrompt.message}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="model">Model</Label>
                    <Controller
                      name="model"
                      control={control}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="claude-opus-4">Claude Opus 4</SelectItem>
                            <SelectItem value="claude-sonnet-4">
                              Claude Sonnet 4
                            </SelectItem>
                            <SelectItem value="gpt-4">GPT-4</SelectItem>
                            <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                            <SelectItem value="gpt-3.5-turbo">
                              GPT-3.5 Turbo
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="color">Color</Label>
                    <Controller
                      name="color"
                      control={control}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {AGENT_COLORS.map((color) => (
                              <SelectItem key={color} value={color}>
                                <div className="flex items-center gap-2">
                                  <div
                                    className="h-4 w-4 rounded"
                                    style={{ backgroundColor: color }}
                                  />
                                  {color}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-4 border-t">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleClose(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSaving}>
                    {isSaving ? "Creating..." : "Create Agent"}
                  </Button>
                </div>
              </form>
            </ScrollArea>
          </div>

          {/* Right Side - AI Assistant Chat */}
          <div className="w-[600px] flex flex-col bg-muted/30">
            <div className="p-4 border-b bg-background/50">
              <h3 className="font-medium text-sm">AI Assistant</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Describe the agent you want to create and I&apos;ll help configure it
              </p>
            </div>
            <div className="flex-1 p-4">
              <AssistantChat
                type="agent"
                onConfigGenerated={handleConfigGenerated}
                placeholder="Tell me what kind of agent you want to create..."
                initialMessage="Hello! I can help you create a custom agent. Tell me about what you need - for example: 'Create an agent specialized in React performance optimization' or 'I need an agent that reviews code for security issues'."
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
