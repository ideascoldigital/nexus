"use client";

// "Create New Bot": a big preview of the face, a name, a shape and a color.
// The job and standing instructions are edited later from the bot's panel.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { BOT_COLORS, BOT_SHAPES, type BotShape } from "@/lib/bot-shapes";
import { cn } from "@/lib/utils";
import { createBot } from "@/services/bots";
import { getDockerEndpoints } from "@/services/docker-endpoints";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [shape, setShape] = useState<BotShape>("blob");
  const [color, setColor] = useState<string>("#ec4899");
  // null = this machine's docker context, which is where a bot ran before
  // endpoints reached them (D-86).
  const [dockerEndpointId, setDockerEndpointId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createBot({ name: name.trim(), shape, color, dockerEndpointId }),
    onSuccess: (bot) => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      onCreated(bot.id);
      onOpenChange(false);
      setName("");
      setDockerEndpointId(null);
    },
    onError: (err) =>
      toast({
        title: "Could not create the bot",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[440px]">
        <DialogHeader className="border-b border-border px-4 py-3.5">
          <DialogTitle className="text-[14px] font-semibold">Create New Bot</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col items-center gap-5 px-4 pt-5 pb-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !create.isPending) create.mutate();
          }}
        >
          <BotAvatar shape={shape} color={color} size={108} looking />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your Bot"
            maxLength={60}
            autoFocus
            className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-center text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <div className="flex max-w-[300px] flex-wrap justify-center gap-x-3 gap-y-2.5">
            {BOT_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Shape ${s}`}
                aria-pressed={shape === s}
                onClick={() => setShape(s)}
                className={cn(
                  "group rounded-xl p-1 transition-colors",
                  shape === s ? "bg-accent ring-1 ring-foreground/25" : "hover:bg-accent/60",
                )}
              >
                <BotAvatar shape={s} color={color} size={40} looking={shape === s} />
              </button>
            ))}
          </div>
          <div className="flex max-w-[260px] flex-wrap justify-center gap-2.5">
            {BOT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  "h-6 w-6 rounded-full ring-offset-2 ring-offset-popover transition-shadow",
                  color === c && "ring-2 ring-foreground/60",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <RunsOnSwitch value={dockerEndpointId} onChange={setDockerEndpointId} />
          <button type="submit" hidden />
        </form>
        <DialogFooter className="m-0 rounded-none border-t border-border bg-transparent px-4 py-3">
          <Button variant="secondary" className="rounded-full px-4" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="rounded-full px-4"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which daemon the new bot's computer will start on (D-86).
 *
 * Renders nothing at all until an endpoint exists: someone with one machine
 * has no choice to make, and a dialog this small should not show a control
 * whose only option is the default.
 */
function RunsOnSwitch({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const endpoints = useQuery({ queryKey: ["docker-endpoints"], queryFn: getDockerEndpoints });
  const list = endpoints.data ?? [];
  if (list.length === 0) return null;

  const options = [
    { id: null as string | null, label: "This machine", hint: "Its files and sign-ins stay here." },
    ...list.map((e) => ({
      id: e.id as string | null,
      label: e.name,
      hint:
        e.kind === "remote"
          ? `On ${e.host.replace(/^ssh:\/\//i, "")} — its files and sign-ins live there.`
          : "A daemon on this machine, behind its own socket.",
    })),
  ];
  const chosen = options.find((o) => o.id === value) ?? options[0];

  return (
    <div className="flex flex-col items-center gap-1.5 pt-1">
      <span className="text-[11px] text-muted-foreground">Its computer runs on</span>
      <div className="flex flex-wrap justify-center gap-1">
        {options.map((o) => (
          <button
            key={o.id ?? "this-machine"}
            type="button"
            aria-pressed={value === o.id}
            title={o.hint}
            onClick={() => onChange(o.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] transition-colors",
              value === o.id
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground">{chosen.hint}</span>
    </div>
  );
}
