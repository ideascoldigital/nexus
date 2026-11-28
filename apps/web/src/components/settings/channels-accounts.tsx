"use client";

// Connect apps → Communications and Accounts (spec 39), in the same look as
// "Apps for bots": a list of apps with Connected / Connect, and one app's page
// with a back link. Communications are Telegram and Slack (where Nexus
// notifies you and takes replies); Accounts are GitHub, GitLab and ClickUp
// (where it reads issues and repositories).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2 } from "lucide-react";

import { ClickUpAccountsSection } from "@/components/clickup/clickup-accounts-section";
import { AppIcon } from "@/components/connectors/connect-apps";
import { GitHubAccountsSection } from "@/components/github/github-accounts-section";
import { GitLabServersSection } from "@/components/gitlab/gitlab-servers-section";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getSlackStatus, getTelegramBot } from "@/services/sandbox";

type Setting = { key: string; value: string };

export type KeyField = { key: string; label: string; help: string; placeholder: string; secret: boolean };

export type App = {
  id: string;
  name: string;
  /** The Settings row's provider label, when it is not the id (legacy AI keys). */
  providerName?: string;
  tagline: string;
  steps?: string[];
  fields?: KeyField[];
};

const COMMUNICATIONS: App[] = [
  {
    id: "telegram",
    name: "Telegram",
    tagline: "Notifications, and remote control from your phone",
    steps: [
      "In Telegram, talk to @BotFather and send /newbot. Copy the token it gives you.",
      "Message your new bot /start, so it can write to you.",
      "Paste the token here. The chat id is where notifications go by default — each project can pick its own.",
    ],
    fields: [
      { key: "telegram_bot_token", label: "Bot token", help: "From @BotFather", placeholder: "123456789:AAF…", secret: true },
      { key: "telegram_chat_id", label: "Default chat id", help: "Message your bot /start to get it", placeholder: "123456789", secret: false },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    tagline: "Channel notifications; reply in a thread to follow up",
    steps: [
      "Create an app at api.slack.com/apps with the bot scopes chat:write, files:write, channels:read, channels:manage, channels:history (and groups:read/history for private channels). Install it and copy the Bot token (xoxb-…).",
      "For replies in threads: enable Socket Mode, create an app-level token with connections:write (xapp-…) and subscribe to message.channels / message.groups.",
      "Invite the bot to the channel. Each project can pick its own channel.",
    ],
    fields: [
      { key: "slack_bot_token", label: "Bot token", help: "xoxb-…", placeholder: "xoxb-…", secret: true },
      { key: "slack_app_token", label: "App token", help: "xapp-… — needed for replies in threads", placeholder: "xapp-…", secret: true },
      { key: "slack_channel_id", label: "Default channel", help: "A name (#deploys) or an id", placeholder: "#nexux-notifications", secret: false },
    ],
  },
];

const ACCOUNTS: App[] = [
  { id: "github", name: "GitHub", tagline: "Import issues and pick repositories, with personal access tokens" },
  { id: "gitlab", name: "GitLab", tagline: "gitlab.com and self-hosted servers, each with its URL and token" },
  { id: "clickup", name: "ClickUp", tagline: "Work with tasks, lists and workspaces, through OAuth" },
];

export function ChannelsAndAccounts({ kind }: { kind: "communications" | "accounts" }) {
  const apps = kind === "communications" ? COMMUNICATIONS : ACCOUNTS;
  const [openId, setOpenId] = useState<string | null>(null);
  const status = useAppStatus();
  const open = apps.find((a) => a.id === openId);

  if (open) {
    return (
      <div className="space-y-5">
        <button type="button" onClick={() => setOpenId(null)} className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />
          All {kind === "communications" ? "channels" : "accounts"}
        </button>
        <div className="flex items-center gap-3">
          <AppIcon id={open.id} size={48} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold">{open.name}</h3>
            <p className="text-[12.5px] text-muted-foreground">{open.tagline}</p>
          </div>
          {status[open.id]?.connected && (
            <span className="text-[12.5px] font-medium text-emerald-500">{status[open.id]?.as ?? "Connected"}</span>
          )}
        </div>
        {open.fields ? (
          <KeysForm app={open} />
        ) : open.id === "github" ? (
          <GitHubAccountsSection bare />
        ) : open.id === "gitlab" ? (
          <GitLabServersSection bare />
        ) : (
          <ClickUpAccountsSection bare />
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-x-6 sm:grid-cols-2">
      {apps.map((a) => {
        const s = status[a.id];
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => setOpenId(a.id)}
            className="group flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-accent/50"
          >
            <AppIcon id={a.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{a.name}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{s?.connected && s.as ? s.as : a.tagline}</span>
            </span>
            {s?.connected ? (
              <span className="shrink-0 px-3 text-[12.5px] font-medium text-emerald-500">Connected</span>
            ) : (
              <span className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-medium group-hover:bg-accent/80">Connect</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Who each app is connected as, for the list's Connected / Connect. */
function useAppStatus(): Record<string, { connected: boolean; as: string | null } | undefined> {
  const telegram = useQuery({ queryKey: ["telegram-bot"], queryFn: getTelegramBot, staleTime: 60_000 });
  const slack = useQuery({ queryKey: ["slack-status"], queryFn: getSlackStatus, staleTime: 60_000 });
  const count = (url: string) => async () => {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as unknown[]).length : 0;
  };
  const github = useQuery({ queryKey: ["github-accounts", "count"], queryFn: count("/api/github/accounts"), staleTime: 30_000 });
  const gitlab = useQuery({ queryKey: ["gitlab-accounts", "count"], queryFn: count("/api/gitlab/accounts"), staleTime: 30_000 });
  const clickup = useQuery({ queryKey: ["clickup-accounts", "count"], queryFn: count("/api/clickup/accounts"), staleTime: 30_000 });
  const n = (v: number | undefined, one: string) =>
    v ? { connected: true, as: v === 1 ? `1 ${one}` : `${v} ${one}s` } : { connected: false, as: null };
  return {
    telegram: telegram.data
      ? { connected: telegram.data.configured, as: telegram.data.username ? `@${telegram.data.username}` : null }
      : undefined,
    slack: slack.data ? { connected: slack.data.configured, as: slack.data.team } : undefined,
    github: n(github.data, "account"),
    gitlab: n(gitlab.data, "server"),
    clickup: n(clickup.data, "account"),
  };
}

const field =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring";

/** Telegram / Slack: how to get the keys, then the keys, saved one by one. */
export function KeysForm({ app }: { app: App }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Could not load settings");
      return (await res.json()) as Setting[];
    },
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["settings"] });
    qc.invalidateQueries({ queryKey: ["telegram-bot"] });
    qc.invalidateQueries({ queryKey: ["slack-status"] });
  };
  const save = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, provider: app.providerName ?? app.id, isActive: true }),
      });
      if (!res.ok) throw new Error("Could not save it");
    },
    onSuccess: (_d, { key }) => {
      setDraft((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      refresh();
      toast({ title: "Saved" });
    },
    onError: (err) => toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/settings?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove it");
    },
    onSuccess: refresh,
  });
  const saved = (key: string) => settings.data?.find((s) => s.key === key) ?? null;

  return (
    <div className="space-y-4">
      {app.steps && (
        <ol className="list-decimal space-y-1.5 rounded-2xl border border-border bg-card/60 py-3.5 pr-4 pl-9 text-[12.5px] text-muted-foreground">
          {app.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      <div className="space-y-3">
        {app.fields!.map((f) => {
          const current = saved(f.key);
          const editing = f.key in draft || !current;
          return (
            <div key={f.key} className="space-y-1.5">
              <div className="flex items-baseline gap-2 px-1">
                <span className="text-[12.5px] font-medium">{f.label}</span>
                <span className="truncate text-[11.5px] text-muted-foreground">{f.help}</span>
              </div>
              {editing ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const value = (draft[f.key] ?? "").trim();
                    if (value) save.mutate({ key: f.key, value });
                  }}
                >
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className={field}
                  />
                  <Button type="submit" size="sm" className="h-9 shrink-0 rounded-lg" disabled={!(draft[f.key] ?? "").trim() || save.isPending}>
                    {save.isPending && save.variables?.key === f.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save
                  </Button>
                  {current && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-9 shrink-0 rounded-lg"
                      onClick={() =>
                        setDraft((d) => {
                          const next = { ...d };
                          delete next[f.key];
                          return next;
                        })
                      }
                    >
                      Cancel
                    </Button>
                  )}
                </form>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {f.secret ? "•••••••••••••" : current!.value}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, [f.key]: "" }))}
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(f.key)}
                    className="text-[12px] text-muted-foreground hover:text-destructive"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
