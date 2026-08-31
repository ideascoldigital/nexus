"use client";

import { AppHeader } from "@/components/layout/app-header";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import dynamic from "next/dynamic";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createAgent } from "@/services/agents";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, Sparkles, Loader2 } from "lucide-react";
import Link from "next/link";
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";

const AssistantChat = dynamic(
  () =>
    import("@/components/assistant/assistant-chat").then(
      (mod) => mod.AssistantChat
    ),
  { 
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
);

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

export default function NewAgentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    setValue,
  } = useForm<CreateAgentForm>({
    resolver: zodResolver(createAgentSchema),
    defaultValues: {
      model: "claude-opus-4",
      color: AGENT_COLORS[0],
    },
  });

  const createMutation = useMutation({
    mutationFn: createAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast({
        title: "Success",
        description: "Agent created successfully",
      });
      router.push("/agents");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create agent",
        variant: "destructive",
      });
    },
  });

  // `raw` is untyped JSON extracted by the assistant; next/dynamic erases
  // AssistantChat's generic, so the narrowing happens here.
  const handleConfigGenerated = (raw: unknown) => {
    const config = raw as Partial<CreateAgentForm>;
    // Auto-fill the form with generated config
    if (config.name) setValue("name", config.name);
    if (config.description) setValue("description", config.description);
    if (config.systemPrompt) setValue("systemPrompt", config.systemPrompt);
    if (config.model) setValue("model", config.model);
    if (config.color) setValue("color", config.color);
  };

  const onSubmit = (data: CreateAgentForm) => {
    createMutation.mutate(data);
  };

  return (
    <div className="flex flex-col h-svh">
      <AppHeader title="Create New Agent" />
      <div className="flex-1 overflow-hidden">
        <ResizableGroup persistId="agent-new" className="h-full">
          {/* Left Side - Manual Form */}
          <ResizablePanel
            id="form"
            minSize="30%"
            className="overflow-auto bg-background"
          >
            <div className="p-6">
              <div className="max-w-2xl mx-auto">
                <Link
                  href="/agents"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Agents
                </Link>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Bot className="h-5 w-5" />
                      Agent Configuration
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                      <div className="space-y-2">
                        <Label htmlFor="name">Name</Label>
                        <Input
                          id="name"
                          placeholder="e.g., frontend-expert"
                          {...register("name")}
                        />
                        {errors.name && (
                          <p className="text-sm text-destructive">
                            {errors.name.message}
                          </p>
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
                          rows={12}
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
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="claude-opus-4">
                                    Claude Opus 4
                                  </SelectItem>
                                  <SelectItem value="claude-sonnet-4">
                                    Claude Sonnet 4
                                  </SelectItem>
                                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                                  <SelectItem value="gpt-4-turbo">
                                    GPT-4 Turbo
                                  </SelectItem>
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
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                              >
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
                          onClick={() => router.push("/agents")}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" disabled={createMutation.isPending}>
                          {createMutation.isPending ? "Creating..." : "Create Agent"}
                        </Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Right Side - AI Assistant Chat - Fixed Height with Internal Scroll */}
          <ResizablePanel
            id="assistant"
            defaultSize="600px"
            minSize="320px"
            className="flex h-full flex-col bg-muted/30"
          >
            <div className="p-4 border-b bg-background shrink-0">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Assistant
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Describe the agent you want and watch the form auto-fill
              </p>
            </div>
            <div className="flex-1 min-h-0 p-4">
              <AssistantChat
                type="agent"
                onConfigGenerated={handleConfigGenerated}
                placeholder="Tell me what kind of agent you want to create..."
                initialMessage="Hello! I can help you create a custom agent. Tell me about what you need - for example: 'Create an agent specialized in React performance optimization' or 'I need an agent that reviews code for security issues'."
              />
            </div>
          </ResizablePanel>
        </ResizableGroup>
      </div>
    </div>
  );
}
