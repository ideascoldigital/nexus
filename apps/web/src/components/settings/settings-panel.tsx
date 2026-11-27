"use client";

// Settings, laid out as an instrument panel: a grouped rail that shows at a
// glance what is wired (configured counters per section, inherited markers)
// and a single reading column per section. It lives in a modal over the bots
// view (spec 39) — Nexus has no other page — and remembers the last section.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  Bot,
  Columns3,
  Cloud,
  DatabaseBackup,
  Terminal as TerminalIcon,
  GitBranch,
  MessageSquare,
  Plug,
  ShieldCheck,
  Blocks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiTokensSection } from "@/components/settings/api-tokens";
import { BackupMigrationSection } from "@/components/settings/backup-migration";
import { AppearanceSection } from "@/components/settings/appearance";
import { DesktopAppSection } from "@/components/settings/desktop-app";
import { EmbeddingsSection } from "@/components/settings/embeddings";
import { DockerEndpointsSection } from "@/components/settings/docker-endpoints";
import { NexusHostsSection } from "@/components/settings/nexus-hosts";
import { SandboxNamingSection } from "@/components/settings/sandbox-naming";
import { TerminalShellSection } from "@/components/settings/terminal-shell";
import { ConnectApps } from "@/components/connectors/connect-apps";
import { ChannelsAndAccounts } from "@/components/settings/channels-accounts";
import { ProviderCatalog } from "@/components/settings/provider-catalog";
import { VaultSection } from "@/components/vault/vault-section";

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
  "vault",
  "connectors",
  "machines",
  "api",
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_STORAGE_KEY = "nexux:settings:tab";

/**
 * Three panels over the bots view (spec 39): every key and login in the
 * Vault, everything Nexus talks to in Connect apps, and what this machine
 * itself needs in Settings.
 */
export type SettingsPanelKind = "vault" | "apps" | "settings";
const PANEL_SECTIONS: Record<SettingsPanelKind, readonly SettingsTab[]> = {
  vault: ["vault", "ai", "cloud", "git"],
  apps: ["connectors", "communications", "integrations"],
  settings: ["machines", "api", "terminal", "appearance", "desktop", "backup"],
};
const PANEL_COPY: Record<SettingsPanelKind, { title: string; subtitle: string }> = {
  vault: { title: "Vault", subtitle: "Every key and login, encrypted on this machine" },
  apps: { title: "Connect apps", subtitle: "What Nexus and your bots talk to" },
  settings: { title: "Settings", subtitle: "This machine and the app" },
};

