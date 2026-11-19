"use client";

// Create or edit a routine by hand: what the bot does, and when. The bot can
// also create and change routines itself from the chat.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  cronFromSchedule,
  describeCron,
  scheduleFromCron,
  type RoutineFreq,
  type RoutineSchedule,
} from "@/lib/bot-routines";
import {
  createBotRoutine,
  deleteBotRoutine,
  runBotRoutine,
  updateBotRoutine,
  type BotListItem,
  type BotRoutine,
} from "@/services/bots";

const FREQS: { value: RoutineFreq; label: string }[] = [
  { value: "day", label: "Every day" },
  { value: "weekday", label: "Every weekday" },
  { value: "week", label: "Every week" },
  { value: "month", label: "Every month" },
  { value: "hour", label: "Every hour" },
  { value: "custom", label: "Custom (cron)" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

export function RoutineDialog({
  open,
  onOpenChange,
  bot,
  routine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: BotListItem;
  /** Null to create one. */
  routine: BotRoutine | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        {open && (
          <RoutineForm key={routine?.id ?? "new"} bot={bot} routine={routine} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoutineForm({
  bot,
  routine,
  onDone,
}: {
  bot: BotListItem;
  routine: BotRoutine | null;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(routine?.name ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(() =>
    scheduleFromCron(routine?.cron ?? "0 9 * * 1"),
  );
  const cron = cronFromSchedule(schedule);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bot-feed", bot.id] });
    qc.invalidateQueries({ queryKey: ["bots"] });
  };
  const onError = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const save = useMutation({
    mutationFn: () =>
      routine
        ? updateBotRoutine(bot.id, routine.id, { name: name.trim(), prompt: prompt.trim(), cron })
        : createBotRoutine(bot.id, { name: name.trim(), prompt: prompt.trim(), cron }),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: onError("Could not save the routine"),
  });
  const remove = useMutation({
    mutationFn: () => deleteBotRoutine(bot.id, routine!.id),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: onError("Could not delete the routine"),
  });
  const runNow = useMutation({
    mutationFn: () => runBotRoutine(bot.id, routine!.id),
    onSuccess: () => {
      refresh();
      onDone();
      toast({ title: `${bot.name} is on it` });
    },
    onError: onError("Could not run the routine"),
  });

  const set = (patch: Partial<RoutineSchedule>) => setSchedule((s) => ({ ...s, ...patch }));
  const valid = name.trim() && prompt.trim() && cron.split(/\s+/).length === 5;

  return (
    <>
      <DialogHeader className="border-b border-border px-4 py-3.5">
        <DialogTitle className="text-[14px] font-semibold">{routine ? "Routine" : "Create a routine"}</DialogTitle>
      </DialogHeader>
      <form
        className="space-y-4 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted-foreground">Name</span>
          <input className={field} value={name} maxLength={120} autoFocus={!routine} onChange={(e) => setName(e.target.value)} placeholder="Update the expense log" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] text-muted-foreground">What {bot.name} does each time</span>
          <textarea
            className={`${field} min-h-28 resize-y`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Check the inbox for new invoices and add each one as a row in the expense sheet."
          />
        </label>
        <div className="space-y-1.5">
          <span className="text-[12px] text-muted-foreground">When</span>
          <div className="flex flex-wrap gap-2">
            <select className={`${field} w-auto`} value={schedule.freq} onChange={(e) => set({ freq: e.target.value as RoutineFreq })}>
              {FREQS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            {schedule.freq === "week" && (
              <select className={`${field} w-auto`} value={schedule.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    on {d}
                  </option>
                ))}
              </select>
            )}
            {schedule.freq === "month" && (
              <select className={`${field} w-auto`} value={schedule.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    on day {d}
                  </option>
                ))}
              </select>
            )}
            {schedule.freq !== "custom" && schedule.freq !== "hour" && (
              <input type="time" className={`${field} w-auto`} value={schedule.time} onChange={(e) => set({ time: e.target.value })} />
            )}
            {schedule.freq === "custom" && (
              <input
                className={`${field} flex-1 font-mono`}
                value={schedule.cron}
                onChange={(e) => set({ cron: e.target.value })}
                placeholder="0 8 * * 1"
              />
            )}
          </div>
          <p className="text-[11.5px] text-muted-foreground">{describeCron(cron)}, your local time.</p>
        </div>
        <button type="submit" hidden />
      </form>
      <DialogFooter className="m-0 flex-row items-center rounded-none border-t border-border bg-transparent px-4 py-3 sm:justify-between">
        <div className="flex gap-1">
          {routine && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={remove.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete the routine "${routine.name}"?`}
                onConfirm={() => remove.mutate()}
              />
              <Button variant="ghost" size="sm" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
                <Play className="h-3.5 w-3.5" />
                Run now
              </Button>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="rounded-full px-4" onClick={onDone}>
            Cancel
          </Button>
          <Button className="rounded-full px-4" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {routine ? "Save" : "Create"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
