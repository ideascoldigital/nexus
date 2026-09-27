"use client";

import { useState, type ReactNode } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  Bot,
  Cloud,
  GitBranch,
  KeyRound,
  Loader2,
  Network,
  Server,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { NO_AUTOFILL } from "@/lib/utils";
import { useCredentialCheck } from "@/components/settings/credential-check";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createCredential,
  deleteCredential,
  getCredentials,
  type CloudCredentialSummary,
  type CredentialProvider,
  type GitProvider,
  type LlmProvider,
  type NewCredentialInput,
  type SandboxProvider,
} from "@/services/sandbox";
import { tokenCreateUrl } from "@/lib/git-credentials";

/** Everything a saved credential can be for. */
export const CREDENTIAL_PROVIDERS: {
  value: CredentialProvider;
  label: string;
}[] = [
  { value: "civo", label: "Civo" },
  { value: "aws", label: "AWS EC2" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "claude", label: "Claude Code" },
  // Nexus hosts (spec 19) and sandboxes. Stored as
  // { authKey?, loginServer? } — `resolveTailscaleKey` also accepts the
  // legacy `token` field rows saved before the control-server option existed.
  { value: "tailscale", label: "Tailscale" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "google", label: "Google (Gemini)" },
  { value: "xai-llm", label: "xAI (Grok)" },
  { value: "anthropic-key", label: "Anthropic API key" },
  { value: "zai", label: "Z.ai (GLM)" },
];

/** LLM provider API keys — consumed by the OpenCode brain on sandboxes. */
export const LLM_UI_PROVIDERS = CREDENTIAL_PROVIDERS.filter((p) =>
  [
    "openai",
    "openrouter",
    "google",
    "xai-llm",
    "anthropic-key",
    "zai",
  ].includes(p.value),
);

const LLM_PROVIDER_VALUES = new Set(LLM_UI_PROVIDERS.map((p) => p.value));

/** Compute providers only — what a sandbox instance runs on. */
export const SANDBOX_PROVIDERS = CREDENTIAL_PROVIDERS.filter(
  (p): p is { value: SandboxProvider; label: string } =>
    p.value === "civo" || p.value === "aws",
);

/** Git hosting providers — tokens for cloning and PRs. */
export const GIT_CREDENTIAL_PROVIDERS = CREDENTIAL_PROVIDERS.filter(
  (p) => p.value === "github" || p.value === "gitlab" || p.value === "bitbucket",
);

const GIT_PROVIDER_VALUES = new Set(
  GIT_CREDENTIAL_PROVIDERS.map((p) => p.value),
);

/**
 * Container registry each git host runs, which the same token logs in to. Shown
 * as the placeholder so the override field says what it is overriding;
 * Bitbucket has no registry of its own, so there is nothing to prefill.
 */
export const DEFAULT_REGISTRY_HOST: Record<string, string> = {
  github: "ghcr.io",
  gitlab: "registry.gitlab.com",
};

/** Claude Code OAuth tokens — one per account/seat, selectable per project. */
export const CLAUDE_CREDENTIAL_PROVIDERS = CREDENTIAL_PROVIDERS.filter(
  (p) => p.value === "claude",
);

/** Tailscale auth keys — used to join a Nexus host to the tailnet (spec 19). */
export const TAILSCALE_CREDENTIAL_PROVIDERS = CREDENTIAL_PROVIDERS.filter(
  (p) => p.value === "tailscale",
);

export function sandboxProviderLabel(provider: CredentialProvider): string {
  return (
    CREDENTIAL_PROVIDERS.find((p) => p.value === provider)?.label ?? provider
  );
}

/**
 * Every place that creates or deletes a credential must refresh BOTH consumers:
 * the Settings lists ("cloud-credentials") and every project's sandbox drawer
 * ("project-setup" prefix matches all projects). Use this everywhere so the
 * Settings page and the sandboxes UI never disagree.
 */
export function invalidateCredentialQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["cloud-credentials"] });
  qc.invalidateQueries({ queryKey: ["project-setup"] });
}

const TOKEN_PLACEHOLDER: Record<string, string> = {
  civo: "Civo API token",
  github: "GitHub PAT (ghp_… / github_pat_…)",
  gitlab: "GitLab PAT (glpat-…)",
  bitbucket: "Bitbucket access token",
  claude: "Claude Code OAuth token (sk-ant-oat01-…)",
  tailscale:
    "Auth key (tskey-auth-… / Headscale pre-auth key) — optional with a control server below",
  openai: "OpenAI API key (sk-…)",
  openrouter: "OpenRouter API key (sk-or-…)",
  google: "Google AI Studio API key (AIza…)",
  "xai-llm": "xAI API key (xai-…)",
  "anthropic-key": "Anthropic API key (sk-ant-api…)",
  zai: "Z.ai API key (GLM models)",
};

