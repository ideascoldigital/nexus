"use client";

// Vault → AI providers, Cloud and Git (spec 39), in the same look as Connect
// apps: a list of providers with Connected / Connect, and one provider's page
// with how to get its key, the keys saved for it (each with its Test), and a
// form to add another. The keys themselves never leave this machine.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";

import { AppIcon } from "@/components/connectors/connect-apps";
import { KeysForm, type App } from "@/components/settings/channels-accounts";
import { ProviderCredentials } from "@/components/settings/cloud-credentials";
import { HostModelSection } from "@/components/settings/host-model";
import type { CredentialProvider } from "@/services/sandbox";
import { getCredentials } from "@/services/sandbox";

type Entry = {
  id: string;
  name: string;
  tagline: string;
  steps?: string[];
  /** Saved credentials of this provider (the Credentials table). */
  credential?: CredentialProvider;
  /** Or keys kept as settings (local URLs, older single keys). */
  settings?: App;
  /** Or a page of its own. */
  page?: "host-model";
};

const legacy = (key: string, providerName: string, label: string, placeholder: string): App => ({
  id: key,
  name: label,
  tagline: "",
  providerName,
  fields: [{ key, label, help: "One key for this whole workspace", placeholder, secret: !key.endsWith("_url") }],
});

const CATALOG: Record<"ai" | "cloud" | "git", Entry[]> = {
  ai: [
    {
      id: "claude",
      name: "Claude Code",
      tagline: "Your Claude subscription — bots, sandboxes and the project chat run on it",
      credential: "claude",
      steps: ["In a terminal on this Mac, run `claude setup-token` and sign in.", "Copy the token it prints (sk-ant-oat…) and add it below."],
    },
    {
      id: "host-model",
      name: "Assistant model",
      tagline: "Which saved key drives the ⌘I assistant on this machine",
      page: "host-model",
    },
    {
      id: "anthropic-key",
      name: "Anthropic API",
      tagline: "An API key, billed per use (console.anthropic.com)",
      credential: "anthropic-key",
      settings: legacy("anthropic_api_key", "Anthropic (Claude)", "Workspace key (older)", "sk-ant-…"),
    },
    {
      id: "openai",
      name: "OpenAI",
      tagline: "API key for GPT models (platform.openai.com)",
      credential: "openai",
      settings: legacy("openai_api_key", "OpenAI", "Workspace key (older)", "sk-…"),
    },
    { id: "openrouter", name: "OpenRouter", tagline: "One key for many models (openrouter.ai)", credential: "openrouter" },
    { id: "google", name: "Google Gemini", tagline: "API key from Google AI Studio", credential: "google" },
    {
      id: "xai-llm",
      name: "xAI (Grok)",
      tagline: "API key from console.x.ai",
      credential: "xai-llm",
      settings: legacy("xai_api_key", "xAI (Grok)", "Workspace key (older)", "xai-…"),
    },
    {
      id: "zai",
      name: "Z.ai (GLM)",
      tagline: "API key for GLM models",
      credential: "zai",
      settings: legacy("zai_api_key", "Z.ai (GLM)", "Workspace key (older)", "…"),
    },
    { id: "codex", name: "Codex", tagline: "Key for the Codex CLI", settings: legacy("codex_api_key", "Codex", "API key", "sk-…") },
    {
      id: "ollama",
      name: "Ollama",
      tagline: "Local models, and the embeddings behind search",
      settings: legacy("ollama_url", "Ollama URL", "Server URL", "http://localhost:11434"),
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      tagline: "Local models served by LM Studio",
      settings: legacy("lmstudio_url", "LM Studio URL", "Server URL", "http://localhost:1234"),
    },
  ],
  cloud: [
    {
      id: "civo",
      name: "Civo",
      tagline: "Cloud machines for sandboxes",
      credential: "civo",
      steps: ["In the Civo dashboard: Settings → Profile → Security.", "Copy your API key and add it below."],
    },
    {
      id: "aws",
      name: "AWS",
      tagline: "EC2 machines for sandboxes",
      credential: "aws",
      steps: [
        "In the AWS console: IAM → Users → an user with EC2 permissions → Security credentials.",
        "Create an access key and add its ID and secret below.",
      ],
    },
    {
      id: "tailscale",
      name: "Tailscale",
      tagline: "Reach sandboxes and Nexus hosts privately, without exposing them",
      credential: "tailscale",
      steps: [
        "On Tailscale: login.tailscale.com/admin/settings/keys — generate a reusable, ephemeral, pre-authorized key.",
        "Or, on a self-hosted Headscale, give its URL instead.",
      ],
    },
  ],
  git: [
    {
      id: "github",
      name: "GitHub",
      tagline: "Clone private repositories and open pull requests from sandboxes",
      credential: "github",
      steps: ["github.com → Settings → Developer settings → Personal access tokens.", "Create one with the repo and workflow scopes and add it below."],
    },
    {
      id: "gitlab",
      name: "GitLab",
      tagline: "gitlab.com or your own server",
      credential: "gitlab",
      steps: ["GitLab → Preferences → Access tokens: create one with api and read_repository.", "For a self-hosted server, set its host when you add it."],
    },
    {
      id: "bitbucket",
      name: "Bitbucket",
      tagline: "Bitbucket Cloud repositories",
      credential: "bitbucket",
      steps: ["bitbucket.org → Personal settings → App passwords: create one with repository read/write."],
    },
  ],
};

