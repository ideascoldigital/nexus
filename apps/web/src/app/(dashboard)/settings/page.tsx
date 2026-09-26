"use client";

// Settings, laid out as an instrument panel: a grouped rail that shows at a
// glance what is wired (configured counters per section, inherited markers)
// and a single reading column per section. The rail replaces seven cramped
// horizontal tabs; ?tab= deep links and the stored last-tab keep working.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  AppWindow,
  Bot,
  Columns3,
  Cloud,
  DatabaseBackup,
  Terminal as TerminalIcon,
  Eye,
  EyeOff,
  GitBranch,
  MessageSquare,
  Plug,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandIcon } from "@/components/ui/brand-icon";
import { getSlackStatus, getTelegramBot } from "@/services/sandbox";
import { AppHeader } from "@/components/layout/app-header";
import { GitHubAccountsSection } from "@/components/github/github-accounts-section";
import { ClickUpAccountsSection } from "@/components/clickup/clickup-accounts-section";
import { GitLabServersSection } from "@/components/gitlab/gitlab-servers-section";
import { ApiTokensSection } from "@/components/settings/api-tokens";
import { BackupMigrationSection } from "@/components/settings/backup-migration";
import { HostModelSection } from "@/components/settings/host-model";
import { AppearanceSection } from "@/components/settings/appearance";
import { DesktopAppSection } from "@/components/settings/desktop-app";
import { DockerEndpointsSection } from "@/components/settings/docker-endpoints";
import { NexusHostsSection } from "@/components/settings/nexus-hosts";
import { SandboxNamingSection } from "@/components/settings/sandbox-naming";
import { TerminalShellSection } from "@/components/settings/terminal-shell";
import {
  ClaudeCredentialsSection,
  CloudCredentialsSection,
  GitCredentialsSection,
  LlmCredentialsSection,
  TailscaleCredentialsSection,
} from "@/components/settings/cloud-credentials";

type Setting = {
  id: string;
  key: string;
  value: string;
  provider: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Row inherited from the Personal workspace (API marks it). */
  inherited?: boolean;
};

type Provider = {
  name: string;
  key: string;
  description: string;
  placeholder: string;
};

const AI_PROVIDERS: Provider[] = [
  {
    name: "Anthropic (Claude)",
    key: "anthropic_api_key",
    description: "API key for Claude AI models",
    placeholder: "sk-ant-api03-...",
  },
  {
    name: "OpenAI",
    key: "openai_api_key",
    description: "API key for GPT models",
    placeholder: "sk-...",
  },
  {
    name: "xAI (Grok)",
    key: "xai_api_key",
    description: "API key for Grok models",
    placeholder: "xai-...",
  },
  {
    name: "Z.ai (GLM)",
    key: "zai_api_key",
    description: "API key for GLM models (global fallback for sandboxes)",
    placeholder: "Z.ai API key",
  },
  {
    name: "Codex",
    key: "codex_api_key",
    description: "API key for Codex AI models",
    placeholder: "codex-...",
  },
  {
    name: "Ollama URL",
    key: "ollama_url",
    description: "Base URL for Ollama server",
    placeholder: "http://localhost:11434",
  },
  {
    name: "LM Studio URL",
    key: "lmstudio_url",
    description: "Base URL for LM Studio server",
    placeholder: "http://localhost:1234",
  },
];

/**
 * Each AI provider card wears its real brand mark and tint. Codex ships the
 * OpenAI mark on purpose (it is OpenAI Codex); Z.ai has no mark in
 * simple-icons, so it wears a letter glyph.
 */
const AI_PROVIDER_META: Record<
  string,
  { icon: React.ReactNode; tile: string }
