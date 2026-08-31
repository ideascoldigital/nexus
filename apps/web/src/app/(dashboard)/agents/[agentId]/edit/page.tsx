"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Loader2, Trash2 } from "lucide-react";

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
import { useToast } from "@/hooks/use-toast";
import { getAgent, updateAgent, deleteAgent } from "@/services/agents";

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

const editAgentSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  systemPrompt: z.string().min(1, "System prompt is required"),
  model: z.string(),
  color: z.string(),
});

type EditAgentForm = z.infer<typeof editAgentSchema>;

export default function EditAgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const agentQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => getAgent(agentId),
  });

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isDirty },
  } = useForm<EditAgentForm>({
    resolver: zodResolver(editAgentSchema),
    defaultValues: {
      name: "",
      description: "",
      systemPrompt: "",
      model: "claude-opus-4",
      color: AGENT_COLORS[0],
    },
  });

  useEffect(() => {
    if (agentQuery.data) {
      reset({
        name: agentQuery.data.name,
        description: agentQuery.data.description ?? "",
        systemPrompt: agentQuery.data.systemPrompt,
        model: agentQuery.data.model,
        color: agentQuery.data.color,
      });
    }
  }, [agentQuery.data, reset]);

  const updateMutation = useMutation({
    mutationFn: (data: EditAgentForm) => updateAgent(agentId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
      toast({ title: "Saved", description: "Agent updated" });
      router.push("/agents");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast({ title: "Deleted", description: "Agent removed" });
      router.push("/agents");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const isBuiltIn = agentQuery.data?.isBuiltIn === true;

  if (agentQuery.isLoading) {
    return (
      <>
        <AppHeader title="Loading..." />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  if (agentQuery.isError || !agentQuery.data) {
    return (
      <>
        <AppHeader title="Agent" />
        <div className="flex-1 p-6">
          <p className="text-sm text-destructive">Agent not found.</p>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col h-svh">
      <AppHeader title={`Edit ${agentQuery.data.name}`} />
      <div className="flex-1 overflow-auto bg-background">
        <div className="p-6 max-w-2xl mx-auto">
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
              {isBuiltIn && (
                <p className="text-xs text-amber-400">
                  Built-in agents cannot be edited.
                </p>
              )}
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleSubmit((data) => updateMutation.mutate(data))}
                className="space-y-6"
              >
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., frontend-expert"
                    disabled={isBuiltIn}
                    {...register("name")}
                  />
                  {errors.name && (
                    <p className="text-sm text-destructive">{errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    disabled={isBuiltIn}
                    {...register("description")}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="systemPrompt">System Prompt</Label>
                  <Textarea
                    id="systemPrompt"
                    rows={12}
                    disabled={isBuiltIn}
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
                          disabled={isBuiltIn}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="claude-opus-4">Claude Opus 4</SelectItem>
                            <SelectItem value="claude-sonnet-4">Claude Sonnet 4</SelectItem>
                            <SelectItem value="gpt-4">GPT-4</SelectItem>
                            <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                            <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
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
                          disabled={isBuiltIn}
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

                <div className="flex justify-between gap-2 pt-4 border-t">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete agent "${agentQuery.data!.name}"? This cannot be undone.`,
                        )
                      ) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={isBuiltIn || deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5 text-destructive" />
                    Delete
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => router.push("/agents")}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={isBuiltIn || !isDirty || updateMutation.isPending}
                    >
                      {updateMutation.isPending ? "Saving..." : "Save changes"}
                    </Button>
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