const NAME_EXAMPLE: Record<string, string> = {
  civo: "Civo work",
  aws: "AWS personal",
  github: "GitHub work",
  gitlab: "GitLab personal",
  bitbucket: "Bitbucket team",
  claude: "Claude personal",
  tailscale: "Tailnet key",
  openai: "OpenAI personal",
  openrouter: "OpenRouter personal",
  google: "Gemini personal",
  "xai-llm": "xAI personal",
  "anthropic-key": "Anthropic personal",
  zai: "Z.ai personal",
};

// Providers whose token comes from a local CLI command instead of a web page.
const TOKEN_CREATE_COMMAND: Record<string, string> = {
  claude: "claude setup-token",
};

// Deep links to each provider's token-creation page. GitHub and GitLab
// support pre-filling name/scopes via the URL, so the token comes out with
// the permissions sandboxes need (clone, push, PRs) without hunting for them.
const TOKEN_CREATE_URL: Record<string, string> = {
  // `read:packages` is what lets a Nexus host pull a private image from ghcr.io.
  // Worth pre-selecting even though most tokens are only used for cloning:
  // without it GHCR still *issues* a token, so `docker login` succeeds and the
  // pull is denied — a failure that only surfaces minutes into a bootstrap, on
  // an instance that is already billing. `project` covers reading and updating
  // GitHub Projects boards.
  github:
    "https://github.com/settings/tokens/new?scopes=repo,workflow,read:packages,project&description=Nexus%20sandboxes",
  gitlab:
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=Nexus%20sandboxes&scopes=api,read_repository,write_repository,read_registry",
  bitbucket: "https://bitbucket.org/account/settings/app-passwords/new",
  civo: "https://dashboard.civo.com/security",
  aws: "https://console.aws.amazon.com/iam/home#/security_credentials",
  // The three toggles the bootstrap depends on: reusable (a one-shot key
  // breaks the second host), pre-authorized (otherwise the machine waits for
  // manual approval and reads as "provisioned but unreachable"), and ephemeral
  // (a destroyed host should not linger in the tailnet).
  tailscale: "https://login.tailscale.com/admin/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
  google: "https://aistudio.google.com/apikey",
  "xai-llm": "https://console.x.ai",
  "anthropic-key": "https://console.anthropic.com/settings/keys",
  zai: "https://z.ai/manage-apikey/apikey-list",
};