/** Which panel shows a section — where an old ?tab= link should land. */
export function panelOf(tab: string | null): SettingsPanelKind {
  for (const [panel, tabs] of Object.entries(PANEL_SECTIONS) as [SettingsPanelKind, readonly SettingsTab[]][]) {
    if ((tabs as readonly string[]).includes(tab ?? "")) return panel;
  }
  return "settings";
}
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
          "Compute credentials for sandboxes (Civo, AWS) and the tailnet key that reaches your hosts.",
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
        label: "Channels",
        icon: MessageSquare,
        description:
          "Where Nexus notifies you and takes replies — Telegram (with remote control) and Slack (reply in a thread to follow up).",
        keys: COMMUNICATION_PROVIDERS,
      },
      {
        id: "integrations",
        label: "Accounts",
        icon: Plug,
        description:
          "Accounts Nexus reads issues and repositories from: GitHub, GitLab, ClickUp.",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        id: "machines",
        label: "Machines",
        icon: Cloud,
        description:
          "Other machines' Docker for bots and local sandboxes, how new machines get their names, and the local model behind search.",
      },
      {
        id: "api",
        label: "API tokens",
        icon: Plug,
        description: "Tokens other systems use to reach Nexus over its MCP control surface.",
      },
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
        id: "vault",
        label: "Logins & secrets",
        icon: ShieldCheck,
        description:
          "Logins, API keys, cards and contact details bots use without seeing them. Encrypted on this machine; the key lives in your Keychain.",
      },
      {
        id: "connectors",
        label: "Apps for bots",
        icon: Blocks,
        description:
          "Apps your bots use as tools — Gmail, Slack, Notion, GitHub, databases and more. Connect once; tokens stay encrypted here.",
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


export function isSettingsSection(value: string | null): value is SettingsTab {
  return isSettingsTab(value);
}

export function SettingsPanel({
  panel = "settings",
  initialTab,
}: {
  panel?: SettingsPanelKind;
  initialTab?: string | null;
}) {
  const sections = PANEL_SECTIONS[panel];
  const inPanel = (v: string | null): v is SettingsTab => isSettingsTab(v) && sections.includes(v);
  const storageKey = `${TAB_STORAGE_KEY}:${panel}`;
  const navGroups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => sections.includes(i.id)) })).filter(
    (g) => g.items.length > 0,
  );
  const navItems = navGroups.flatMap((g) => g.items);
  // The section asked for (a deep link), else the last one opened here.
  const readTab = (): SettingsTab => {
    if (inPanel(initialTab ?? null)) return initialTab as SettingsTab;
    try {
      const stored = localStorage.getItem(storageKey);
      if (inPanel(stored)) return stored;
    } catch {
      // storage unavailable: the default section
    }
    return sections[0]!;
  };
  const [activeTab, setActiveTab] = useState<SettingsTab>(readTab);
  const setTab = (value: string) => {
    if (!inPanel(value)) return;
    setActiveTab(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // not remembered, still switched
    }
  };
  // Counts on the rail ("2/3 configured") read the saved keys.
  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const getSettingByKey = (key: string) => {
    return settings.find((s) => s.key === key);
  };

  const configuredCount = (providers: Provider[]) =>
    providers.filter((p) => getSettingByKey(p.key)).length;

  const active = navItems.find((i) => i.id === activeTab) ?? navItems[0]!;
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
    // Fills its box (the modal): the rail and the section scroll on their own.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-6">
          {/* ---- Rail (md+) -------------------------------------------- */}
          <nav
            aria-label="Settings sections"
            className="hidden w-56 shrink-0 overflow-y-auto pb-4 md:block"
          >
            <h1 className="px-2.5 text-lg font-semibold tracking-tight">
              {PANEL_COPY[panel].title}
            </h1>
            <p className="px-2.5 pb-2 text-xs text-muted-foreground">
              {PANEL_COPY[panel].subtitle}
            </p>
            {navGroups.map((group) => (
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
          <div className="min-w-0 flex-1 overflow-y-auto pr-1 pb-6">
            {/* Small screens get the sections as a scrollable pill row. */}
            <div className="mb-4 flex gap-1 overflow-x-auto pb-1 md:hidden">
              {navItems.map((item) => navButton(item, true))}
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

              {activeTab === "ai" && <ProviderCatalog kind="ai" />}

              {activeTab === "cloud" && <ProviderCatalog kind="cloud" />}

              {activeTab === "machines" && (
                <>
                  {/* Compute you already own: another machine's Docker for
                      bots and local sandboxes (spec 26). */}
                  <DockerEndpointsSection />
                  {/* Names the machines Nexus provisions, local docker ones too. */}
                  <SandboxNamingSection />
                  {/* The local model behind search and ⌘K — its status, and a
                      way to try it rather than trust it. */}
                  <EmbeddingsSection />
                </>
              )}

              {activeTab === "api" && <ApiTokensSection />}

              {activeTab === "git" && <ProviderCatalog kind="git" />}

              {activeTab === "communications" && <ChannelsAndAccounts kind="communications" />}

              {activeTab === "integrations" && <ChannelsAndAccounts kind="accounts" />}

              {activeTab === "terminal" && <TerminalShellSection />}

              {activeTab === "appearance" && <AppearanceSection />}

              {activeTab === "desktop" && <DesktopAppSection />}

              {activeTab === "vault" && <VaultSection />}

              {activeTab === "connectors" && <ConnectApps />}

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
    </div>
  );
}
