"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sparkles, Loader2, Trash2 } from "lucide-react";

import { AppHeader } from "@/components/layout/app-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getSkill, updateSkill, deleteSkill } from "@/services/skills";

const editSkillSchema = z.object({
  description: z.string().min(1, "Description is required"),
  body: z.string().min(1, "Body is required"),
});

type EditSkillForm = z.infer<typeof editSkillSchema>;

export default function EditSkillPage({
  params,
}: {
  params: Promise<{ skillId: string }>;
}) {
  const { skillId } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();

  const skillQuery = useQuery({
    queryKey: ["skill", skillId],
    queryFn: () => getSkill(skillId),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<EditSkillForm>({
    resolver: zodResolver(editSkillSchema),
    defaultValues: { description: "", body: "" },
  });

  useEffect(() => {
    if (skillQuery.data) {
      reset({
        description: skillQuery.data.description ?? "",
        body: skillQuery.data.body ?? "",
      });
    }
  }, [skillQuery.data, reset]);

  const updateMutation = useMutation({
    mutationFn: (data: EditSkillForm) => updateSkill(skillId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["skill", skillId] });
      toast({ title: "Saved", description: "Skill updated" });
      router.push("/skills");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSkill(skillId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      toast({ title: "Deleted", description: "Skill removed" });
      router.push("/skills");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const isBuiltIn = skillQuery.data?.isBuiltIn === true;

  if (skillQuery.isLoading) {
    return (
      <>
        <AppHeader title="Loading..." />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  if (skillQuery.isError || !skillQuery.data) {
    return (
      <>
        <AppHeader title="Skill" />
        <div className="flex-1 p-6">
          <p className="text-sm text-destructive">Skill not found.</p>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col h-svh">
      <AppHeader title={`Edit ${skillQuery.data.name}`} />
      <div className="flex-1 overflow-auto bg-background">
        <div className="p-6 max-w-2xl mx-auto">
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
                {skillQuery.data.name}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Source: {skillQuery.data.source}
                {skillQuery.data.scope ? ` · scope: ${skillQuery.data.scope}` : ""}
                {skillQuery.data.path ? ` · ${skillQuery.data.path}` : ""}
              </p>
              {isBuiltIn && (
                <p className="text-xs text-amber-400">
                  Built-in skills cannot be edited.
                </p>
              )}
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleSubmit((data) => updateMutation.mutate(data))}
                className="space-y-6"
              >
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" disabled={isBuiltIn} {...register("description")} />
                  {errors.description && (
                    <p className="text-sm text-destructive">
                      {errors.description.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="body">SKILL.md body</Label>
                  <Textarea
                    id="body"
                    rows={20}
                    className="font-mono text-xs"
                    disabled={isBuiltIn}
                    {...register("body")}
                  />
                  {errors.body && (
                    <p className="text-sm text-destructive">{errors.body.message}</p>
                  )}
                </div>

                <div className="flex justify-between gap-2 pt-4 border-t">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete skill "${skillQuery.data!.name}"? This cannot be undone.`,
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
                      onClick={() => router.push("/skills")}
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