export function ProviderCatalog({ kind }: { kind: "ai" | "cloud" | "git" }) {
  const entries = CATALOG[kind];
  const [openId, setOpenId] = useState<string | null>(null);
  const credentials = useQuery({ queryKey: ["cloud-credentials"], queryFn: getCredentials });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      return res.ok ? ((await res.json()) as { key: string }[]) : [];
    },
  });
  const status = (e: Entry): string | null => {
    const n = e.credential ? (credentials.data ?? []).filter((c) => c.provider === e.credential).length : 0;
    const keys = (e.settings?.fields ?? []).filter((f) => settings.data?.some((s) => s.key === f.key)).length;
    if (n) return n === 1 ? "1 key" : `${n} keys`;
    if (keys) return "Connected";
    return null;
  };
  const open = entries.find((e) => e.id === openId);

  if (open) {
    const s = status(open);
    return (
      <div className="space-y-5">
        <button type="button" onClick={() => setOpenId(null)} className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />
          All providers
        </button>
        <div className="flex items-center gap-3">
          <AppIcon id={open.id} size={48} />
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-semibold">{open.name}</h3>
            <p className="text-[12.5px] text-muted-foreground">{open.tagline}</p>
          </div>
          {s && <span className="text-[12.5px] font-medium text-emerald-500">{s}</span>}
        </div>
        {open.steps && (
          <ol className="list-decimal space-y-1.5 rounded-2xl border border-border bg-card/60 py-3.5 pr-4 pl-9 text-[12.5px] text-muted-foreground">
            {open.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
        {open.page === "host-model" && <HostModelSection />}
        {open.credential && <ProviderCredentials provider={open.credential} />}
        {open.settings && (
          <div className="space-y-2">
            {open.credential && <h4 className="px-1 text-[12px] text-muted-foreground">Workspace key (older setup)</h4>}
            <KeysForm app={open.settings} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-x-6 sm:grid-cols-2">
      {entries.map((e) => {
        const s = status(e);
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => setOpenId(e.id)}
            className="group flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-accent/50"
          >
            <AppIcon id={e.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{e.name}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{e.tagline}</span>
            </span>
            {e.page ? (
              <span className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-medium group-hover:bg-accent/80">Choose</span>
            ) : s ? (
              <span className="shrink-0 px-3 text-[12.5px] font-medium text-emerald-500">{s}</span>
            ) : (
              <span className="shrink-0 rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-medium group-hover:bg-accent/80">Connect</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
