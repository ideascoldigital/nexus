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
import { createSkill } from "@/services/skills";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { ArrowLeft, Sparkles, Loader2 } from "lucide-react";
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

const createSkillSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, hyphens"),
  description: z.string().min(1, "Description is required"),
  scope: z.enum(["user", "project"]),
  body: z.string().min(1, "Body is required"),
});

type CreateSkillForm = z.infer<typeof createSkillSchema>;

export default function NewSkillPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    setValue,
  } = useForm<CreateSkillForm>({
    resolver: zodResolver(createSkillSchema),
    defaultValues: {
      scope: "user",
    },
  });

  const createMutation = useMutation({
    mutationFn: createSkill,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({
        title: "Success",
        description: "Skill created successfully",
      });
      router.push("/skills");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create skill",
        variant: "destructive",
      });
    },
  });

  // `raw` is untyped JSON extracted by the assistant; next/dynamic erases
  // AssistantChat's generic, so the narrowing happens here.
  const handleConfigGenerated = (raw: unknown) => {
    const config = raw as Partial<CreateSkillForm> & {
      content?: string;
      instructions?: string;
    };
    if (config.name) setValue("name", config.name);
    if (config.description) setValue("description", config.description);
    if (config.body) setValue("body", config.body);
    else if (config.content) setValue("body", config.content);
    else if (config.instructions) setValue("body", config.instructions);
    if (config.scope === "project" || config.scope === "user") {
      setValue("scope", config.scope);
    }
  };

  const onSubmit = (data: CreateSkillForm) => {
    createMutation.mutate(data);
  };

  return (
    <div className="flex flex-col h-svh">
      <AppHeader title="Create New Skill" />
      <div className="flex-1 overflow-hidden">
        <ResizableGroup persistId="skill-new" className="h-full">
          {/* Left Side - Manual Form */}
          <ResizablePanel
            id="form"
            minSize="30%"
            className="overflow-auto bg-background"
          >
            <div className="p-6">
              <div className="max-w-2xl mx-auto">
                <Link
                  href="/skills"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Skills
                </Link>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5" />
                      Skill Configuration
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                      <div className="space-y-2">
                        <Label htmlFor="name">Name</Label>
                        <Input
                          id="name"
                          placeholder="e.g., api-testing"
                          {...register("name")}
                        />
                        {errors.name && (
                          <p className="text-sm text-destructive">
                            {errors.name.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="description">Description</Label>
                        <Textarea
                          id="description"
                          placeholder="Describe what this skill enables agents to do..."
                          rows={3}
                          {...register("description")}
                        />
                        {errors.description && (
                          <p className="text-sm text-destructive">
                            {errors.description.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="body">SKILL.md Body</Label>
                        <Textarea
                          id="body"
                          placeholder={"# My Skill\n\nDetailed instructions..."}
                          rows={14}
                          className="font-mono text-xs"
                          {...register("body")}
                        />
                        {errors.body && (
                          <p className="text-sm text-destructive">
                            {errors.body.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="scope">Scope</Label>
                        <Controller
                          name="scope"
                          control={control}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="user">User (~/.claude/skills)</SelectItem>
                                <SelectItem value="project">Project (./.claude/skills)</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>

                      <div className="flex justify-end gap-2 pt-4 border-t">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => router.push("/skills")}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" disabled={createMutation.isPending}>
                          {createMutation.isPending ? "Creating..." : "Create Skill"}
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
                Describe the skill you want and watch the form auto-fill
              </p>
            </div>
            <div className="flex-1 min-h-0 p-4">
              <AssistantChat
                type="skill"
                onConfigGenerated={handleConfigGenerated}
                placeholder="Tell me what functionality this skill should provide..."
                initialMessage="Hello! I can help you create a custom skill. Tell me what capability you want to add - for example: 'Create a skill for testing REST APIs' or 'I need a skill for database migrations'."
              />
            </div>
          </ResizablePanel>
        </ResizableGroup>
      </div>
    </div>
  );
}
