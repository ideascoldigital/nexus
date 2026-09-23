"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Brain, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type HostModelResponse = {
  /** What the user explicitly chose — distinct from what got resolved. */
  chosen: { credentialId: string | null; modelName: string | null };
  current: {
    provider: string;
    modelName: string;
    credentialName: string;
  } | null;
  options: Array<{
    credentialId: string;
    name: string;
    provider: string;
    /** False when the saved credential holds no key. */
    usable: boolean;
  }>;
};

/** Sentinel for "no explicit choice", since a Select cannot hold null. */
const AUTO = "__auto__";

/**
 * Which model the agents that run on this machine use.
 *
 * These are a different thing from the brains a sandbox runs, and the
 * distinction is the whole reason this card exists separately: a sandbox's
 * Claude or OpenCode works on your code inside a VM, while these read your
 * repos here to propose configuration. They were hardcoded to OpenAI long
 * after the rest of the product became multi-provider (D-77).
 */
export function HostModelSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [credentialDraft, setCredentialDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<string | null>(null);

  const info = useQuery({
    queryKey: ["host-model"],
    queryFn: async (): Promise<HostModelResponse> => {
      const res = await fetch("/api/settings/host-model", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not read the host model settings");
      return res.json();
    },
  });

  const save = useMutation({
    mutationFn: async (body: {
      credentialId?: string | null;
      modelName?: string | null;
    }) => {
      const res = await fetch("/api/settings/host-model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Could not save the host model settings");
      return res.json() as Promise<{ current: HostModelResponse["current"] }>;
    },
    onSuccess: (data) => {
      setCredentialDraft(null);
      setModelDraft(null);
      queryClient.invalidateQueries({ queryKey: ["host-model"] });
      toast({
        // What it *resolved to*, not what was asked for: a credential that
        // turns out to be unusable falls through, and the user should see
        // which model they really got.
        title: data.current
          ? `Host agents now use ${data.current.modelName}`
          : "No usable credential — host agents cannot run",
        description: data.current?.credentialName,
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not save",
        description: err.message,
        variant: "destructive",
      }),
  });

  const options = info.data?.options ?? [];
  const usable = options.filter((o) => o.usable);
  const current = info.data?.current ?? null;

  // The saved choice, not the resolved answer: "automatic, which happens to
  // be this one" and "I picked this one" look identical in `current`, and
  // showing the latter would make the picker reset itself after every save.
  const selected = credentialDraft ?? info.data?.chosen.credentialId ?? AUTO;
  const modelValue = modelDraft ?? info.data?.chosen.modelName ?? "";
  // Against the saved choice, not merely "was touched": picking the option
  // that is already selected should not offer to save nothing.
  const dirty =
    (credentialDraft !== null &&
      credentialDraft !== (info.data?.chosen.credentialId ?? AUTO)) ||
    (modelDraft !== null && modelDraft !== (info.data?.chosen.modelName ?? ""));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          Host agents
        </CardTitle>
        <CardDescription>
          The model behind the stack assistant, the repair loop, the roadmap
          generator and the project definer — the agents that run here and read
          your repos. Separate from the brain a sandbox runs, which works inside
          the VM.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {info.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading settings…
          </div>
        ) : (
          <>
            <div className="rounded-md border px-3 py-2 text-sm">
              {current ? (
                <>
                  <span className="text-muted-foreground">Currently using </span>
                  <span className="font-mono">{current.modelName}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    via {current.credentialName}
                  </span>
                </>
              ) : (
                <span className="flex items-start gap-2 text-amber-500">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    No LLM credential is configured, so these agents cannot run.
                    Add one under LLM credentials — OpenAI, Anthropic,
                    OpenRouter, Google, xAI and Z.ai all work.
                  </span>
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="host-model-credential">Credential</Label>
              <Select
                value={selected}
                onValueChange={(v) => setCredentialDraft(v)}
                disabled={options.length === 0}
              >
                <SelectTrigger id="host-model-credential">
                  {/* An explicit label rather than SelectValue's own: the
                      "automatic" option carries a sentinel value, and the
                      trigger would render that sentinel verbatim. */}
                  <span className="truncate">
                    {selected === AUTO
                      ? "Automatic — whichever is saved"
                      : (options.find((o) => o.credentialId === selected)
                          ?.name ?? "Automatic — whichever is saved")}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>
                    Automatic — whichever is saved
                  </SelectItem>
                  {options.map((o) => (
                    <SelectItem
                      key={o.credentialId}
                      value={o.credentialId}
                      // Listed but not selectable: "I added that key" and "that
                      // key is empty" are different problems, and hiding the
                      // row makes the second look like the first.
                      disabled={!o.usable}
                    >
                      {o.name} · {o.provider}
                      {o.usable ? "" : " — no key saved"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {options.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No LLM credentials saved yet. Add one above to choose between
                  providers; until then the legacy OpenAI key in Settings is
                  used if present.
                </p>
              ) : usable.length === 0 ? (
                <p className="text-xs text-amber-500">
                  Every saved credential is missing its key.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="host-model-name">Model (optional)</Label>
              <Input
                id="host-model-name"
                value={modelValue}
                placeholder={current?.modelName ?? "provider default"}
                onChange={(e) => setModelDraft(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for the provider&apos;s default. A name the provider
                does not recognise fails at the first request, not here.
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate({
                    ...(credentialDraft !== null
                      ? {
                          credentialId:
                            credentialDraft === AUTO ? null : credentialDraft,
                        }
                      : {}),
                    ...(modelDraft !== null ? { modelName: modelDraft } : {}),
                  })
                }
              >
                {save.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                Save
              </Button>
              {dirty && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCredentialDraft(null);
                    setModelDraft(null);
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