// Name + secrets for one provider; secrets go straight to /api/credentials
// and are never echoed back.
export function NewCredentialForm({
  provider,
  onSaved,
}: {
  provider: CredentialProvider;
  onSaved: (created: CloudCredentialSummary) => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [registryHost, setRegistryHost] = useState("");
  const [loginServer, setLoginServer] = useState("");
  const isGit = GIT_PROVIDER_VALUES.has(provider);
  const isTailscale = provider === "tailscale";
  // Sending a self-hosted user to github.com/gitlab.com mints a token that can
  // never authenticate against their own install, so the link follows whatever
  // instance the registry override implies.
  const tokenLink = tokenCreateUrl(
    TOKEN_CREATE_URL[provider] ?? "",
    isGit ? registryHost : null,
    DEFAULT_REGISTRY_HOST[provider],
  );

  const mutation = useMutation({
    mutationFn: () => {
      const input: NewCredentialInput =
        provider === "aws"
          ? {
              provider: "aws",
              name: name.trim(),
              accessKeyId: accessKeyId.trim(),
              secretAccessKey: secretAccessKey.trim(),
            }
          : LLM_PROVIDER_VALUES.has(provider)
            ? {
                provider: provider as LlmProvider,
                name: name.trim(),
                apiKey: token.trim(),
              }
            : isTailscale
              ? {
                  provider: "tailscale",
                  name: name.trim(),
                  // Either half may be omitted: a key alone is Tailscale's own
                  // control plane, a server alone is a browser login on a
                  // self-hosted one.
                  ...(token.trim() ? { authKey: token.trim() } : {}),
                  ...(loginServer.trim()
                    ? { loginServer: loginServer.trim() }
                    : {}),
                }
              : {
                  provider: provider as "civo" | GitProvider | "claude",
                  name: name.trim(),
                  token: token.trim(),
                  ...(isGit && registryHost.trim()
                    ? { registryHost: registryHost.trim() }
                    : {}),
                };
      return createCredential(input);
    },
    onSuccess: (created) => {
      setName("");
      setToken("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setRegistryHost("");
      setLoginServer("");
      onSaved(created);
    },
  });

  const filled =
    name.trim() &&
    (provider === "aws"
      ? accessKeyId.trim() && secretAccessKey.trim()
      : // Tailscale needs one of the two, not both: no key is the normal case
        // on a control plane you do not administer.
        isTailscale
        ? token.trim() || loginServer.trim()
        : token.trim());

  return (
    <form
      className="space-y-1.5"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled) mutation.mutate();
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`Name (e.g. "${NAME_EXAMPLE[provider] ?? provider}")`}
        className="text-xs"
        autoComplete="off"
        {...NO_AUTOFILL}
      />
      {provider === "aws" ? (
        <>
          <Input
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="AWS access key ID"
            className="font-mono text-xs"
            autoComplete="off"
            {...NO_AUTOFILL}
          />
          <Input
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="AWS secret access key"
            className="font-mono text-xs"
            autoComplete="new-password"
            {...NO_AUTOFILL}
          />
        </>
      ) : (
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={TOKEN_PLACEHOLDER[provider] ?? "API token"}
          className="font-mono text-xs"
          autoComplete="new-password"
          {...NO_AUTOFILL}
        />
      )}
      {isTailscale && (
        <>
          <Input
            value={loginServer}
            onChange={(e) => setLoginServer(e.target.value)}
            placeholder="Control server URL (optional — e.g. https://vpn.example.com)"
            className="font-mono text-xs"
            autoComplete="off"
            {...NO_AUTOFILL}
          />
          <p className="text-[10px] text-muted-foreground">
            For a self-hosted coordination server (Headscale) instead of
            Tailscale&apos;s own. Sandboxes join it with{" "}
            <code>--login-server</code>. Such a server usually has no admin
            console to mint an auth key from — leave the key blank and the
            sandbox registers itself instead, printing a URL in its bootstrap
            log for you to approve in the browser you are already signed in to.
            A Nexus host still needs a real key: it bootstraps unattended and
            has nobody to click that link.
          </p>
        </>
      )}
      {isGit && (
        <>
          <Input
            value={registryHost}
            onChange={(e) => setRegistryHost(e.target.value)}
            placeholder={`Registry host (optional${
              DEFAULT_REGISTRY_HOST[provider]
                ? ` — defaults to ${DEFAULT_REGISTRY_HOST[provider]}`
                : ""
            })`}
            className="font-mono text-xs"
            autoComplete="off"
            {...NO_AUTOFILL}
          />
          <p className="text-[10px] text-muted-foreground">
            For a self-hosted install whose container registry is not the
            provider&apos;s public one. A Nexus host pulling an image from that
            registry logs in with this token. It also names the instance a
            sandbox authenticates against when a project&apos;s repository URLs
            do not — those win when they do.
          </p>
        </>
      )}
      {TOKEN_CREATE_COMMAND[provider] && (
        <p className="text-[10px] text-muted-foreground">
          Run <code>{TOKEN_CREATE_COMMAND[provider]}</code> on your machine and
          paste the result.
        </p>
      )}
      {/* The deep link points at login.tailscale.com, which is the wrong place
          to look once a self-hosted control server is named. */}
      {TOKEN_CREATE_URL[provider] && !(isTailscale && loginServer.trim()) && (
        <a
          href={tokenLink.url}
          target="_blank"
          rel="noreferrer"
          className="block text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {/* Naming the host, not the provider, once the link has been pointed
              somewhere else: the registry override only *implies* the web host,
              so the guess has to be readable before it is clicked. */}
          Create a token on{" "}
          {tokenLink.overridden ? tokenLink.host : sandboxProviderLabel(provider)}
          {provider === "github" || provider === "gitlab"
            ? " with the right permissions pre-selected"
            : ""}{" "}
          ↗
        </a>
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={mutation.isPending || !filled}
      >
        {mutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          "Save credential"
        )}
      </Button>
      {mutation.isError && (
        <p className="text-xs text-destructive">
          {(mutation.error as Error).message}
        </p>
      )}
    </form>
  );
}

// Shared Settings-page card: saved credentials for a subset of providers,
// plus creation. The same credentials are offered in each project's sandbox
// settings drawer.
/**
 * One saved credential: its name and non-secret details, the Test controls
 * where the provider has a check (spec 28), and delete. The test result
 * expands below the line.
 */