> = {
  anthropic_api_key: {
    icon: <BrandIcon brand="anthropic" className="h-4 w-4 text-[#D97757]" />,
    tile: "border-[#D97757]/25 bg-[#D97757]/10",
  },
  openai_api_key: {
    icon: <BrandIcon brand="openai" className="h-4 w-4 text-white/90" />,
    tile: "border-white/15 bg-white/5",
  },
  xai_api_key: {
    icon: <BrandIcon brand="x" className="h-3.5 w-3.5 text-white/90" />,
    tile: "border-white/15 bg-white/5",
  },
  zai_api_key: {
    icon: (
      <span className="text-sm leading-none font-black text-amber-300">Z</span>
    ),
    tile: "border-amber-400/20 bg-amber-400/10",
  },
  codex_api_key: {
    icon: <BrandIcon brand="openai" className="h-4 w-4 text-emerald-300" />,
    tile: "border-emerald-500/20 bg-emerald-500/10",
  },
  ollama_url: {
    icon: <BrandIcon brand="ollama" className="h-4 w-4 text-white/90" />,
    tile: "border-white/15 bg-white/5",
  },
  lmstudio_url: {
    icon: <BrandIcon brand="lmstudio" className="h-4 w-4 text-indigo-300" />,
    tile: "border-indigo-500/20 bg-indigo-500/10",
  },
};

const TELEGRAM_PROVIDERS: Provider[] = [
  {
    name: "Telegram Bot",
    key: "telegram_bot_token",
    description:
      "Bot token from @BotFather — task notifications and remote control from your phone",
    placeholder: "123456789:AAF...",
  },
  {
    name: "Telegram Chat ID",
    key: "telegram_chat_id",
    description:
      "Default chat for notifications (message your bot /start to get it). Projects can override it with their own chat in sandbox settings",
    placeholder: "123456789",
  },
];

const SLACK_PROVIDERS: Provider[] = [
  {
    name: "Slack Bot Token",
    key: "slack_bot_token",
    description:
      "Bot User OAuth Token (xoxb-…) from api.slack.com/apps — scopes: chat:write, files:write, channels:read, channels:manage, channels:history (+ groups:read/history for private channels). Invite the bot to the channel",
    placeholder: "xoxb-...",
  },
  {
    name: "Slack App Token",
    key: "slack_app_token",
    description:
      "App-level token (xapp-…) with connections:write — enables Socket Mode so replying in a notification's thread sends the follow-up. Enable Socket Mode and subscribe to message.channels/message.groups events in the app config",
    placeholder: "xapp-...",
  },
  {
    name: "Slack Channel",
    key: "slack_channel_id",
    description:
      "Default channel for notifications — the name works (deploys or #deploys), an ID too. Projects can pick their own channel in sandbox settings",
    placeholder: "#nexux-notifications",
  },
];

// One flat list still feeds the rail's n/m counter.
const COMMUNICATION_PROVIDERS: Provider[] = [
  ...TELEGRAM_PROVIDERS,
  ...SLACK_PROVIDERS,
];

