"use client";

// The bot's side panel: its face and name, then Activity (what it is doing,
// its computer) and Settings (job, standing instructions, model, idle time).

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Clock, Loader2, Trash2, X } from "lucide-react";

import { BotAvatar } from "@/components/bots/bot-avatar";
import { ComputerCard, computerState } from "@/components/bots/bot-computer";
import { RoutineDialog } from "@/components/bots/bot-routine-dialog";
import { Button } from "@/components/ui/button";
import { DockerEndpointPicker } from "@/components/projects/docker-endpoint-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { parseBotMcpJson } from "@/lib/bot-mcp";
import { promptLabel } from "@/lib/bot-routines";
import { BOT_COLORS, BOT_SHAPES } from "@/lib/bot-shapes";
import { cn } from "@/lib/utils";
import {
  deleteBot,
  updateBot,
  updateBotRoutine,
  type BotFeed,
  type BotInput,
  type BotListItem,
  type BotRoutine,
} from "@/services/bots";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-[12px] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function BotPanel({
  bot,
  feed,
  onClose,
  onOpenComputer,
  onDeleted,
}: {
  bot: BotListItem;
  feed: BotFeed | undefined;
  onClose: () => void;
  onOpenComputer: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<"activity" | "settings">("activity");
  const running = feed?.runs.find((r) => r.status === "running") ?? null;
  const queued = feed?.runs.filter((r) => r.status === "queued") ?? [];
  const asleep = computerState(feed) === "asleep";

  return (
    <aside className="relative flex w-full shrink-0 flex-col overflow-y-auto border-l border-border bg-background lg:w-[340px] xl:w-[380px]">
      <div data-tauri-drag-region className="titlebar-only absolute inset-x-0 top-0 h-10" />
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-3 right-3 rounded-full"
        onClick={onClose}
        aria-label="Close panel"
        title="Close panel"
      >
        <X className="h-4 w-4" />
      </Button>

      <div className="flex flex-col items-center gap-3 px-6 pt-10 pb-4 text-center">
        <BotAvatar shape={bot.shape} color={bot.color} size={76} sleeping={asleep} />
        <div className="space-y-0.5">
          <h2 className="text-[16px] font-medium">{bot.name}</h2>
          {bot.role && <p className="text-[12px] text-muted-foreground">{bot.role}</p>}
        </div>
        <div className="flex gap-1">
          {(["activity", "settings"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[12.5px] capitalize transition-colors",
                tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-5 px-4 pb-6">
        {tab === "activity" ? (
          <>
            <Section title="Now">
              <div className="rounded-xl border border-border bg-card/60 px-3 py-2.5 text-[13px]">
                {running ? (
                  <>
                    <div className="line-clamp-2">{promptLabel(running.prompt)}</div>
                    <div className="mt-0.5 text-[11.5px] text-sky-400">
                      Working{running.steps.length ? ` · ${running.steps.length} steps so far` : "…"}
                    </div>
                  </>
                ) : (
                  <span className="text-muted-foreground">Nothing in progress</span>
                )}
                {queued.length > 0 && (
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    {queued.length} more queued
                  </div>
                )}
              </div>
            </Section>
            <Routines bot={bot} routines={feed?.routines ?? []} />
            <Section title="Computer">
              <ComputerCard bot={bot} feed={feed} onOpen={onOpenComputer} />
            </Section>
          </>
        ) : (
          <BotSettings key={bot.id} bot={bot} onDeleted={onDeleted} />
        )}
      </div>
    </aside>
  );
}

const HIDE_SUGGESTION_KEY = "nexux:bots-hide-routine-suggestion";

function readHidden(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(HIDE_SUGGESTION_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/** "Upcoming": the bot's routines with an on/off switch; a suggestion when it has none. */
function Routines({ bot, routines }: { bot: BotListItem; routines: BotRoutine[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<BotRoutine | "new" | null>(null);
  const [hidden, setHidden] = useState(() => (typeof window === "undefined" ? [] : readHidden()));
  const toggle = useMutation({
    mutationFn: (r: BotRoutine) => updateBotRoutine(bot.id, r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-feed", bot.id] }),
  });

  const dialog = (
    <RoutineDialog
      open={editing !== null}
      onOpenChange={(o) => !o && setEditing(null)}
      bot={bot}
      routine={editing === "new" ? null : editing}
    />
  );

  if (routines.length === 0) {
    if (hidden.includes(bot.id)) return dialog;
    return (
      <>
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[12px] text-muted-foreground">Suggested</h3>
            <button
              type="button"
              className="text-[11.5px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                const next = [...hidden, bot.id];
                setHidden(next);
                try {
                  window.localStorage.setItem(HIDE_SUGGESTION_KEY, JSON.stringify(next));
                } catch {
                  // storage blocked: hidden for this visit only
                }
              }}
            >
              Hide
            </button>
          </div>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card/60 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-card"
          >
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">Create a routine</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </section>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Section title="Upcoming">
        <div className="space-y-2">
          {routines.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-card/60 px-3 py-2.5 transition-colors hover:bg-card"
            >
              <button type="button" onClick={() => setEditing(r)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className={cn("block truncate text-[13px]", !r.enabled && "text-muted-foreground")}>{r.name}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {r.enabled ? r.label : `Paused · ${r.label}`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={r.enabled}
                aria-label={r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(r)}
                className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                style={{ background: r.enabled ? bot.color : "var(--input)" }}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]",
                    r.enabled ? "left-[18px]" : "left-0.5",
                  )}
                />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="px-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            + New routine
          </button>
        </div>
      </Section>
      {dialog}
    </>
  );
}

function BotSettings({ bot, onDeleted }: { bot: BotListItem; onDeleted: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<BotInput>({
    name: bot.name,
    role: bot.role ?? "",
    instructions: bot.instructions,
    color: bot.color,
    shape: bot.shape,
    model: bot.model ?? "",
    idleMinutes: bot.idleMinutes,
    dockerEndpointId: bot.dockerEndpointId ?? null,
  });
  // MCP servers edit as raw JSON (the native mcpServers shape), checked on save.
  const [mcpJson, setMcpJson] = useState(() =>
    bot.mcpServers && Object.keys(bot.mcpServers).length ? JSON.stringify(bot.mcpServers, null, 2) : "",
  );
  const mcp = parseBotMcpJson(mcpJson);

  const done = () => {
    qc.invalidateQueries({ queryKey: ["bots"] });
    qc.invalidateQueries({ queryKey: ["bot-feed", bot.id] });
  };
  const save = useMutation({
    mutationFn: () =>
      updateBot(bot.id, {
        ...form,
        name: form.name.trim(),
        role: form.role?.trim() || null,
        model: form.model?.trim() || null,
        mcpServers: mcp.ok ? mcp.servers : undefined,
      }),
    onSuccess: () => {
      done();
      toast({ title: "Saved" });
    },
    onError: (err) =>
      toast({ title: "Could not save", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: () => deleteBot(bot.id),
    onSuccess: () => {
      onDeleted();
      qc.invalidateQueries({ queryKey: ["bots"] });
    },
    onError: (err) =>
      toast({ title: "Could not delete the bot", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const field =
    "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mcp.ok) {
          toast({ title: "Check the MCP servers", description: mcp.error, variant: "destructive" });
          return;
        }
        if (form.name.trim()) save.mutate();
      }}
    >
      <Section title="Name">
        <input className={field} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Section>
      <Section title="Job">
        <input
          className={field}
          value={form.role ?? ""}
          placeholder="Finds and compares vendors on the web"
          onChange={(e) => setForm({ ...form, role: e.target.value })}
        />
      </Section>
      <Section title="Standing instructions">
        <textarea
          className={cn(field, "min-h-28 resize-y")}
          value={form.instructions}
          placeholder="Always cite the page you got each fact from."
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
        />
      </Section>
      <Section title="Tools (MCP servers)">
        <textarea
          className={cn(field, "min-h-24 resize-y font-mono text-[12px] leading-5", !mcp.ok && "border-destructive")}
          value={mcpJson}
          spellCheck={false}
          placeholder={`{\n  "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },\n  "my-api": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer {{secret:my-api-token}}" } }\n}`}
          onChange={(e) => setMcpJson(e.target.value)}
        />
        <p className={cn("px-1 text-[11.5px]", mcp.ok ? "text-muted-foreground" : "text-destructive")}>
          {mcp.ok
            ? "Claude Code's mcpServers JSON, loaded on its computer from the next message. Keep keys in the Vault and write {{secret:name}} here — never the key itself. Sign-in (OAuth) MCPs can't open a login here. Commands run inside the bot's computer (Node and npx are there)."
            : mcp.error}
        </p>
      </Section>
      <Section title="Look">
        <div className="space-y-3 rounded-xl border border-border bg-card/60 p-3">
          <div className="flex flex-wrap gap-1.5">
            {BOT_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Shape ${s}`}
                onClick={() => setForm({ ...form, shape: s })}
                className={cn("group rounded-lg p-0.5", form.shape === s ? "bg-accent ring-1 ring-foreground/25" : "hover:bg-accent/60")}
              >
                <BotAvatar shape={s} color={form.color ?? bot.color} size={26} looking={form.shape === s} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {BOT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setForm({ ...form, color: c })}
                className={cn("h-5 w-5 rounded-full ring-offset-2 ring-offset-background", form.color === c && "ring-2 ring-foreground/60")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      </Section>
      <div className="grid grid-cols-2 gap-3">
        <Section title="Model">
          <input
            className={field}
            value={form.model ?? ""}
            placeholder="default"
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
        </Section>
        <Section title="Sleep after (min)">
          <input
            className={field}
            type="number"
            min={5}
            max={1440}
            value={form.idleMinutes ?? 30}
            onChange={(e) => setForm({ ...form, idleMinutes: Number(e.target.value) || 30 })}
          />
        </Section>
      </div>
      {/* Renders nothing unless an endpoint exists, so one machine sees no choice. */}
      <DockerEndpointPicker
        value={form.dockerEndpointId ?? null}
        onChange={(id) => setForm({ ...form, dockerEndpointId: id })}
        mountOnlyRepos={[]}
        title="Computer runs on"
        description="Where this bot's computer starts — and so where its files and its sign-ins live."
      />
      {(form.dockerEndpointId ?? null) !== (bot.dockerEndpointId ?? null) && (
        <p className="text-[11px] text-amber-300/90">
          A computer that is already awake stays where it is — this applies to the
          next one. Its workspace and sign-ins live wherever it runs, so the next
          computer starts fresh there.
        </p>
      )}
      <div className="flex items-center justify-between pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => setConfirmDelete(true)}
        >
          {remove.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Delete bot
        </Button>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${bot.name}?`}
          description="Its computer and chat history go with it."
          confirmLabel="Delete bot"
          onConfirm={() => remove.mutate()}
        />
        <Button type="submit" size="sm" className="rounded-full px-4" disabled={!form.name.trim() || save.isPending}>
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