function CredentialRow({
  cred,
  onDelete,
  deleting,
}: {
  cred: CloudCredentialSummary;
  onDelete: () => void;
  deleting: boolean;
}) {
  const check = useCredentialCheck(cred);
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{cred.name}</span>
        <Badge variant="secondary" className="text-[10px]">
          {sandboxProviderLabel(cred.provider)}
        </Badge>
        {cred.hint && (
          <code
            className="text-[10px] text-muted-foreground"
            title="Token (masked)"
          >
            {cred.hint}
          </code>
        )}
        {/* Labelled, because an unadorned host sitting next to the
            masked token reads as more of the same secret. For a
            self-hosted install this is the one field that says which
            instance the credential belongs to. */}
        {cred.registryHost && (
          <span
            className="flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="Self-hosted instance saved on this credential — used for its container registry, and as the fallback git host when a project's repos do not say"
          >
            <Server className="h-3 w-3" />
            <code>{cred.registryHost}</code>
          </span>
        )}
        {/* Same reasoning as above: without it, two Tailscale
            credentials differing only in control plane look identical. */}
        {cred.loginServer && (
          <span
            className="flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="Self-hosted coordination server this credential joins (--login-server)"
          >
            <Network className="h-3 w-3" />
            <code>{cred.loginServer}</code>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {check.controls}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Delete credential"
            onClick={onDelete}
            disabled={deleting}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      {check.details}
    </div>
  );
}

function CredentialsCard({
  title,
  description,
  icon,
  providers,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  providers: { value: CredentialProvider; label: string }[];
}) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<CredentialProvider>(
    providers[0].value,
  );

  const credentials = useQuery({
    queryKey: ["cloud-credentials"],
    queryFn: getCredentials,
  });

  const invalidate = () => invalidateCredentialQueries(qc);

  const deleteMutation = useMutation({
    mutationFn: (credentialId: string) => deleteCredential(credentialId),
    onSuccess: invalidate,
  });

  const wanted = new Set(providers.map((p) => p.value));
  const list = (credentials.data ?? []).filter((c) => wanted.has(c.provider));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {credentials.isLoading ? (
          <div className="text-sm text-muted-foreground">
            Loading credentials...
          </div>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No credentials saved yet.
          </p>
        ) : (
          <div className="space-y-2">
            {list.map((cred) => (
              <CredentialRow
                key={cred.id}
                cred={cred}
                onDelete={() => deleteMutation.mutate(cred.id)}
                deleting={deleteMutation.isPending}
              />
            ))}
          </div>
        )}
        {deleteMutation.isError && (
          <p className="text-xs text-destructive">
            {(deleteMutation.error as Error).message}
          </p>
        )}

        <div className="space-y-2 rounded-md border border-border/50 p-3">
          <Label className="text-xs font-medium">Add credential</Label>
          {providers.length > 1 && (
            <Select
              value={provider}
              onValueChange={(v) => v && setProvider(v as CredentialProvider)}
            >
              <SelectTrigger className="w-40">
                <SelectValue>
                  {(value) => sandboxProviderLabel(value as CredentialProvider)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <NewCredentialForm provider={provider} onSaved={invalidate} />
        </div>
      </CardContent>
    </Card>
  );
}

export function CloudCredentialsSection() {
  return (
    <CredentialsCard
      title="Cloud Credentials"
      description="Provider accounts used to provision sandboxes (Civo, AWS EC2). Saved once here, selectable per project in the sandbox settings."
      icon={<Cloud className="h-5 w-5" />}
      providers={SANDBOX_PROVIDERS}
    />
  );
}

export function GitCredentialsSection() {
  return (
    <CredentialsCard
      title="Git Credentials"
      description="Tokens for git hosting providers (GitHub, GitLab, Bitbucket) — used on sandboxes to clone private repos and open PRs. Selectable per project in the sandbox settings."
      icon={<GitBranch className="h-5 w-5" />}
      providers={GIT_CREDENTIAL_PROVIDERS}
    />
  );
}

export function ClaudeCredentialsSection() {
  return (
    <CredentialsCard
      title="Claude Code Tokens"
      description="OAuth tokens that authenticate Claude Code on sandboxes (`claude setup-token`). Save one per account/seat; each project picks one in its sandbox settings. A CLAUDE_CODE_OAUTH_TOKEN project env var overrides it."
      icon={<Bot className="h-5 w-5" />}
      providers={CLAUDE_CREDENTIAL_PROVIDERS}
    />
  );
}

export function TailscaleCredentialsSection() {
  return (
    <CredentialsCard
      title="Tailscale Auth Keys"
      description="How a sandbox or Nexus host joins your tailnet, so the machine is reachable without exposing it to the internet. On Tailscale's own control plane, generate an ephemeral, pre-authorized, reusable key at login.tailscale.com/admin/settings/keys — a host comes up unreachable without those three. On a self-hosted coordination server (Headscale), name its URL instead; a sandbox can then register itself in the browser and needs no key at all."
      icon={<Network className="h-5 w-5" />}
      providers={TAILSCALE_CREDENTIAL_PROVIDERS}
    />
  );
}

export function LlmCredentialsSection() {
  return (
    <CredentialsCard
      title="LLM API Keys"
      description="Provider API keys the OpenCode brain uses on sandboxes (OpenAI, OpenRouter, Google, xAI, Anthropic, Z.ai/GLM). Save as many as you need; each project selects which ones to inject in its sandbox settings. Project env vars with the same name win."
      icon={<KeyRound className="h-5 w-5" />}
      providers={LLM_UI_PROVIDERS}
    />
  );
}