const SETTINGS_TABS = [
  "ai",
  "cloud",
  "git",
  "communications",
  "integrations",
  "terminal",
  "appearance",
  "desktop",
  "backup",
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_STORAGE_KEY = "nexux:settings:tab";
const isSettingsTab = (v: string | null): v is SettingsTab =>
  (SETTINGS_TABS as readonly string[]).includes(v ?? "");

type NavItem = {
  id: SettingsTab;
  label: string;
  icon: typeof Bot;
  description: string;
  /** KV keys whose configured count the rail shows for this section. */
  keys?: Provider[];
};

// The rail's mental model: what thinks (providers), what talks (channels &
// apps), what the machine itself needs (system).
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Providers",
    items: [
      {
        id: "ai",
        label: "AI Providers",
        icon: Bot,
        description:
          "API keys and local server URLs for the brains Nexus can run. Stored locally, masked here.",
        keys: AI_PROVIDERS,
      },
      {
        id: "cloud",
        label: "Cloud",
        icon: Cloud,
        description:
          "Compute credentials for sandboxes, the tailnet key that reaches your hosts, other machines' Docker for local sandboxes, and how new machines get their names.",
      },
      {
        id: "git",
        label: "Git",
        icon: GitBranch,
        description:
          "Tokens for the git hosts your repositories live on — cloning, pushing and opening PRs from sandboxes.",
      },
    ],
  },
  {
    label: "Channels & apps",
    items: [
      {
        id: "communications",
        label: "Communications",
        icon: MessageSquare,
        description:
          "Where Nexus notifies you and takes replies — Telegram (with remote control) and Slack (reply in a thread to follow up).",
        keys: COMMUNICATION_PROVIDERS,
      },
      {
        id: "integrations",
        label: "Integrations",
        icon: Plug,
        description:
          "Connected accounts (outbound) and the API tokens other systems use to reach Nexus (inbound).",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        id: "terminal",
        label: "Terminal",
        icon: TerminalIcon,
        description: "The shell the in-app terminal opens with.",
      },
      {
        id: "appearance",
        label: "Appearance",
        icon: Columns3,
        description: "Theme, zoom, and how pages use the window.",
      },
      {
        id: "desktop",
        label: "Desktop app",
        icon: AppWindow,
        description:
          "Which database and data folder the desktop app opens — point it at your dev database to test the packaged app on real data.",
      },
      {
        id: "backup",
        label: "Backup & migration",
        icon: DatabaseBackup,
        description:
          "Nexus hosts to move onto, and taking your configuration with you.",
      },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function SettingsPageContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // Selected tab survives reloads and in-app navigation: ?tab= wins (so links
  // are shareable), otherwise the last tab the user opened. Reading location
  // directly — not the useSearchParams snapshot, which lags our replaceState.
  const readTab = (): SettingsTab => {
    if (typeof window === "undefined") {
      const param = searchParams.get("tab");
      return isSettingsTab(param) ? param : "ai";
    }
    const param = new URLSearchParams(window.location.search).get("tab");
    if (isSettingsTab(param)) return param;
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return isSettingsTab(stored) ? stored : "ai";
  };
  const [activeTab, setActiveTab] = useState<SettingsTab>(readTab);
  // Write the restored tab back into the URL so a reload or a copied link
  // carries it. Mount only — later changes go through setTab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", activeTab);
    window.history.replaceState(window.history.state, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back/forward and in-app links change the router's params without
  // remounting; re-resolve then. Our replaceState writes don't notify
  // useSearchParams, so this won't fight setTab.
  const isFirstSync = useRef(true);
  useEffect(() => {
    if (isFirstSync.current) {
      isFirstSync.current = false;
      return;
    }
    setActiveTab(readTab());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const setTab = (value: string) => {
    if (!isSettingsTab(value)) return;
    setActiveTab(value);
    if (typeof window === "undefined") return;
    localStorage.setItem(TAB_STORAGE_KEY, value);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", value);
    window.history.replaceState(window.history.state, "", url.toString());
  };
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [showValue, setShowValue] = useState<Record<string, boolean>>({});
  const [formData, setFormData] = useState<Record<string, string>>({});

  const { data: settings = [], isLoading } = useQuery<Setting[]>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  // Connection identities for the app cards — who the tokens actually are.
  const telegramBot = useQuery({
    queryKey: ["telegram-bot"],
    queryFn: getTelegramBot,
    enabled: activeTab === "communications",
    staleTime: 60_000,
  });
  const slackStatus = useQuery({
    queryKey: ["slack-status"],
    queryFn: getSlackStatus,
    enabled: activeTab === "communications",
    staleTime: 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      key,
      value,
      provider,
    }: {
      key: string;
      value: string;
      provider: string;
    }) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, provider, isActive: true }),
      });
      if (!res.ok) throw new Error("Failed to save setting");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      // A new token changes who the app cards say they're connected as.
      queryClient.invalidateQueries({ queryKey: ["telegram-bot"] });
      queryClient.invalidateQueries({ queryKey: ["slack-status"] });
      setEditingKey(null);
      setFormData({});
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/settings?key=${key}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete setting");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["telegram-bot"] });
      queryClient.invalidateQueries({ queryKey: ["slack-status"] });
    },
  });

  const handleSave = (providerKey: string, providerName: string) => {
    const value = formData[providerKey];
    if (!value) return;

    saveMutation.mutate({
      key: providerKey,
      value,
      provider: providerName,
    });
  };

  const toggleShowValue = (key: string) => {
    setShowValue((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const getSettingByKey = (key: string) => {
    return settings.find((s) => s.key === key);
  };

  const configuredCount = (providers: Provider[]) =>
    providers.filter((p) => getSettingByKey(p.key)).length;

  // Shared key controls (input + add/update/delete) — plain render functions
  // (not components) so inputs keep focus across re-renders. The full row is
  // used by Communications; the AI provider cards use the controls alone.
  const renderKeyControls = (provider: Provider) => {
    const setting = getSettingByKey(provider.key);
    const isEditing = editingKey === provider.key;
    const hasValue = !!setting;

    return (
      <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showValue[provider.key] ? "text" : "password"}
              placeholder={provider.placeholder}
              value={
                // Configured + not editing → show the stored (masked) value.
                // Otherwise (new key, or editing an existing one) → reflect
                // what's being typed.
                hasValue && !isEditing
                  ? setting?.value || ""
                  : formData[provider.key] || ""
              }
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  [provider.key]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                // Enter saves — works for both new (Add) and editing (Save)
                // flows.
                if (
                  e.key === "Enter" &&
                  formData[provider.key] &&
                  !saveMutation.isPending
                ) {
                  handleSave(provider.key, provider.name);
                }
              }}
              disabled={hasValue && !isEditing}
              className="pr-10 font-mono text-xs"
            />
            {hasValue && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-2 -translate-y-1/2"
                onClick={() => toggleShowValue(provider.key)}
              >
                {showValue[provider.key] ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>

          {isEditing ? (
            <>
              <Button
                size="sm"
                onClick={() => handleSave(provider.key, provider.name)}
                disabled={!formData[provider.key] || saveMutation.isPending}
              >
                <Save className="mr-1.5 h-4 w-4" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingKey(null);
                  setFormData((prev) => ({ ...prev, [provider.key]: "" }));
                }}
              >
                Cancel
              </Button>
            </>
          ) : hasValue ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingKey(provider.key);
                  setFormData((prev) => ({ ...prev, [provider.key]: "" }));
                }}
              >
                Update
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => deleteMutation.mutate(provider.key)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          ) : (
            // Unconfigured key: the field is always editable and a single
            // persistent "+ Add" saves whatever is typed — no mode swap,
            // matching the natural type-then-click-Add flow.
            <Button
              size="sm"
              onClick={() => handleSave(provider.key, provider.name)}
              disabled={!formData[provider.key] || saveMutation.isPending}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add
            </Button>
          )}
      </div>
    );
  };

  /** Small "configured hace X / inherited / not configured" status chip. */
  const keyStatusChip = (provider: Provider) => {
    const setting = getSettingByKey(provider.key);
    if (!setting) {
      return (
        <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
          not configured
        </span>
      );
    }
    return (
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {formatDistanceToNow(new Date(setting.updatedAt), {
            addSuffix: true,
          })}
        </span>
        {setting.inherited && (
          <span
            className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-px text-[9px] tracking-wide text-amber-300 uppercase"
            title="Inherited from the Personal workspace — saving here writes this workspace's own value"
          >
            inherited
          </span>
        )}
      </span>
    );
  };

  const renderProviderRow = (provider: Provider) => {
    const setting = getSettingByKey(provider.key);
    const isEditing = editingKey === provider.key;
    const hasValue = !!setting;

    return (
      <div
        key={provider.key}
        className="space-y-3 border-b border-border/50 pb-5 last:border-0 last:pb-0"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{provider.name}</span>
              {hasValue && !isEditing && (
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  configured{" "}
                  {formatDistanceToNow(new Date(setting.updatedAt), {
                    addSuffix: true,
                  })}
                </span>
              )}
              {setting?.inherited && (
                <span
                  className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-px text-[9px] tracking-wide text-amber-300 uppercase"
                  title="Inherited from the Personal workspace — saving here writes this workspace's own value"
                >
                  inherited
                </span>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {provider.description}
            </p>
          </div>
        </div>
        {renderKeyControls(provider)}
      </div>
    );
  };

  const renderKeyList = (providers: Provider[]) =>
    isLoading ? (
      <div className="text-sm text-muted-foreground">Loading settings…</div>
    ) : (
      providers.map(renderProviderRow)
    );

  const active = NAV_ITEMS.find((i) => i.id === activeTab) ?? NAV_ITEMS[0];
  const ActiveIcon = active.icon;

  const navButton = (item: NavItem, compact: boolean) => {
    const Icon = item.icon;
    const isActive = item.id === activeTab;
    const count = item.keys ? configuredCount(item.keys) : null;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setTab(item.id)}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex shrink-0 items-center gap-2.5 rounded-md text-[13px] transition-colors",
          compact ? "px-3 py-1.5" : "w-full px-2.5 py-1.5 text-left",
          isActive
            ? "bg-primary/10 text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        {/* The rail's active marker — a hairline of primary, not a pill. */}
        {isActive && !compact && (
          <span className="absolute top-1.5 bottom-1.5 -left-2 w-0.5 rounded-full bg-primary" />
        )}
        <Icon
          className={cn("h-4 w-4 shrink-0", isActive && "text-primary")}
        />
        <span className="truncate">{item.label}</span>
        {count !== null && item.keys && (
          <span
            className={cn(
              "ml-auto font-mono text-[10px] tabular-nums",
              count > 0 ? "text-emerald-400/90" : "text-muted-foreground/60",
            )}
            title={`${count} of ${item.keys.length} configured`}
          >
            {count}/{item.keys.length}
          </span>
        )}
      </button>
    );
  };

  return (
    // min-h-0: without it this flex child grows past the h-svh overflow-hidden
    // shell and <main>'s overflow-auto never engages (page can't scroll).
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader title="Settings" />

      <main className="flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-page gap-8 px-4 py-6">
          {/* ---- Rail (md+) -------------------------------------------- */}
          <nav
            aria-label="Settings sections"
            className="sticky top-0 hidden w-56 shrink-0 self-start pl-2 md:block"
          >
            <h1 className="px-2.5 text-lg font-semibold tracking-tight">
              Settings
            </h1>
            <p className="px-2.5 pb-2 text-xs text-muted-foreground">
              Keys, machines and channels
            </p>
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="px-2.5 pt-5 pb-1.5 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/70 uppercase">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => navButton(item, false))}
                </div>
              </div>
            ))}
          </nav>

          {/* ---- Content ----------------------------------------------- */}
          <div className="min-w-0 flex-1">
            {/* Small screens get the sections as a scrollable pill row. */}
            <div className="mb-4 flex gap-1 overflow-x-auto pb-1 md:hidden">
              {NAV_ITEMS.map((item) => navButton(item, true))}
            </div>

            {/* Remounts per section so the entrance plays on every switch. */}
            <div
              key={activeTab}
              className="animate-in fade-in slide-in-from-bottom-2 space-y-6 duration-300"
            >
              <header className="flex items-start gap-3 border-b border-border/60 pb-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                  <ActiveIcon className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base leading-tight font-semibold">
                    {active.label}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {active.description}
                  </p>
                </div>
              </header>

              {activeTab === "ai" && (
                <>
                  {isLoading ? (
                    <div className="text-sm text-muted-foreground">
                      Loading settings…
                    </div>
                  ) : (
                    <div className="grid items-start gap-4 xl:grid-cols-2">
                      {AI_PROVIDERS.map((provider) => {
                        const meta =
                          AI_PROVIDER_META[provider.key] ??
                          AI_PROVIDER_META.anthropic_api_key;
                        return (
                          <Card key={provider.key}>
                            <CardContent className="pt-5">
                              <div className="mb-4 flex items-start justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                  <div
                                    className={cn(
                                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                                      meta.tile,
                                    )}
                                  >
                                    {meta.icon}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold">
                                      {provider.name}
                                    </div>
                                    <p
                                      className="truncate text-xs text-muted-foreground"
                                      title={provider.description}
                                    >
                                      {provider.description}
                                    </p>
                                  </div>
                                </div>
                                {keyStatusChip(provider)}
                              </div>
                              {renderKeyControls(provider)}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                  <ClaudeCredentialsSection />
                  <LlmCredentialsSection />
                  {/* Which of the credentials above drives the agents that run
                      on this machine. Right below them, because the choice is
                      meaningless until at least one exists. */}
                  <HostModelSection />
                  <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Keys live in your local database and never leave this
                    machine except toward the provider they belong to. For a
                    shared deployment, prefer environment variables or a
                    secrets manager.
                  </p>
                </>
              )}

              {activeTab === "cloud" && (
                <>
                  <CloudCredentialsSection />
                  {/* Needed to reach a Nexus host — the readiness checklist in
                      Backup & migration links the user here. */}
                  <TailscaleCredentialsSection />
                  {/* Compute you already own: another machine's Docker for
                      local sandboxes (spec 26). */}
                  <DockerEndpointsSection />
                  {/* Names the machines the credentials above provision, and
                      the local docker ones too. */}
                  <SandboxNamingSection />
                </>
              )}

              {activeTab === "git" && <GitCredentialsSection />}

              {activeTab === "communications" && (
                <div className="grid items-start gap-6 xl:grid-cols-2">
                  {/* ---- Telegram ---------------------------------------- */}
                  <Card>
                    <CardContent className="pt-5">
                      <div className="mb-5 flex items-start justify-between gap-3 border-b border-border/50 pb-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-400">
                            <BrandIcon brand="telegram" className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold">
                              Telegram
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Notifications + remote control from your phone
                            </p>
                          </div>
                        </div>
                        {getSettingByKey("telegram_bot_token") ? (
                          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            {telegramBot.data?.username
                              ? `@${telegramBot.data.username}`
                              : "connected"}
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                            not configured
                          </span>
                        )}
                      </div>
                      <div className="space-y-5">
                        {renderKeyList(TELEGRAM_PROVIDERS)}
                      </div>
                      <p className="mt-4 border-t border-border/40 pt-3 text-[11px] leading-relaxed text-muted-foreground">
                        Reply to any notification to follow up; /tasks and
                        /sandboxes work from the chat. Projects can route to
                        their own group in sandbox settings.
                      </p>
                    </CardContent>
                  </Card>

                  {/* ---- Slack ------------------------------------------- */}
                  <Card>
                    <CardContent className="pt-5">
                      <div className="mb-5 flex items-start justify-between gap-3 border-b border-border/50 pb-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-violet-500/20 bg-violet-500/10 text-violet-300">
                            <BrandIcon brand="slack" className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold">Slack</div>
                            <p className="text-xs text-muted-foreground">
                              Channel notifications, threads drive follow-ups
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {slackStatus.data?.configured ? (
                            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                              {slackStatus.data.team ?? "connected"}
                            </span>
                          ) : (
                            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                              not configured
                            </span>
                          )}
                          {slackStatus.data?.configured &&
                            !slackStatus.data.socket && (
                              <span
                                className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300"
                                title="Add the app-level token (xapp-…) to enable reply-in-thread follow-ups"
                              >
                                thread replies off
                              </span>
                            )}
                        </div>
                      </div>
                      <div className="space-y-5">
                        {renderKeyList(SLACK_PROVIDERS)}
                      </div>
                      <p className="mt-4 border-t border-border/40 pt-3 text-[11px] leading-relaxed text-muted-foreground">
                        Reply in a notification&apos;s thread to send the
                        follow-up. Channels are picked by name — each project
                        can choose (or create) its own in sandbox settings.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}

              {activeTab === "integrations" && (
                <>
                  <GitHubAccountsSection />
                  <GitLabServersSection />
                  <ClickUpAccountsSection />
                  {/* Outbound integrations above; this is the one inbound one —
                      how another system reaches Nexus rather than the reverse. */}
                  <ApiTokensSection />
                </>
              )}

              {activeTab === "terminal" && <TerminalShellSection />}

              {activeTab === "appearance" && <AppearanceSection />}

              {activeTab === "desktop" && <DesktopAppSection />}

              {activeTab === "backup" && (
                <>
                  {/* Create the machine first, then move configuration onto it. */}
                  <NexusHostsSection />
                  <BackupMigrationSection />
                </>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 flex-col">
          <AppHeader title="Settings" />
        </div>
      }
    >
      <SettingsPageContent />
    </Suspense>
  );
}
