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

const createSkillSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().min(1, "Description is required"),
  source: z.enum(["built-in", "plugin", "custom"]),
});

type CreateSkillForm = z.infer<typeof createSkillSchema>;

interface SkillConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: CreateSkillForm) => void;
  isSaving?: boolean;
}

export function SkillConfigDialog({
  open,
  onOpenChange,
  onSave,
  isSaving,
}: SkillConfigDialogProps) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    setValue,
    reset,
  } = useForm<CreateSkillForm>({
    resolver: zodResolver(createSkillSchema),
    defaultValues: {
      source: "custom",
    },
  });

  const handleConfigGenerated = (config: Partial<CreateSkillForm>) => {
    // Auto-fill the form with generated config
    if (config.name) setValue("name", config.name);
    if (config.description) setValue("description", config.description);
    if (config.source) setValue("source", config.source);
  };

  const onSubmit = (data: CreateSkillForm) => {
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
          <DialogTitle>Create New Skill with AI Assistant</DialogTitle>
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
                    placeholder="e.g., api-testing"
                    {...register("name")}
                  />
                  {errors.name && (
                    <p className="text-sm text-destructive">{errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Describe what this skill enables agents to do..."
                    rows={8}
                    {...register("description")}
                  />
                  {errors.description && (
                    <p className="text-sm text-destructive">
                      {errors.description.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="source">Source Type</Label>
                  <Controller
                    name="source"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="built-in">Built-in</SelectItem>
                          <SelectItem value="plugin">Plugin</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
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
                    {isSaving ? "Creating..." : "Create Skill"}
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
                Describe the skill you want to create and I&apos;ll help configure it
              </p>
            </div>
            <div className="flex-1 p-4">
              <AssistantChat
                type="skill"
                onConfigGenerated={handleConfigGenerated}
                placeholder="Tell me what functionality this skill should provide..."
                initialMessage="Hello! I can help you create a custom skill. Tell me what capability you want to add - for example: 'Create a skill for testing REST APIs' or 'I need a skill for database migrations'."
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
