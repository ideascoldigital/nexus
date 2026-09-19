"use client";

import { copyText } from "@/lib/clipboard";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  GitPullRequest,
  Globe,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Rocket,
  Network,
  Server,
  Trash2,
  Variable,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AutoScrollLog } from "@/components/ui/auto-scroll-log";
import { MarkdownReport } from "@/components/ui/markdown-report";
import { TaskScreenshots } from "@/components/projects/task-screenshots";
import { useToast } from "@/hooks/use-toast";
import { NO_AUTOFILL, sandboxRepoSlug } from "@/lib/utils";
import { useResizablePanel } from "@/lib/use-resizable-panel";
import {
  deleteTask,
  getBootstrapLog,
  getSandboxHealth,
  getSandboxLog,
  getTask,
  getTasks,
  runTask,
  SANDBOX_LOG_SOURCES,
  type SandboxLogSource,
  type TaskSummary,
} from "@/services/tasks";
import {
  isSoundEnabled,
  playTaskSound,
  setSoundEnabled,
} from "@/lib/notification-sound";
import {
  addEnvVar,
  ApiError,
  createSlackChannelOption,
  deleteEnvVar,
  destroySandbox,
  fetchEnvPresets,
  getProjectSetup,
  getSlackChannels,
  getSandbox,
  getSandboxes,
  getSandboxPassword,
  getTelegramBot,
  getVsCodeLink,
  importEnvVars,
  importEnvVarsFromConfig,
  importEnvVarsFromStack,
  launchSandbox,
  revealEnvVar,
  startPreview,
  stopPreview,
  deleteCredential,
  refreshTailscaleLogin,
  retrySandboxSetup,
  revealSandboxFiles,
  saveProjectSetup,
  updateEnvVar,
  powerSandbox,
  updateSandbox,
  parseStackServices,
  type CloudCredentialSummary,
  type CredentialProvider,
  type EnvImportResult,
  type LaunchTarget,
  type ProjectSetupData,
  type RepoSetupInput,
  type RepoWithSetup,
  type SandboxConfigInput,
  type SandboxProvider,
  type SandboxReadiness,
  type SandboxSummary,
  type StackEnvSource,
  type StackServiceSummary,
} from "@/services/sandbox";
import { parseDotenvWithDiagnostics } from "@/lib/stack/dotenv";
import {
  applyWizardParams,
  resolveStep,
  restoreWizardState,
  SANDBOX_OPEN_PARAM,
  stepsFor,
  type SandboxDestination,
  type WizardStepKey,
} from "@/lib/sandbox-setup-wizard";
import {
  invalidateCredentialQueries,
  NewCredentialForm,
  SANDBOX_PROVIDERS as PROVIDERS,
  sandboxProviderLabel as providerLabel,
} from "@/components/settings/cloud-credentials";
import { ScheduledTasksCard } from "@/components/projects/scheduled-tasks-card";
import { DevConsoleSheet } from "@/components/projects/dev-console";
import { SandboxPrefixField } from "@/components/settings/sandbox-prefix-field";
import { SandboxProcessPanel } from "@/components/projects/sandbox-processes";
import { SandboxBrowserPanel } from "@/components/projects/sandbox-browser";
import {
  detectAllRepositories,
  getStackInheritance,
} from "@/services/stack";

// Same disk_image identifiers work on both providers: Civo uses them
// directly; the AWS terraform template maps them to official AMIs.
const DISK_IMAGES = ["ubuntu-jammy", "ubuntu-focal", "debian-11"];

/**
 * Longest name a user may type: 63, sethostname's limit. A typed name is the
 * whole hostname — no prefix is added — so the whole budget is theirs.
 *
 * Restated here rather than imported: `@nexux/sandbox` reaches for
 * child_process at import time, and pulling it into a client component drags
 * that into the browser bundle.
 */
const MAX_CUSTOM_SANDBOX_NAME = 63;

/**
 * What the server will most likely call this sandbox. A preview only — the
 * server normalizes again and owns the answer, including whether the name is
 * still free, which the browser cannot know.
 */
function previewSandboxName(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return slug ? slug.slice(0, MAX_CUSTOM_SANDBOX_NAME) : null;
}

// --model for agent runs. Aliases resolve to the newest build of each tier
// on the sandbox's Claude CLI; null lets the CLI pick its default.
const CLAUDE_MODELS: { value: string; label: string; hint: string }[] = [
  { value: "default", label: "Default (CLI setting)", hint: "whatever the sandbox CLI defaults to" },
  { value: "sonnet", label: "Sonnet", hint: "balanced speed/cost" },
  { value: "opus", label: "Opus", hint: "strongest, most expensive" },
  { value: "haiku", label: "Haiku", hint: "fastest, cheapest" },
];

// Curated `opencode -m provider/model` options. OpenCode accepts any
// models.dev id, so the picker also allows free text ("custom").
const OPENCODE_MODELS: { value: string; label: string; hint: string }[] = [
  { value: "default", label: "Default (CLI setting)", hint: "whatever the sandbox CLI defaults to" },
  { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet (Anthropic)", hint: "needs Anthropic API key" },
  { value: "openai/gpt-5.2", label: "GPT-5.2 (OpenAI)", hint: "needs OpenAI key" },
  { value: "openai/gpt-5.2-codex", label: "GPT-5.2 Codex (OpenAI)", hint: "coding-tuned" },
  { value: "google/gemini-3-pro", label: "Gemini 3 Pro (Google)", hint: "needs Gemini key" },
  { value: "xai/grok-4", label: "Grok 4 (xAI)", hint: "needs xAI key" },
  { value: "zai/glm-5.2", label: "GLM-5.2 (Z.ai)", hint: "needs Z.ai key" },
  { value: "openrouter/auto", label: "OpenRouter auto", hint: "routes via OpenRouter key" },
  { value: "custom", label: "Custom…", hint: "any provider/model id" },
];

const BRAINS: { value: "claude" | "opencode"; label: string; hint: string }[] = [
  { value: "claude", label: "Claude Code", hint: "Anthropic's CLI — OAuth token" },
  { value: "opencode", label: "OpenCode", hint: "open-source CLI — 75+ providers via API keys" },
];

type SandboxSizeOption = {
  value: string;
  label: string;
  /** USD, on-demand. Civo: civo.com/pricing. AWS: us-east-1 approximation
      (varies by region). Update if they move. */
  hourly: number;
  monthly: number;
};

const PROVIDER_OPTIONS: Record<
  SandboxProvider,
  {
    regions: string[];
    sizes: SandboxSizeOption[];
    defaults: { region: string; size: string };
  }
> = {
  civo: {
    regions: ["NYC1", "LON1", "FRA1", "PHX1"],
    // The g4 generation (civo.com/pricing, 2026-09): g4s standard, g4c CPU-,
    // g4m RAM-optimized, g4p performance. Sandboxes provisioned on the old
    // g3.* slugs keep working — the select falls back to the raw value.
    sizes: [
      {
        value: "g4s.xsmall",
        label: "g4s.xsmall — 1 CPU / 1 GB",
        hourly: 0.00744,
        monthly: 5.43,
      },
      {
        value: "g4s.small",
        label: "g4s.small — 1 CPU / 2 GB",
        hourly: 0.014881,
        monthly: 10.86,
      },
      {
        value: "g4s.medium",
        label: "g4s.medium — 2 CPU / 4 GB",
        hourly: 0.029762,
        monthly: 21.73,
      },
      {
        value: "g4s.large",
        label: "g4s.large — 4 CPU / 8 GB",
        hourly: 0.059524,
        monthly: 43.45,
      },
      {
        value: "g4s.xlarge",
        label: "g4s.xlarge — 6 CPU / 16 GB",
        hourly: 0.119048,
        monthly: 86.91,
      },
      {
        value: "g4s.2xlarge",
        label: "g4s.2xlarge — 8 CPU / 32 GB",
        hourly: 0.238095,
        monthly: 173.81,
      },
      {
        value: "g4c.small",
        label: "g4c.small — 8 CPU / 16 GB",
        hourly: 0.190476,
        monthly: 128.0,
      },
      {
        value: "g4c.medium",
        label: "g4c.medium — 16 CPU / 32 GB",
        hourly: 0.380952,
        monthly: 256.0,
      },
      {
        value: "g4c.large",
        label: "g4c.large — 32 CPU / 64 GB",
        hourly: 0.761905,
        monthly: 512.0,
      },
      {
        value: "g4c.xlarge",
        label: "g4c.xlarge — 64 CPU / 128 GB",
        hourly: 1.52381,
        monthly: 1024.0,
      },
      {
        value: "g4m.small",
        label: "g4m.small — 2 CPU / 16 GB",
        hourly: 0.107137,
        monthly: 78.21,
      },
      {
        value: "g4m.medium",
        label: "g4m.medium — 4 CPU / 32 GB",
        hourly: 0.214288,
        monthly: 156.43,
      },
      {
        value: "g4m.large",
        label: "g4m.large — 8 CPU / 64 GB",
        hourly: 0.428575,
        monthly: 312.86,
      },
      {
        value: "g4m.xlarge",
        label: "g4m.xlarge — 16 CPU / 128 GB",
        hourly: 0.857137,
        monthly: 625.71,
      },
      {
        value: "g4p.small",
        label: "g4p.small — 4 CPU / 16 GB",
        hourly: 0.119055,
        monthly: 86.91,
      },
      {
        value: "g4p.medium",
        label: "g4p.medium — 8 CPU / 32 GB",
        hourly: 0.238096,
        monthly: 173.81,
      },
      {
        value: "g4p.large",
        label: "g4p.large — 16 CPU / 64 GB",
        hourly: 0.476192,
        monthly: 347.62,
      },
      {
        value: "g4p.xlarge",
        label: "g4p.xlarge — 32 CPU / 128 GB",
        hourly: 0.952384,
        monthly: 695.24,
      },
    ],
    defaults: { region: "NYC1", size: "g4s.medium" },
  },
  aws: {
    regions: [
      "us-east-1",
      "us-east-2",
      "us-west-2",
      "eu-west-1",
      "eu-central-1",
      "sa-east-1",
    ],
    sizes: [
      {
        value: "t3.small",
        label: "t3.small — 2 vCPU / 2 GB",
        hourly: 0.0208,
        monthly: 15.18,
      },
      {
        value: "t3.medium",
        label: "t3.medium — 2 vCPU / 4 GB",
        hourly: 0.0416,
        monthly: 30.37,
      },
      {
        value: "t3.large",
        label: "t3.large — 2 vCPU / 8 GB",
        hourly: 0.0832,
        monthly: 60.74,
      },
      {
        value: "t3.xlarge",
        label: "t3.xlarge — 4 vCPU / 16 GB",
        hourly: 0.1664,
        monthly: 121.47,
      },
      {
        value: "c5.2xlarge",
        label: "c5.2xlarge — 8 vCPU / 16 GB",
        hourly: 0.34,
        monthly: 248.2,
      },
    ],
    defaults: { region: "us-east-1", size: "t3.medium" },
  },
};

function providerHasCredentials(
  provider: SandboxProvider,
  readiness: SandboxReadiness,
): boolean {
  return provider === "aws"
    ? readiness.hasAwsCredentials
    : readiness.hasCivoToken;
}

const ACTIVE_STATUSES = ["pending", "provisioning", "destroying"];

// Statuses that can change without this UI causing it: a local container can
// die on its own (OOM, Docker restart), which the list route reconciles into
// "paused". Polled slower than a transition in flight — nothing is mid-move,
// we are only watching for reality to diverge.
const RECONCILED_STATUSES = ["running", "paused"];

// Every sandbox needs a git token (private clones) and a Claude Code token
// (headless agent) from the first boot. Both live in global config — saved
// git credentials and Settings → AI Providers — with project env vars as
// per-project overrides. Launch is blocked until both resolve (also enforced
// server-side in sandbox-manager).
const GIT_TOKEN_KEYS = ["GITHUB_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN"];

/** The drawer width remembered across sessions. The wizard's own URL state
    (step + destination) lives in `@/lib/sandbox-setup-wizard`. Both are
    UI-only — nothing here is authoritative config. */
const SANDBOX_SHEET_WIDTH_KEY = "nexux:sandbox-setup:width";

type Props = {
  projectId: string;
  /** Open a terminal to a sandbox. `target` is a full cwd URL —
      `ssh://user@host/path` (cloud) or `docker://container/path` (local). */
  onOpenTerminal?: (target: string, label: string) => void;
  /** Jump to the Stack tab (to define service dependencies). */
  onOpenStack?: () => void;
};

export function ProjectSandboxes({
  projectId,
  onOpenTerminal,
  onOpenStack,
}: Props) {
  const qc = useQueryClient();
  // Restoring the step is only useful if the drawer itself comes back, so the
  // open state rides along in ?sandboxSetup=1.
  const [drawerOpen, setDrawerOpenState] = useState(false);
  // After mount, not in the initializer: the server renders the drawer closed,
  // so opening it during the first render would break hydration.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(SANDBOX_OPEN_PARAM) !== "1") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpenState(true);
  }, []);
  // ⌘J deep link: ?sandbox=<id> names the row to reach, &dev=1 opens its
  // console. Read after mount for the same reason as the drawer above — the
  // server renders nothing focused, and resolving it during the first render
  // would break hydration.
  const [focusSandboxId, setFocusSandboxId] = useState<string | null>(null);
  const [focusDev, setFocusDev] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("sandbox");
    if (!id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusSandboxId(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusDev(params.get("dev") === "1");
  }, []);
  const setDrawerOpen = (open: boolean) => {
    setDrawerOpenState(open);
    const url = new URL(window.location.href);
    if (open) {
      url.searchParams.set(SANDBOX_OPEN_PARAM, "1");
    } else {
      // Keep ?sandboxStep= — the editor stays mounted behind the closing
      // drawer, so dropping it here would leave the URL disagreeing with the
      // step the wizard is still on, and reopening would look like a reset.
      url.searchParams.delete(SANDBOX_OPEN_PARAM);
    }
    window.history.replaceState(window.history.state, "", url.toString());
  };

  const setup = useQuery({
    queryKey: ["project-setup", projectId],
    queryFn: () => getProjectSetup(projectId),
  });

  const sandboxes = useQuery({
    queryKey: ["sandboxes", projectId],
    queryFn: () => getSandboxes(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.some((s) => ACTIVE_STATUSES.includes(s.status))) return 3000;
      // A local sandbox can stop outside this UI; keep checking so the row
      // flips to "paused" (and offers Resume) without a manual refresh.
      if (
        data?.some(
          (s) => s.provider === "local" && RECONCILED_STATUSES.includes(s.status),
        )
      ) {
        return 15000;
      }
      return false;
    },
  });

  const destroyMutation = useMutation({
    mutationFn: (sandboxId: string) => destroySandbox(projectId, sandboxId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] }),
  });

  if (setup.isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sandboxes...
      </div>
    );
  }

  if (setup.isError || !setup.data) {
    return (
      <p className="mt-4 text-sm text-destructive">
        Failed to load sandbox setup.
      </p>
    );
  }

  const { readiness } = setup.data;
  const list = sandboxes.data ?? [];
  // Two independent paths to a sandbox, and the drawer already knows both:
  // a cloud instance (terraform + a provider token) or a local container
  // (Docker alone — `launchSandbox` asks for nothing else when the provider is
  // "local"). Gating the button on the cloud path hid the one that needs no
  // account at all.
  const cloudReady =
    readiness.terraformInstalled &&
    (readiness.hasCivoToken || readiness.hasAwsCredentials);
  const ready = cloudReady || readiness.dockerInstalled;

  // The in-app terminal lands in the main repo's checkout on the instance
  // (cloned or mounted — both live under /opt/nexus/<slug>).
  const mainRepo =
    setup.data.repositories.find((r) => r.isMain && (r.repoUrl || r.localPath)) ??
    setup.data.repositories.find((r) => r.repoUrl || r.localPath);
  const terminalPath = mainRepo
    ? `/opt/nexus/${sandboxRepoSlug(mainRepo.name)}`
    : "/opt/nexus";

  return (
    <div className="mt-4 space-y-4">
      <ReadinessBanner
        readiness={readiness}
        onCredentialsSaved={() => invalidateCredentialQueries(qc)}
      />

      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-orange-400" />
              Sandboxes
            </span>
            <span className="flex items-center gap-2">
              {/* Same drawer, but reachable without implying a launch. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDrawerOpen(true)}
                className="gap-1.5"
                title="Repositories, build/run commands, env vars and agent policy"
              >
                Settings
              </Button>
              <Button
                size="sm"
                onClick={() => setDrawerOpen(true)}
                disabled={!ready}
                title={
                  ready
                    ? "Configure and launch an ephemeral instance"
                    : "Start Docker for a local sandbox, or install terraform and add Civo or AWS credentials for a cloud one"
                }
              >
                New sandbox
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {destroyMutation.isError && (
            <p className="text-xs text-destructive">
              {(destroyMutation.error as Error).message}
            </p>
          )}

          {list.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No sandboxes yet. <span className="font-medium">New sandbox</span>{" "}
              provisions a cloud instance (Civo or AWS EC2) that clones this
              project&apos;s repositories and installs its tooling. Instances
              bill until destroyed.
            </p>
          )}

          {list.map((s) => (
            <SandboxRow
              key={s.id}
              projectId={projectId}
              sandbox={s}
              onDestroy={() => destroyMutation.mutate(s.id)}
              destroying={destroyMutation.isPending}
              onOpenTerminal={onOpenTerminal}
              terminalPath={terminalPath}
              // ⌘J deep link: scroll to this row, and open its console when the
              // entry that sent you here was a dev prompt.
              focus={focusSandboxId === s.id}
              autoOpenDev={focusSandboxId === s.id && focusDev}
            />
          ))}
        </CardContent>
      </Card>

      {/* Tasks — visible here even after the feature dialog is closed. */}
      <ProjectTasksCard projectId={projectId} />

      {/* Cron / one-shot runs with the full ephemeral cycle. */}
      <ScheduledTasksCard projectId={projectId} />

      <SandboxSetupSheet
        projectId={projectId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onOpenStack={onOpenStack}
        persistStepInUrl
      />
    </div>
  );
}

/** The sandbox settings drawer (instance config, repo commands, env vars,
    agent policy) as a standalone sheet — reused by the Run dialog so a
    launch-and-run goes through the same config UI. */
export function SandboxSetupSheet({
  projectId,
  open,
  onOpenChange,
  onOpenStack,
  launchOverride,
  persistStepInUrl = false,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenStack?: () => void;
  launchOverride?: { label: string; action: () => Promise<unknown> };
  /** Mirror open state + current step into the URL so a refresh restores them.
      Only the Sandboxes tab does this — the Run dialog opens the same sheet
      transiently and shouldn't fight it for the same query params. */
  persistStepInUrl?: boolean;
}) {
  const setup = useQuery({
    queryKey: ["project-setup", projectId],
    queryFn: () => getProjectSetup(projectId),
    enabled: open,
  });

  const { width, resizing, onResizeStart, onResizeKeyDown } =
    useResizablePanel({
      storageKey: SANDBOX_SHEET_WIDTH_KEY,
      defaultWidth: 576, // matches the previous sm:max-w-xl
    });

  // The editor reports whether the form differs from what was loaded, so a
  // stray click on the page doesn't silently throw away a filled-in wizard.
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /** Close for real, resetting the guard so the next open starts clean. */
  const forceClose = () => {
    setDirty(false);
    setConfirmDiscard(false);
    onOpenChange(false);
  };

  return (
    <>
    <Sheet
      open={open}
      onOpenChange={(next, details) => {
        // Only intercept dismissals that are easy to trigger by accident.
        // The explicit X / Cancel buttons close as asked.
        const accidental =
          details?.reason === "outside-press" || details?.reason === "escape-key";
        if (!next && dirty && accidental) {
          details?.cancel();
          setConfirmDiscard(true);
          return;
        }
        if (!next) setDirty(false);
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 data-[side=right]:sm:max-w-none"
        style={{ width: `min(100vw, ${width}px)` }}
        resizeHandle={{
          onPointerDown: onResizeStart,
          onKeyDown: onResizeKeyDown,
          resizing,
          label: "Resize sandbox settings panel",
        }}
      >
        <SheetHeader className="border-b border-border/40">
          <SheetTitle className="flex items-center gap-2">
            <Server className="h-4 w-4 text-sky-400" />
            Sandbox settings
          </SheetTitle>
          <SheetDescription>
            Step through where it runs, the code it gets, tooling and agent
            policy — everything is saved per project. Launch at the end, or
            just save.
          </SheetDescription>
        </SheetHeader>
        {setup.isLoading && (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading sandbox setup...
          </div>
        )}
        {setup.isError && (
          <p className="px-4 py-4 text-sm text-destructive">
            Failed to load sandbox setup.
          </p>
        )}
        {setup.data && (
          <SetupEditor
            projectId={projectId}
            initialConfig={setup.data.config}
            repositories={setup.data.repositories}
            envVars={setup.data.envVars}
            globalEnvVars={setup.data.globalEnvVars ?? []}
            stackServices={setup.data.stack.services}
            stackEnvSources={setup.data.stack.envSources ?? []}
            credentials={setup.data.credentials}
            readiness={setup.data.readiness}
            onLaunched={forceClose}
            onOpenStack={onOpenStack}
            launchOverride={launchOverride}
            onDirtyChange={setDirty}
            persistStepInUrl={persistStepInUrl}
          />
        )}
      </SheetContent>
    </Sheet>

    <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This sandbox configuration has unsaved changes. Closing now loses
            them — use Save in the footer to keep them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={forceClose}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

// Form state initializes from the loaded setup payload; the component only
// mounts once data exists, so no hydration effect is needed.
function SetupEditor({
  projectId,
  initialConfig,
  repositories,
  envVars,
  globalEnvVars,
  stackServices,
  stackEnvSources = [],
  credentials,
  readiness,
  onLaunched,
  onOpenStack,
  launchOverride,
  onDirtyChange,
  persistStepInUrl = false,
}: {
  projectId: string;
  initialConfig: ProjectSetupData["config"];
  repositories: RepoWithSetup[];
  envVars: ProjectSetupData["envVars"];
  globalEnvVars: ProjectSetupData["globalEnvVars"];
  stackServices: StackServiceSummary[];
  stackEnvSources?: StackEnvSource[];
  credentials: CloudCredentialSummary[];
  readiness: SandboxReadiness;
  onLaunched: () => void;
  onOpenStack?: () => void;
  /** Replaces the default launch action + button label (config is saved first
      either way). The Run dialog uses this for launch-and-run dispatch. */
  launchOverride?: { label: string; action: () => Promise<unknown> };
  /** Reports unsaved edits so the drawer can guard an accidental dismissal. */
  onDirtyChange?: (dirty: boolean) => void;
  persistStepInUrl?: boolean;
}) {
  const qc = useQueryClient();

  // What the Stack canvas supplies when this config leaves a field blank.
  const { data: inherited } = useQuery({
    queryKey: ["stack-inheritance", projectId],
    queryFn: () => getStackInheritance(projectId),
    staleTime: 30_000,
  });

  // Detection drives the placeholders so they name the repo's real package
  // manager — a hardcoded "pnpm install" lies on an npm repo.
  const { data: detections } = useQuery({
    queryKey: ["stack-detections", projectId],
    queryFn: () => detectAllRepositories(projectId),
    enabled: repositories.length > 0,
    // A lockfile can change between visits, and a stale scan makes the
    // placeholders name the wrong package manager — rescan when the dialog
    // opens rather than trusting whatever the Stack tab cached earlier.
    staleTime: 0,
    refetchOnMount: "always",
  });

  /** What the Stack canvas says boots a given repo, if it has a node. */
  const stackCommandFor = (repositoryId: string) =>
    inherited?.repoCommands.find((c) => c.repositoryId === repositoryId) ?? null;

  /**
   * Placeholder for a repo command: the stack node wins, then what detection
   * suggests for that repo, and only then a generic guess.
   */
  const placeholderFor = (
    repositoryId: string,
    field: "install" | "build" | "run",
  ): string => {
    const stack = stackCommandFor(repositoryId);
    const det = detections?.[repositoryId];
    if (field === "install") {
      return (
        stack?.installCommand ??
        det?.suggestedCommands.install ??
        "pnpm install"
      );
    }
    if (field === "build") {
      // A repo with no build script gets no suggestion — promising "pnpm build"
      // for a script that does not exist is worse than saying nothing.
      if (stack?.buildCommand) return stack.buildCommand;
      if (det) return det.suggestedCommands.build ?? "none — no build script";
      return "pnpm build";
    }
    return (
      stack?.runCommand ??
      det?.suggestedCommands.dev ??
      det?.suggestedCommands.start ??
      "pnpm start"
    );
  };

  const [config, setConfig] = useState<SandboxConfigInput>(() => ({
    // `config.provider` names the *cloud* provider whose regions and sizes the
    // form edits; where the sandbox runs is `destination`. A saved "local" is
    // therefore not a provider this form can show — it resolves to the
    // destination instead, and the cloud fields keep their Civo defaults until
    // the user picks a cloud.
    provider: initialConfig.provider === "aws" ? "aws" : "civo",
    credentialId:
      initialConfig.credentialId ??
      credentials.find(
        (c) =>
          c.provider === (initialConfig.provider === "aws" ? "aws" : "civo"),
      )?.id ??
      null,
    githubCredentialId:
      initialConfig.githubCredentialId ??
      credentials.find(
        (c) =>
          c.provider === "github" ||
          c.provider === "gitlab" ||
          c.provider === "bitbucket",
      )?.id ??
      null,
    claudeCredentialId:
      initialConfig.claudeCredentialId ??
      credentials.find((c) => c.provider === "claude")?.id ??
      null,
    region: initialConfig.region,
    size: initialConfig.size,
    diskImage: initialConfig.diskImage,
    branch: initialConfig.branch ?? "",
    sshPublicKey: initialConfig.sshPublicKey ?? "",
    installDocker: initialConfig.installDocker,
    installNode: initialConfig.installNode,
    installClaudeCode: initialConfig.installClaudeCode,
    installOpenCode: initialConfig.installOpenCode ?? false,
    installAgentBrowser: initialConfig.installAgentBrowser,
    installBrowserSession: initialConfig.installBrowserSession ?? false,
    installCloudflared: initialConfig.installCloudflared,
    installTailscale: initialConfig.installTailscale ?? false,
    tailscaleCredentialId:
      initialConfig.tailscaleCredentialId ??
      credentials.find((c) => c.provider === "tailscale")?.id ??
      null,
    includeStackServices: initialConfig.includeStackServices,
    telegramChatId: initialConfig.telegramChatId ?? "",
    slackChannelId: initialConfig.slackChannelId ?? "",
    taskTimeoutMinutes: initialConfig.taskTimeoutMinutes ?? null,
    setupScript: initialConfig.setupScript ?? "",
    agentInstructions: initialConfig.agentInstructions ?? "",
    createPr: initialConfig.createPr,
    runTests: initialConfig.runTests,
    captureScreenshots: initialConfig.captureScreenshots,
    livePreview: initialConfig.livePreview,
    previewPort: initialConfig.previewPort,
    claudeModel: initialConfig.claudeModel ?? null,
    brain: initialConfig.brain === "opencode" ? "opencode" : "claude",
    openCodeModel: initialConfig.openCodeModel ?? null,
    llmCredentialIds: initialConfig.llmCredentialIds ?? [],
  }));
  // MCP servers edit as raw JSON — parsed/validated on save.
  const [mcpJson, setMcpJson] = useState<string>(() =>
    initialConfig.mcpServers &&
    typeof initialConfig.mcpServers === "object" &&
    Object.keys(initialConfig.mcpServers).length > 0
      ? JSON.stringify(initialConfig.mcpServers, null, 2)
      : "",
  );
  const [repoSetups, setRepoSetups] = useState<
    Record<string, Omit<RepoSetupInput, "repositoryId">>
  >(() =>
    Object.fromEntries(
      repositories.map((r) => [
        r.id,
        {
          installCommand: r.setup?.installCommand ?? "",
          buildCommand: r.setup?.buildCommand ?? "",
          runCommand: r.setup?.runCommand ?? "",
          branch: r.setup?.branch ?? "",
        },
      ]),
    ),
  );

  // Snapshot of the form as it was loaded (and as it is after each successful
  // save). Comparing serialized state is enough here — these are plain JSON
  // values, and it costs far less than threading a dirty flag through every
  // one of the wizard's inputs.
  const snapshot = () => JSON.stringify({ config, mcpJson, repoSetups });
  // State, not a ref: `dirty` is derived from it during render, and a save
  // legitimately re-renders the footer ("Saved.") anyway. The initializer runs
  // once, capturing the form exactly as it was loaded.
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
  const dirty = snapshot() !== savedSnapshot;

  // Deliberately outside `snapshot`: the name belongs to the sandbox about to
  // be created, not to the project's saved configuration, so typing one must
  // not mark the form dirty.
  const [sandboxName, setSandboxName] = useState("");
  const namePreview = previewSandboxName(sandboxName);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = () => {
    let mcpServers: Record<string, Record<string, unknown>> | null = null;
    const rawMcp = mcpJson.trim();
    if (rawMcp) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMcp);
      } catch {
        throw new Error("MCP servers: invalid JSON");
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some(
          (v) => !v || typeof v !== "object" || Array.isArray(v),
        )
      ) {
        throw new Error(
          'MCP servers: expected { "<name>": { command | url, ... } }',
        );
      }
      mcpServers = parsed as Record<string, Record<string, unknown>>;
    }
    return saveProjectSetup(projectId, {
      config: { ...config, mcpServers },
      repoSetups: Object.entries(repoSetups).map(([repositoryId, s]) => ({
        repositoryId,
        ...s,
      })),
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Capture what was actually persisted before awaiting — an edit made
      // while the request is in flight must stay dirty.
      const persisted = snapshot();
      const result = await save();
      setSavedSnapshot(persisted);
      return result;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["project-setup", projectId] }),
  });

  // Reuses the Stack tab's repo scanner: package manager + scripts become
  // suggested install/build/run commands. Only fills fields left empty.
  const [envSuggestions, setEnvSuggestions] = useState<
    Array<{ key: string; repositoryId: string; repoName: string }>
  >([]);

  const detectMutation = useMutation({
    mutationFn: () => detectAllRepositories(projectId),
    onSuccess: (results) => {
      // These are the freshest scan results there are — publish them to the
      // shared cache so the placeholders stop advertising a stale package
      // manager while the fields get filled with the current one.
      qc.setQueryData(["stack-detections", projectId], results);
      // .env.example keys the repo expects but nothing defines yet — offered
      // as one-click chips in the env editor (values still come from you).
      const defined = new Set(envVars.map((v) => v.key));
      const suggestions: Array<{
        key: string;
        repositoryId: string;
        repoName: string;
      }> = [];
      for (const [repoId, det] of Object.entries(results)) {
        const repo = repositories.find((r) => r.id === repoId);
        for (const k of det.envExampleKeys ?? []) {
          if (defined.has(k)) continue;
          if (suggestions.some((sug) => sug.key === k)) continue;
          suggestions.push({
            key: k,
            repositoryId: repoId,
            repoName: repo?.name ?? "repo",
          });
        }
      }
      setEnvSuggestions(suggestions);
      setRepoSetups((prev) => {
        const next = { ...prev };
        for (const [repoId, det] of Object.entries(results)) {
          const cur = next[repoId];
          if (!cur) continue;
          // The Stack canvas beats detection for the run command: it is what
          // the user configured and verified, not a guess from package.json.
          const fromStack = inherited?.repoCommands.find(
            (c) => c.repositoryId === repoId,
          );
          next[repoId] = {
            installCommand:
              cur.installCommand?.trim() ||
              det.suggestedCommands.install ||
              cur.installCommand,
            buildCommand:
              cur.buildCommand?.trim() ||
              det.suggestedCommands.build ||
              cur.buildCommand,
            runCommand:
              cur.runCommand?.trim() ||
              fromStack?.runCommand ||
              det.suggestedCommands.dev ||
              det.suggestedCommands.start ||
              cur.runCommand,
          };
        }
        return next;
      });
    },
  });

  const launchMutation = useMutation({
    mutationFn: async (provider: LaunchTarget = "civo") => {
      const persisted = snapshot();
      await save();
      setSavedSnapshot(persisted);
      if (launchOverride) await launchOverride.action();
      else await launchSandbox(projectId, provider, sandboxName);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-setup", projectId] });
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
      onLaunched();
    },
  });

  const busy = saveMutation.isPending || launchMutation.isPending;

  const dockerStackServices = stackServices.filter(
    (s) => s.runMode === "docker",
  );
  const localStackServices = stackServices.filter(
    (s) => s.runMode !== "docker",
  );

  const gitCredentials = credentials.filter(
    (c) =>
      c.provider === "github" ||
      c.provider === "gitlab" ||
      c.provider === "bitbucket",
  );
  const claudeCredentials = credentials.filter((c) => c.provider === "claude");
  const tailscaleCredentials = credentials.filter(
    (c) => c.provider === "tailscale",
  );
  const llmCredentials = credentials.filter((c) =>
    [
      "openai",
      "openrouter",
      "google",
      "xai-llm",
      "anthropic-key",
      "zai",
    ].includes(c.provider),
  );
  const projectEnvKeys = new Set(
    envVars.filter((v) => !v.repositoryId).map((v) => v.key),
  );
  const missingTokens: string[] = [];
  const hasCloneableRepo = repositories.some((r) => r.repoUrl);
  if (
    hasCloneableRepo && // mounted-only local sandboxes need no git token
    gitCredentials.length === 0 &&
    !GIT_TOKEN_KEYS.some((k) => projectEnvKeys.has(k))
  ) {
    missingTokens.push("a git credential (Settings → Git)");
  }
  if (
    claudeCredentials.length === 0 &&
    !readiness.hasClaudeCodeToken &&
    !projectEnvKeys.has("CLAUDE_CODE_OAUTH_TOKEN")
  ) {
    missingTokens.push(
      "a Claude Code token (Settings → AI Providers, `claude setup-token`)",
    );
  }
  const providerOptions = PROVIDER_OPTIONS[config.provider];
  const providerCredentials = credentials.filter(
    (c) => c.provider === config.provider,
  );
  // Saved credentials for the provider, or legacy settings/env as fallback.
  const providerReady =
    providerCredentials.length > 0 ||
    providerHasCredentials(config.provider, readiness);
  const launchable =
    readiness.terraformInstalled && providerReady && missingTokens.length === 0;

  // Region/size lists and credentials differ per provider — switching resets
  // them so the form never holds an invalid combination.
  const switchProvider = (provider: SandboxProvider) => {
    if (provider === config.provider) return;
    const defaults = PROVIDER_OPTIONS[provider].defaults;
    setConfig({
      ...config,
      provider,
      credentialId:
        credentials.find((c) => c.provider === provider)?.id ?? null,
      region: defaults.region,
      size: defaults.size,
    });
  };

  // ---- Wizard ----
  // The drawer is a step-by-step wizard: pick where it runs, then only the
  // groups that apply. Steps are clickable — nothing blocks navigation, the
  // Launch step surfaces whatever is still missing.
  // Both the step and the Type step's answer are restored from the URL. The
  // destination has to come from there rather than from the saved config:
  // SandboxConfig.provider is civo | aws, so "local" has nowhere else to live
  // and a reload used to flip a local wizard back to a cloud instance.
  // Read once on mount — afterwards this state is the truth and the URL mirrors it.
  const restored = useState(() =>
    restoreWizardState(
      persistStepInUrl && typeof window !== "undefined"
        ? window.location.search
        : "",
      initialConfig.provider,
    ),
  )[0];
  const [destination, setDestination] = useState<SandboxDestination>(
    restored.destination,
  );
  const isLocal = destination === "local";
  const steps = stepsFor(destination);
  const [stepKey, setStepKeyState] = useState<WizardStepKey>(restored.step);
  const setStepKey = (key: WizardStepKey) => setStepKeyState(key);
  // Switching to local hides the Machine step — resolve rather than reset, so
  // the user lands on the next step that still exists instead of step 1.
  const step = resolveStep(stepKey, destination);
  const stepIndex = steps.findIndex((s) => s.key === step);
  // `step` can differ from `stepKey`, and `destination` is not in the URL until
  // it is written — keep the URL honest about where the wizard actually is.
  // replaceState (not push) so Back leaves the page instead of walking the user
  // backwards through every wizard step they visited.
  useEffect(() => {
    if (!persistStepInUrl || typeof window === "undefined") return;
    const next = applyWizardParams(window.location.href, {
      // The editor stays mounted behind the drawer's close animation, so this
      // effect must mirror whatever open state is already in the URL rather
      // than reopening the drawer on its way out.
      open:
        new URLSearchParams(window.location.search).get(SANDBOX_OPEN_PARAM) ===
        "1",
      step,
      destination,
    });
    if (next === window.location.href) return;
    window.history.replaceState(window.history.state, "", next);
  }, [step, destination, persistStepInUrl]);
  const goNext = () =>
    setStepKey(steps[Math.min(stepIndex + 1, steps.length - 1)].key);
  const goBack = () => setStepKey(steps[Math.max(stepIndex - 1, 0)].key);
  const pickDestination = (dest: SandboxDestination) => {
    setDestination(dest);
    if (dest !== "local") switchProvider(dest);
  };
  const sizeInfo = providerOptions.sizes.find((s) => s.value === config.size);
  const enabledTools = [
    config.installDocker && "Docker",
    config.installNode && "Node.js 22",
    config.installClaudeCode && "Claude Code",
    (config.installOpenCode || config.brain === "opencode") && "OpenCode",
    config.installAgentBrowser && "agent-browser",
    config.installBrowserSession && "Browser session",
    config.installCloudflared && "cloudflared",
    config.installTailscale && "Tailscale",
  ].filter(Boolean) as string[];
  const canLaunch = isLocal ? missingTokens.length === 0 : launchable;
  const clonedRepos = repositories.filter((r) => r.repoUrl);

  const destinationCards: Array<{
    key: "local" | SandboxProvider;
    title: string;
    desc: string;
    icon: typeof Server;
  }> = [
    {
      key: "local",
      title: "Local — Docker container",
      desc: "Runs on this machine with the same bootstrap. Free; needs Docker running.",
      icon: Server,
    },
    {
      key: "civo",
      title: "Civo cloud instance",
      desc: "From $5.43/mo — billed until destroyed.",
      icon: Cloud,
    },
    {
      key: "aws",
      title: "AWS EC2 instance",
      desc: "From $15.18/mo (us-east-1) — billed until destroyed.",
      icon: Cloud,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Steps scroll; the action footer below stays pinned to the drawer. */}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
      {/* Stepper — clickable, with the Machine step only for cloud targets. */}
      <nav
        className="flex flex-wrap items-center gap-y-1.5"
        aria-label="Sandbox setup steps"
      >
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center">
            {i > 0 && (
              <ChevronRight className="mx-0.5 h-3 w-3 text-muted-foreground/40" />
            )}
            <button
              type="button"
              onClick={() => setStepKey(s.key)}
              className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors ${
                i === stepIndex
                  ? "bg-primary/15 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                  i === stepIndex
                    ? "border-primary/60 text-primary"
                    : i < stepIndex
                      ? "border-emerald-500/60 text-emerald-400"
                      : "border-border"
                }`}
              >
                {i < stepIndex ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {s.label}
            </button>
          </div>
        ))}
      </nav>

      {/* Step 1 — where does it run */}
      {step === "type" && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Where does it run?</h3>
            <p className="text-xs text-muted-foreground">
              Same bootstrap everywhere: repos cloned, tools installed, stack
              services up.
            </p>
          </div>
          <div className="grid gap-2">
            {destinationCards.map((c) => {
              const selected = destination === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => pickDestination(c.key)}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/60 bg-muted/20 hover:border-border"
                  }`}
                >
                  <c.icon
                    className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{c.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {c.desc}
                    </span>
                  </span>
                  {selected && (
                    <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
          {!isLocal && (
            <div className="grid gap-3">
              <CredentialPicker
                providers={[config.provider]}
                credentials={providerCredentials}
                value={config.credentialId ?? null}
                legacyAvailable={providerHasCredentials(
                  config.provider,
                  readiness,
                )}
                onChange={(credentialId) =>
                  setConfig({ ...config, credentialId })
                }
              />
            </div>
          )}
          {!isLocal && !readiness.terraformInstalled && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Terraform is not installed on this machine — cloud sandboxes
              can&apos;t launch until it is.
            </p>
          )}
        </section>
      )}

      {/* Step 2 — machine (cloud only) */}
      {step === "machine" && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Machine</h3>
            <p className="text-xs text-muted-foreground">
              Size and region for the {providerLabel(config.provider)}{" "}
              instance.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label>Region</Label>
            <Select
              value={config.region}
              onValueChange={(v) => v && setConfig({ ...config, region: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.regions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Size</Label>
            <Select
              value={config.size}
              onValueChange={(v) => v && setConfig({ ...config, size: v })}
            >
              <SelectTrigger className="w-full">
                {/* Full-width row: the trigger can show the descriptive label. */}
                <SelectValue>
                  {(value) => (
                    <span className="truncate">
                      {providerOptions.sizes.find((s) => s.value === value)
                        ?.label ?? String(value)}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providerOptions.sizes.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    <span className="flex w-full items-baseline gap-2">
                      {s.label}
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        ${s.monthly.toFixed(2)}/mo
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sizeInfo && (
              <p className="font-mono text-[10px] text-muted-foreground">
                ~${sizeInfo.hourly.toFixed(3)}/h · $
                {sizeInfo.monthly.toFixed(2)}/mo — billed until destroyed
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>Disk image</Label>
            <Select
              value={config.diskImage}
              onValueChange={(v) => v && setConfig({ ...config, diskImage: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISK_IMAGES.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ssh-key">SSH public key (optional)</Label>
            <Textarea
              id="ssh-key"
              value={config.sshPublicKey ?? ""}
              onChange={(e) =>
                setConfig({ ...config, sshPublicKey: e.target.value })
              }
              placeholder="ssh-ed25519 AAAA... you@machine"
              rows={2}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              With a key, the in-app terminal connects without a password.
            </p>
          </div>
        </section>
      )}

      {/* Step 3 — code: branch, repos, env vars */}
      {step === "code" && (
        <section className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Code</h3>
              <p className="text-xs text-muted-foreground">
                What gets cloned, how it builds and runs, and its environment.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => detectMutation.mutate()}
              disabled={detectMutation.isPending || repositories.length === 0}
              className="shrink-0 gap-1.5"
              title="Scan each repo's package.json/Makefile and fill the empty install/build/run fields (same detection as the Stack tab)"
            >
              {detectMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Auto-detect
            </Button>
          </div>
          {detectMutation.isSuccess && (
            <p className="text-[10px] text-emerald-400">
              Commands detected — empty fields were filled; existing values
              were left untouched.
            </p>
          )}
          {detectMutation.isError && (
            <p className="text-[10px] text-destructive">
              {(detectMutation.error as Error).message}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="base-branch">Base branch (optional)</Label>
            <Input
              id="base-branch"
              value={config.branch ?? ""}
              onChange={(e) => setConfig({ ...config, branch: e.target.value })}
              placeholder="main"
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Repos are cloned at this branch, and task branches and PRs start
              from it. Empty = each repo&apos;s default branch.
            </p>
          </div>
          {repositories.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No repositories yet. Add them in the Overview tab — repos with a
              clone URL are cloned into <code>/opt/nexus/&lt;name&gt;</code>;
              local-only folders are mounted there on local sandboxes.
            </p>
          )}
          {repositories.map((repo) => (
            <div
              key={repo.id}
              className="rounded-md border border-border/50 bg-muted/20 p-3 space-y-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{repo.name}</span>
                {repo.isMain && (
                  <Badge variant="outline" className="text-[10px]">
                    main
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground font-mono truncate">
                  {repo.repoUrl ??
                    (repo.localPath
                      ? `${repo.localPath} — mounted in local sandboxes`
                      : "no clone URL — skipped in sandbox")}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Input
                  value={repoSetups[repo.id]?.branch ?? ""}
                  onChange={(e) =>
                    setRepoSetups((prev) => ({
                      ...prev,
                      [repo.id]: { ...prev[repo.id], branch: e.target.value },
                    }))
                  }
                  placeholder={
                    config.branch
                      ? `Branch: ${config.branch} (project default)`
                      : "Branch: repo default"
                  }
                  className="font-mono text-xs"
                />
                <Input
                  value={repoSetups[repo.id]?.installCommand ?? ""}
                  onChange={(e) =>
                    setRepoSetups((prev) => ({
                      ...prev,
                      [repo.id]: {
                        ...prev[repo.id],
                        installCommand: e.target.value,
                      },
                    }))
                  }
                  placeholder={`Install: ${placeholderFor(repo.id, "install")}`}
                  className="font-mono text-xs"
                />
                <Input
                  value={repoSetups[repo.id]?.buildCommand ?? ""}
                  onChange={(e) =>
                    setRepoSetups((prev) => ({
                      ...prev,
                      [repo.id]: {
                        ...prev[repo.id],
                        buildCommand: e.target.value,
                      },
                    }))
                  }
                  placeholder={`Build: ${placeholderFor(repo.id, "build")}`}
                  className="font-mono text-xs"
                />
                <Input
                  value={repoSetups[repo.id]?.runCommand ?? ""}
                  onChange={(e) =>
                    setRepoSetups((prev) => ({
                      ...prev,
                      [repo.id]: {
                        ...prev[repo.id],
                        runCommand: e.target.value,
                      },
                    }))
                  }
                  placeholder={`Run: ${placeholderFor(repo.id, "run")}`}
                  className="font-mono text-xs"
                />
                {stackCommandFor(repo.id) &&
                !(
                  repoSetups[repo.id]?.runCommand?.trim() &&
                  repoSetups[repo.id]?.installCommand?.trim() &&
                  repoSetups[repo.id]?.buildCommand?.trim()
                ) ? (
                  <p className="text-[10px] text-muted-foreground">
                    Greyed commands come from the Stack canvas (
                    <span className="font-mono">
                      {stackCommandFor(repo.id)!.nodeName}
                    </span>
                    )
                    {stackCommandFor(repo.id)!.managesServices
                      ? " — starts background services"
                      : ""}
                    . Leave a field empty to use it.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Variable className="h-3.5 w-3.5" />
              Environment variables
            </h4>
            {globalEnvVars.length > 0 && (
              <div className="space-y-1.5">
                {globalEnvVars.map((g) => (
                  <div
                    key={g.key}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-muted/10 px-3 py-1.5"
                  >
                    <span className="font-mono text-xs">{g.key}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {g.source === "credential"
                        ? `credential${g.credentialName ? ` · ${g.credentialName}` : ""}`
                        : "global"}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {g.valueMasked}
                    </span>
                    <span
                      className={`ml-auto text-[10px] ${g.applied ? "text-emerald-400" : "text-muted-foreground"}`}
                    >
                      {g.applied ? "passed to every sandbox" : g.reason}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">
                  From Settings and saved credentials — managed there,
                  injected at launch. Project vars with the same key win.
                </p>
              </div>
            )}
            <EnvVarsEditor
              projectId={projectId}
              envVars={envVars}
              repositories={repositories}
              suggestions={envSuggestions}
              stackSources={stackEnvSources}
            />
          </div>
        </section>
      )}

      {/* Step 4 — tooling: installed tools, stack services, setup script */}
      {step === "tooling" && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Tooling</h3>
            <p className="text-xs text-muted-foreground">
              What gets installed and started during the bootstrap.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ToolToggle
              label="Docker"
              checked={config.installDocker}
              onChange={(v) => setConfig({ ...config, installDocker: v })}
            />
            <ToolToggle
              label="Node.js 22"
              checked={config.installNode}
              onChange={(v) => setConfig({ ...config, installNode: v })}
            />
            <ToolToggle
              label="Claude Code"
              checked={config.installClaudeCode}
              onChange={(v) => setConfig({ ...config, installClaudeCode: v })}
            />
            <ToolToggle
              label={
                config.brain === "opencode"
                  ? "OpenCode (required by the brain)"
                  : "OpenCode"
              }
              checked={config.installOpenCode || config.brain === "opencode"}
              onChange={(v) =>
                config.brain !== "opencode" &&
                setConfig({ ...config, installOpenCode: v })
              }
            />
            <ToolToggle
              label="agent-browser"
              checked={config.installAgentBrowser}
              onChange={(v) =>
                setConfig({
                  ...config,
                  installAgentBrowser: v,
                  // The session is a display around *that* browser; without it
                  // there is nothing to show, and `launchSandbox` forces the
                  // flag off anyway. Clearing it here keeps the panel honest
                  // instead of offering a toggle the bootstrap ignores.
                  installBrowserSession: v ? config.installBrowserSession : false,
                })
              }
            />
            <ToolToggle
              label="Browser session"
              checked={config.installBrowserSession ?? false}
              disabled={!config.installAgentBrowser}
              onChange={(v) => setConfig({ ...config, installBrowserSession: v })}
            />
            <ToolToggle
              label="cloudflared"
              checked={config.installCloudflared}
              onChange={(v) => setConfig({ ...config, installCloudflared: v })}
            />
            <ToolToggle
              label="Tailscale"
              checked={config.installTailscale ?? false}
              onChange={(v) => setConfig({ ...config, installTailscale: v })}
            />
          </div>

          {/* Optional tailnet membership: the bootstrap joins with the saved
              auth key; without one, tailscale is installed but not joined. */}
          {config.installTailscale && (
            <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 p-3">
              <CredentialPicker
                providers={["tailscale"]}
                label="Tailscale auth key"
                credentials={tailscaleCredentials}
                value={config.tailscaleCredentialId ?? null}
                legacyAvailable={false}
                onChange={(tailscaleCredentialId) =>
                  setConfig({ ...config, tailscaleCredentialId })
                }
              />
              <p className="text-[10px] text-muted-foreground">
                Ephemeral, pre-authorized keys are recommended. Without a key
                the instance installs Tailscale but joins nothing.
              </p>
            </div>
          )}

          {/* Stack services — docker services from the Stack tab, started on
              the instance before repos install. */}
          <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Database className="h-3.5 w-3.5 text-sky-400" />
                Stack services
              </span>
              <Switch
                size="sm"
                checked={config.includeStackServices}
                onCheckedChange={(v) =>
                  setConfig({ ...config, includeStackServices: v })
                }
              />
            </div>
            {dockerStackServices.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {dockerStackServices.map((s) => (
                    <Badge
                      key={s.name}
                      variant="secondary"
                      className="text-[10px]"
                    >
                      {s.name}
                      {s.image ? ` · ${s.image}` : ""}
                    </Badge>
                  ))}
                  {localStackServices.map((s) => (
                    <Badge
                      key={s.name}
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      {s.name} · local only
                    </Badge>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Started with docker compose before repos install, so builds
                  and tests find their dependencies listening.
                </p>
                {config.includeStackServices && !config.installDocker && (
                  <p className="text-[10px] text-amber-500">
                    Stack services require Docker — enable the Docker toggle
                    above.
                  </p>
                )}
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                0 services from Stack — define postgres, redis and friends in
                the Stack tab and every sandbox gets them.{" "}
                {onOpenStack && (
                  <button
                    type="button"
                    onClick={onOpenStack}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Open Stack
                  </button>
                )}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="setup-script">Extra setup script (optional)</Label>
            <Textarea
              id="setup-script"
              value={config.setupScript ?? ""}
              onChange={(e) =>
                setConfig({ ...config, setupScript: e.target.value })
              }
              placeholder={`# bash, runs at the end of the bootstrap\napt-get install -y postgresql-client`}
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-servers">MCP servers (optional)</Label>
            <Textarea
              id="mcp-servers"
              value={mcpJson}
              onChange={(e) => setMcpJson(e.target.value)}
              placeholder={`{\n  "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },\n  "my-api": { "type": "http", "url": "https://mcp.example.com" }\n}`}
              rows={5}
              className="max-h-64 font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Claude Code&apos;s native <code>mcpServers</code> JSON — written
              to <code>~/.claude.json</code> (agent user and root) at
              bootstrap, so headless runs, the dev console and the terminal
              all load them. Applies to sandboxes launched after saving.
              Auth: save the secret as a project env var and reference it as{" "}
              <code>{"${MY_KEY}"}</code> in <code>env</code>/<code>headers</code>{" "}
              — Claude Code expands it; stdio servers also inherit the sandbox
              env. OAuth-only MCPs don&apos;t work headless — prefer the API-key
              variant.
            </p>
          </div>
        </section>
      )}

      {/* Step 5 — agent: tokens, policy, notifications */}
      {step === "agent" && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Agent</h3>
            <p className="text-xs text-muted-foreground">
              Tokens the agent runs with, what each task must deliver, and
              where it notifies. The project&apos;s enabled skills are injected
              into each run.
            </p>
          </div>

          {/* Which agent CLI runs delegated work. Claude Code authenticates
              with an OAuth token; OpenCode with per-provider API keys. */}
          <div className="grid gap-1.5">
            <Label>Brain</Label>
            <Select
              value={config.brain}
              onValueChange={(v) =>
                v &&
                setConfig({ ...config, brain: v as "claude" | "opencode" })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(value) =>
                    BRAINS.find((b) => b.value === value)?.label ??
                    String(value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {BRAINS.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    <span className="flex w-full items-baseline gap-2">
                      {b.label}
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {b.hint}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Every agent run on this project&apos;s sandboxes (tasks,
              follow-ups and the dev console) is delegated to this CLI.
            </p>
          </div>

          {/* Which git token clones private repos / opens PRs, and which
              agent credential the CLI runs with. Project-level token env
              vars override both. */}
          <div className="grid gap-3">
            <CredentialPicker
              providers={["github", "gitlab", "bitbucket"]}
              label="Git token"
              credentials={gitCredentials}
              value={config.githubCredentialId ?? null}
              legacyAvailable={envVars.some(
                (v) => v.key === "GITHUB_TOKEN" && !v.repositoryId,
              )}
              onChange={(githubCredentialId) =>
                setConfig({ ...config, githubCredentialId })
              }
            />
            {config.brain === "claude" && (
              <CredentialPicker
                providers={["claude"]}
                label="Claude Code token"
                credentials={claudeCredentials}
                value={config.claudeCredentialId ?? null}
                legacyAvailable={
                  readiness.hasClaudeCodeToken ||
                  projectEnvKeys.has("CLAUDE_CODE_OAUTH_TOKEN")
                }
                onChange={(claudeCredentialId) =>
                  setConfig({ ...config, claudeCredentialId })
                }
              />
            )}
          </div>

          {config.brain === "opencode" && (
            <div className="grid gap-1.5">
              <Label>LLM API keys</Label>
              {llmCredentials.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No LLM API keys saved yet — add them in Settings → AI
                  Providers → LLM API Keys. Global Settings keys still apply
                  as a fallback.
                </p>
              ) : (
                <div className="grid gap-1">
                  {llmCredentials.map((cred) => {
                    const selected = (
                      config.llmCredentialIds ?? []
                    ).includes(cred.id);
                    return (
                      <label
                        key={cred.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs hover:bg-muted/40"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={selected}
                          onChange={(e) => {
                            const current = new Set(
                              config.llmCredentialIds ?? [],
                            );
                            if (e.target.checked) current.add(cred.id);
                            else current.delete(cred.id);
                            setConfig({
                              ...config,
                              llmCredentialIds: [...current],
                            });
                          }}
                        />
                        <span className="font-medium">{cred.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {providerLabel(cred.provider)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                Selected keys are injected as env vars (OPENAI_API_KEY,
                OPENROUTER_API_KEY, …) — OpenCode picks them up natively.
                Select several to switch models without relaunching.
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>
              {config.brain === "opencode" ? "OpenCode model" : "Claude model"}
            </Label>
            {config.brain === "opencode" ? (
              <OpenCodeModelPicker
                value={config.openCodeModel ?? null}
                onChange={(openCodeModel) =>
                  setConfig({ ...config, openCodeModel })
                }
              />
            ) : (
              <Select
                value={config.claudeModel ?? "default"}
                onValueChange={(v) =>
                  setConfig({
                    ...config,
                    claudeModel: !v || v === "default" ? null : v,
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      CLAUDE_MODELS.find(
                        (m) => m.value === (value ?? "default"),
                      )?.label ?? String(value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CLAUDE_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      <span className="flex w-full items-baseline gap-2">
                        {m.label}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {m.hint}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-[10px] text-muted-foreground">
              Every agent run on this project&apos;s sandboxes (tasks, follow-ups
              and the dev console) uses this model.
            </p>
          </div>

          <Separator />

          <div className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Delivery policy
            </h4>
            <p className="text-[11px] text-muted-foreground">
              What each task must produce and verify before it finishes.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <ToolToggle
              label="Open a pull request with the result"
              checked={config.createPr}
              onChange={(v) => setConfig({ ...config, createPr: v })}
            />
            <ToolToggle
              label="Run tests & fix failures"
              checked={config.runTests}
              onChange={(v) => setConfig({ ...config, runTests: v })}
            />
            <ToolToggle
              label="Screenshot the running app (agent-browser)"
              checked={config.captureScreenshots}
              onChange={(v) => setConfig({ ...config, captureScreenshots: v })}
            />
            <ToolToggle
              label="Live preview URL (Cloudflare tunnel)"
              checked={config.livePreview}
              onChange={(v) => setConfig({ ...config, livePreview: v })}
            />
          </div>

          {config.livePreview && (
            <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  After each task the app runs on the sandbox behind a public{" "}
                  <code>trycloudflare.com</code> URL, added to the PR. The URL
                  is unguessable but <strong>public</strong> — anyone with the
                  link reaches the app. It dies with the sandbox.
                </span>
              </p>
              <div className="flex items-center gap-2">
                <Label htmlFor="preview-port" className="text-xs">
                  App port
                </Label>
                <Input
                  id="preview-port"
                  type="number"
                  min={1}
                  max={65535}
                  // Empty = inherit whatever the Stack canvas says.
                  value={config.previewPort ?? ""}
                  placeholder={
                    inherited?.previewPort ? String(inherited.previewPort) : "3000"
                  }
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      previewPort: e.target.value
                        ? Number(e.target.value) || null
                        : null,
                    })
                  }
                  className="w-24 font-mono text-xs"
                />
                <span className="text-[10px] text-muted-foreground">
                  {config.previewPort === null && inherited?.previewPort
                    ? `inherited from the Stack canvas (${inherited.appName ?? "app node"})`
                    : "the port your run command listens on — leave empty to use the Stack"}
                </span>
              </div>
            </div>
          )}

          <Separator />

          <div className="grid gap-1.5">
            <Label htmlFor="agent-instructions">
              Standing instructions (optional)
            </Label>
            <Textarea
              id="agent-instructions"
              value={config.agentInstructions ?? ""}
              onChange={(e) =>
                setConfig({ ...config, agentInstructions: e.target.value })
              }
              placeholder={
                "e.g. Always update the OpenAPI spec when routes change.\nNever touch the migrations folder."
              }
              rows={3}
              className="text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-timeout">Task timeout (minutes)</Label>
            <Input
              id="task-timeout"
              type="number"
              min={5}
              max={600}
              value={config.taskTimeoutMinutes ?? ""}
              onChange={(e) =>
                setConfig({
                  ...config,
                  taskTimeoutMinutes: e.target.value
                    ? Math.max(5, Math.min(600, Number(e.target.value)))
                    : null,
                })
              }
              placeholder="45"
              className="w-28 font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              How long one agent run may take before it is killed. Empty = 45.
              Raise it for long jobs (library upgrades, e2e suites) — a killed
              run now says this is the knob.
            </p>
          </div>
          <Separator />

          <div className="grid gap-1.5">
            <Label htmlFor="telegram-chat">Telegram chat ID (optional)</Label>
            <Input
              id="telegram-chat"
              value={config.telegramChatId ?? ""}
              onChange={(e) =>
                setConfig({ ...config, telegramChatId: e.target.value })
              }
              placeholder="-100123456789"
              className="font-mono text-xs"
              autoComplete="off"
              {...NO_AUTOFILL}
            />
            <p className="text-[10px] text-muted-foreground">
              This project&apos;s notifications and remote control go to this
              chat. Empty = the global chat from Settings.
            </p>
            <TelegramGroupLink
              projectId={projectId}
              currentChatId={config.telegramChatId ?? ""}
              onLinked={(chatId) =>
                setConfig((c) => ({ ...c, telegramChatId: chatId }))
              }
            />
          </div>

          <SlackChannelPicker
            value={config.slackChannelId ?? ""}
            onChange={(ref) => setConfig({ ...config, slackChannelId: ref })}
          />
        </section>
      )}

      {/* Step 6 — review & launch */}
      {step === "launch" && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Review &amp; launch</h3>
            <p className="text-xs text-muted-foreground">
              Everything is saved with the project — launch now or just save.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Name</Label>
            <Input
              className="h-9 text-sm font-mono"
              value={sandboxName}
              maxLength={MAX_CUSTOM_SANDBOX_NAME}
              placeholder="auto — named after the project"
              onChange={(e) => setSandboxName(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              {namePreview
                ? `Will be created as ${namePreview} — the full machine name, no prefix added.`
                : "Leave empty to name it after the project."}
            </p>
          </div>
          {/* Only the auto-named form carries a prefix, so this is noise beside
              a name the user typed — that one *is* the whole hostname. */}
          {!namePreview && (
            <SandboxPrefixField
              projectId={projectId}
              disabled={busy}
              note={
                <p className="text-xs text-muted-foreground">
                  Saved for the whole workspace, not just this project — the same
                  field as Settings → Cloud → Sandbox naming.
                </p>
              }
            />
          )}
          <div className="divide-y divide-border/40 rounded-md border border-border/50">
            <SummaryRow
              label="Runs on"
              value={
                isLocal
                  ? "Local Docker container — free"
                  : `${providerLabel(config.provider)} · ${config.region} · ${config.size}${sizeInfo ? ` (~$${sizeInfo.hourly.toFixed(3)}/h)` : ""}`
              }
              onEdit={() => setStepKey(isLocal ? "type" : "machine")}
            />
            <SummaryRow
              label="Code"
              value={`${clonedRepos.length} repo${clonedRepos.length === 1 ? "" : "s"} · branch ${config.branch?.trim() || "default"} · ${envVars.length} env var${envVars.length === 1 ? "" : "s"}`}
              onEdit={() => setStepKey("code")}
            />
            <SummaryRow
              label="Tooling"
              value={enabledTools.join(", ") || "nothing installed"}
              onEdit={() => setStepKey("tooling")}
            />
            <SummaryRow
              label="Stack services"
              value={
                config.includeStackServices && dockerStackServices.length > 0
                  ? dockerStackServices.map((s) => s.name).join(", ")
                  : "none"
              }
              onEdit={() => setStepKey("tooling")}
            />
            <SummaryRow
              label="Brain"
              value={
                config.brain === "opencode"
                  ? `OpenCode · ${
                      OPENCODE_MODELS.find(
                        (m) => m.value === (config.openCodeModel ?? "default"),
                      )?.label ??
                      config.openCodeModel ??
                      "default model"
                    }`
                  : `Claude Code · ${
                      CLAUDE_MODELS.find(
                        (m) => m.value === (config.claudeModel ?? "default"),
                      )?.label ?? config.claudeModel!
                    }`
              }
              onEdit={() => setStepKey("agent")}
            />
            <SummaryRow
              label="Agent"
              value={
                [
                  config.createPr && "opens PRs",
                  config.runTests && "runs tests",
                  config.captureScreenshots && "screenshots",
                  config.livePreview && `preview :${config.previewPort}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "no delivery policy"
              }
              onEdit={() => setStepKey("agent")}
            />
            <SummaryRow
              label="Telegram"
              value={
                config.telegramChatId?.trim()
                  ? `project chat ${config.telegramChatId.trim()}`
                  : "global chat (Settings)"
              }
              onEdit={() => setStepKey("agent")}
            />
          </div>
          {missingTokens.length > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Launching needs {missingTokens.join(" and ")}.
            </p>
          )}
          {!isLocal && !readiness.terraformInstalled && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Terraform is not installed — cloud sandboxes can&apos;t launch.
            </p>
          )}
          {!isLocal && readiness.terraformInstalled && !providerReady && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              No {providerLabel(config.provider)} credential — add one in the
              Type step or in Settings.
            </p>
          )}
          {config.includeStackServices &&
            dockerStackServices.length > 0 &&
            !config.installDocker && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Stack services need the Docker toggle in Tooling.
              </p>
            )}
        </section>
      )}

      </div>

      {/* Wizard footer — fixed at the drawer's bottom edge */}
      <div className="border-t border-border/40 bg-popover px-4 py-3">
        <div className="flex items-center gap-2">
          {stepIndex > 0 && (
            <Button variant="ghost" onClick={goBack} disabled={busy}>
              Back
            </Button>
          )}
          {step !== "launch" ? (
            <Button onClick={goNext}>Next</Button>
          ) : (
            <Button
              // The destination decides where it launches, not config.provider
              // — a local sandbox keeps the user's cloud provider on its saved
              // config, and launching that would ignore the Type step.
              onClick={() => launchMutation.mutate(destination)}
              disabled={busy || !canLaunch}
              className="gap-1.5"
              title={
                missingTokens.length > 0
                  ? `Set ${missingTokens.join(" and ")} first`
                  : undefined
              }
            >
              {launchMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {launchOverride?.label ??
                (isLocal ? "Launch local sandbox" : "Launch sandbox")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => saveMutation.mutate()}
            disabled={busy}
            className="ml-auto gap-1.5"
            title="Save the configuration without launching"
          >
            {saveMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Save
          </Button>
          {saveMutation.isSuccess && !launchMutation.isPending && (
            <span className="text-xs text-emerald-400">Saved.</span>
          )}
        </div>
        {(saveMutation.isError || launchMutation.isError) && (
          <p className="mt-2 text-xs text-destructive">
            {((launchMutation.error ?? saveMutation.error) as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One-click Telegram group linking. Bots can't create groups themselves, but
 * the t.me/<bot>?startgroup=<projectId> deep link opens Telegram's "add to
 * group" picker — where a NEW group can be created on the spot. Joining posts
 * "/start <projectId>" to the group; the poller catches it and saves the chat
 * id on this project's SandboxConfig. Here we poll the setup until that
 * happens and fill the input automatically.
 */
/**
 * Slack channel by NAME, never by raw ID: a select over the channels the bot
 * can see, plus inline creation. The stored value is still the channel id —
 * ids survive renames — but the user only ever touches names. Falls back to
 * a hint when Slack isn't configured yet.
 */
function SlackChannelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (ref: string) => void;
}) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const channels = useQuery({
    queryKey: ["slack-channels"],
    queryFn: getSlackChannels,
    staleTime: 60_000,
  });

  const create = useMutation({
    mutationFn: (name: string) => createSlackChannelOption(name),
    onSuccess: (channel) => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["slack-channels"] });
      onChange(channel.id);
    },
  });

  const list = channels.data ?? [];
  const current = list.find((c) => c.id === value || c.name === value.replace(/^#/, ""));

  if (!channels.isLoading && list.length === 0) {
    return (
      <div className="grid gap-1.5">
        <Label>Slack channel (optional)</Label>
        <p className="text-[10px] text-muted-foreground">
          Configure the Slack bot token in Settings → Communications to pick a
          channel here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label>Slack channel (optional)</Label>
      <Select value={current?.id ?? value} onValueChange={(v) => onChange((v as string) ?? "")}>
        <SelectTrigger className="w-full">
          <SelectValue>
            {(v) => {
              const hit = list.find((c) => c.id === v);
              return hit
                ? `#${hit.name}`
                : v
                  ? String(v)
                  : "Global channel (from Settings)";
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Global channel (from Settings)</SelectItem>
          {list.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              #{c.name}
              {!c.isMember ? " · invite the bot" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">
        This project&apos;s notifications go to this channel; replies in their
        threads drive follow-ups. The bot must be a member.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) {
              e.preventDefault();
              create.mutate(newName);
            }
          }}
          placeholder="new-channel-name"
          className="h-7 flex-1 font-mono text-xs"
          autoComplete="off"
          {...NO_AUTOFILL}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate(newName)}
        >
          {create.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Create channel
        </Button>
      </div>
      {create.isError && (
        <p className="text-[10px] text-destructive">
          {(create.error as Error).message}
        </p>
      )}
    </div>
  );
}

function TelegramGroupLink({
  projectId,
  currentChatId,
  onLinked,
}: {
  projectId: string;
  currentChatId: string;
  onLinked: (chatId: string) => void;
}) {
  const [status, setStatus] = useState<
    "idle" | "no-bot" | "waiting" | "linked"
  >("idle");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadline = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const begin = async () => {
    const bot = await getTelegramBot();
    if (!bot.username) {
      setStatus("no-bot");
      return;
    }
    window.open(
      `https://t.me/${bot.username}?startgroup=${projectId}`,
      "_blank",
      "noopener",
    );
    setStatus("waiting");
    deadline.current = Date.now() + 3 * 60_000;
    const baseline = currentChatId.trim();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      if (Date.now() > deadline.current) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        setStatus("idle");
        return;
      }
      const setup = await getProjectSetup(projectId).catch(() => null);
      const chat = setup?.config.telegramChatId?.trim() ?? "";
      if (chat && chat !== baseline) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        onLinked(chat);
        setStatus("linked");
      }
    }, 4000);
  };

  return (
    <div className="space-y-1 pt-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={begin}
        disabled={status === "waiting"}
        className="gap-1.5"
      >
        {status === "waiting" && (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        {status === "waiting"
          ? "Waiting for the group…"
          : "Create or link a Telegram group"}
      </Button>
      {status === "no-bot" && (
        <p className="text-[10px] text-amber-300/90">
          No bot token configured — add it in Settings first, then retry.
        </p>
      )}
      {status === "waiting" && (
        <p className="text-[10px] text-muted-foreground">
          Telegram opened — pick a group or create a new one right there. It
          links to this project automatically.
        </p>
      )}
      {status === "linked" && (
        <p className="text-[10px] text-emerald-400">
          Group linked — the chat id above was filled in and saved.
        </p>
      )}
    </div>
  );
}

/** One line of the Review step: label, value, and a jump-to-step edit link. */
function SummaryRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Edit
      </button>
    </div>
  );
}

function ToolToggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** For a tool that only means something alongside another one. */
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <span className="text-xs">{label}</span>
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}

function ReadinessBanner({
  readiness,
  onCredentialsSaved,
}: {
  readiness: SandboxReadiness;
  onCredentialsSaved: () => void;
}) {
  const { terraformInstalled, dockerInstalled, hasCivoToken, hasAwsCredentials } =
    readiness;

  // Hidden once terraform is present and at least one provider is usable;
  // per-provider gaps are surfaced in the setup drawer next to the selector.
  if (terraformInstalled && (hasCivoToken || hasAwsCredentials)) return null;
  // Docker on its own is a complete path — a local sandbox needs no cloud
  // account, so a banner demanding one is telling the user to fix nothing.
  if (dockerInstalled) return null;

  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 space-y-3">
      {!terraformInstalled && (
        <p className="text-xs text-amber-300/90 flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>
            <code>terraform</code> CLI not found on PATH. Install it from{" "}
            <a
              href="https://developer.hashicorp.com/terraform/install"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              developer.hashicorp.com
            </a>{" "}
            and restart Nexus.
          </span>
        </p>
      )}
      {!hasCivoToken && !hasAwsCredentials && (
        <BannerCredentialCreator onSaved={onCredentialsSaved} />
      )}
    </div>
  );
}

// Zero-credential state: pick a provider and save the first credential
// without leaving the sandboxes view.
function BannerCredentialCreator({ onSaved }: { onSaved: () => void }) {
  const [provider, setProvider] = useState<SandboxProvider>("civo");

  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-300/90 flex items-center gap-1.5">
        <KeyRound className="h-3.5 w-3.5 shrink-0" />
        No cloud credentials saved. Add one to launch sandboxes.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <Select
          value={provider}
          onValueChange={(v) => v && setProvider(v as SandboxProvider)}
        >
          <SelectTrigger className="w-32">
            <SelectValue>
              {(value) => providerLabel(value as SandboxProvider)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1 min-w-64">
          <NewCredentialForm provider={provider} onSaved={() => onSaved()} />
        </div>
      </div>
    </div>
  );
}

// Credential dropdown over one or more providers, with inline create and
// delete. Multi-provider pickers (git tokens) get a provider select in the
// creation form.
// Curated OpenCode models + free text: `opencode -m` takes any models.dev
// "provider/model" id, so unknown saved values render in the custom input.
function OpenCodeModelPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  const isCurated =
    value === null || OPENCODE_MODELS.some((m) => m.value === value);
  const [custom, setCustom] = useState(!isCurated);
  const selectValue = custom ? "custom" : (value ?? "default");

  return (
    <div className="grid gap-1.5">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (!v) return;
          if (v === "custom") {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v === "default" ? null : v);
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue>
            {(v) =>
              OPENCODE_MODELS.find((m) => m.value === v)?.label ?? String(v)
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {OPENCODE_MODELS.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              <span className="flex w-full items-baseline gap-2">
                {m.label}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {m.hint}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {custom && (
        <Input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || null)}
          placeholder="provider/model (e.g. openrouter/anthropic/claude-sonnet-4-5)"
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}

function CredentialPicker({
  providers,
  label = "Credential",
  credentials,
  value,
  legacyAvailable,
  onChange,
}: {
  providers: CredentialProvider[];
  label?: string;
  credentials: CloudCredentialSummary[];
  value: string | null;
  /** A token already exists outside saved credentials (Settings/env var). */
  legacyAvailable: boolean;
  onChange: (credentialId: string | null) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<CredentialProvider>(
    providers[0],
  );
  // Keeps the Settings credential lists in sync with drawer-side changes.
  const invalidate = () => invalidateCredentialQueries(qc);

  const deleteMutation = useMutation({
    mutationFn: (credentialId: string) => deleteCredential(credentialId),
    onSuccess: (_res, credentialId) => {
      invalidate();
      if (value === credentialId) {
        onChange(credentials.find((c) => c.id !== credentialId)?.id ?? null);
      }
    },
  });

  const showForm = adding || credentials.length === 0;
  // Single-provider pickers (compute) follow their prop; the state only
  // matters for multi-provider ones.
  const formProvider = providers.length === 1 ? providers[0] : newProvider;
  const groupLabel =
    providers.length === 1 ? providerLabel(providers[0]) : "git";

  return (
    <div className="grid gap-1.5 min-w-0 content-start">
      <Label>{label}</Label>
      {credentials.length > 0 ? (
        <div className="flex items-center gap-1">
          <Select value={value ?? ""} onValueChange={(v) => v && onChange(v)}>
            <SelectTrigger className="w-full min-w-0">
              <SelectValue>
                {(v) => (
                  <span className="truncate">
                    {credentials.find((c) => c.id === v)?.name ?? "Select…"}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {credentials.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {providers.length > 1
                    ? ` · ${providerLabel(c.provider)}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="ghost"
            title={`New ${groupLabel} credential`}
            onClick={() => setAdding((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {value && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Delete selected credential"
              onClick={() => deleteMutation.mutate(value)}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-amber-500">
          {legacyAvailable
            ? `No saved ${groupLabel} credentials — an existing token (env var / Settings) will be used.`
            : `No saved ${groupLabel} credentials — add one to launch.`}
        </p>
      )}
      {deleteMutation.isError && (
        <p className="text-xs text-destructive">
          {(deleteMutation.error as Error).message}
        </p>
      )}
      {showForm && (
        <>
          {providers.length > 1 && (
            <Select
              value={formProvider}
              onValueChange={(v) =>
                v && setNewProvider(v as CredentialProvider)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v) => providerLabel(v as CredentialProvider)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>
                    {providerLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <NewCredentialForm
            provider={formProvider}
            onSaved={(created) => {
              setAdding(false);
              invalidate();
              onChange(created.id);
            }}
          />
        </>
      )}
    </div>
  );
}

// NewCredentialForm lives in @/components/settings/cloud-credentials and is
// shared with the Settings page.

/** Display order for config presets — the keys people reach for first. */
const PRESET_GROUPS = [
  { group: "claude" as const, label: "Claude Code" },
  { group: "llm" as const, label: "LLM providers" },
  { group: "settings" as const, label: "Global settings" },
  { group: "git" as const, label: "Git hosting" },
];

/**
 * Bulk entry for env vars: paste a `.env` block, or copy the vars off a node
 * on the Stack canvas. Both preview what will change before anything is
 * written — an import that silently overwrites a working secret is worse than
 * no import at all. Single vars, including ones backed by a saved credential,
 * are added from the form below instead.
 */
function EnvImportPanel({
  projectId,
  repositories,
  stackSources,
  existingKeys,
  onImported,
}: {
  projectId: string;
  repositories: Array<{ id: string; name: string }>;
  stackSources: StackEnvSource[];
  existingKeys: Array<{ key: string; repositoryId: string | null }>;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<string>("project");
  const [overwrite, setOverwrite] = useState(true);
  const [result, setResult] = useState<EnvImportResult | null>(null);

  const repositoryId = scope === "project" ? null : scope;

  // Parsed client-side purely for the preview; the server re-parses the raw
  // text so the two can't disagree about what actually gets written.
  const preview = useMemo(
    () => (text.trim() ? parseDotenvWithDiagnostics(text) : null),
    [text],
  );

  const definedAtScope = useMemo(
    () =>
      new Set(
        existingKeys
          .filter((v) => (v.repositoryId ?? null) === repositoryId)
          .map((v) => v.key),
      ),
    [existingKeys, repositoryId],
  );

  const importMutation = useMutation({
    mutationFn: () =>
      importEnvVars(projectId, { content: text, repositoryId, overwrite }),
    onSuccess: (res) => {
      setResult(res);
      setText("");
      onImported();
    },
  });

  const stackMutation = useMutation({
    mutationFn: (nodeId: string) =>
      importEnvVarsFromStack(projectId, { nodeId, repositoryId, overwrite }),
    onSuccess: (res) => {
      setResult(res);
      onImported();
    },
  });


  const newCount =
    preview?.entries.filter((e) => !definedAtScope.has(e.key)).length ?? 0;
  const overwriteCount =
    preview?.entries.filter((e) => definedAtScope.has(e.key)).length ?? 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Import from .env or stack…
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Import env vars</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setResult(null);
          }}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          close
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Import into</span>
        <Select value={scope} onValueChange={(v) => setScope(v ?? "project")}>
          <SelectTrigger className="h-7 w-32">
            <SelectValue>
              {(value) =>
                value === "project"
                  ? "project-wide"
                  : (repositories.find((r) => r.id === value)?.name ??
                    "project-wide")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">project-wide</SelectItem>
            {repositories.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="h-3 w-3 accent-primary"
          />
          Overwrite keys that already exist
        </label>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        rows={5}
        spellCheck={false}
        placeholder={"DATABASE_URL=postgres://…\n# comments are ignored\nexport API_KEY=\"abc\""}
        className="w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary/60"
      />

      {preview && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground">
            {preview.entries.length} key
            {preview.entries.length === 1 ? "" : "s"}
            {newCount > 0 && ` · ${newCount} new`}
            {overwriteCount > 0 &&
              ` · ${overwriteCount} ${overwrite ? "overwritten" : "skipped"}`}
          </p>
          {preview.entries.length > 0 && (
            <div className="max-h-32 space-y-0.5 overflow-y-auto">
              {preview.entries.map((e) => {
                const exists = definedAtScope.has(e.key);
                return (
                  <div
                    key={e.key}
                    className="flex items-center gap-2 text-[10px]"
                  >
                    <code className="font-mono">{e.key}</code>
                    <span className="flex-1 truncate font-mono text-muted-foreground">
                      {e.value.length > 4
                        ? "••••" + e.value.slice(-4)
                        : "••••"}
                    </span>
                    <span
                      className={
                        exists
                          ? overwrite
                            ? "text-amber-300"
                            : "text-muted-foreground"
                          : "text-emerald-400"
                      }
                    >
                      {exists ? (overwrite ? "overwrite" : "skip") : "new"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {preview.invalidLines.length > 0 && (
            <p className="text-[10px] text-amber-300">
              Ignoring {preview.invalidLines.length} unparseable line
              {preview.invalidLines.length === 1 ? "" : "s"} (
              {preview.invalidLines
                .slice(0, 3)
                .map((l) => `line ${l.line}`)
                .join(", ")}
              {preview.invalidLines.length > 3 ? "…" : ""})
            </p>
          )}
        </div>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={() => importMutation.mutate()}
        disabled={
          importMutation.isPending || !preview || preview.entries.length === 0
        }
      >
        {importMutation.isPending
          ? "Importing…"
          : `Import ${preview?.entries.length ?? 0} var${
              preview?.entries.length === 1 ? "" : "s"
            }`}
      </Button>

      {stackSources.length > 0 && (
        <div className="space-y-1.5 border-t border-border/50 pt-3">
          <p className="text-[10px] text-muted-foreground">
            Or copy from the Stack canvas — values are copied, so editing them
            here won&apos;t change the stack:
          </p>
          {stackSources.map((src) => (
            <div
              key={src.nodeId}
              className="flex items-center gap-2 rounded border border-border/50 bg-muted/20 px-2 py-1"
            >
              <code className="text-[11px] font-medium">{src.name}</code>
              <Badge variant="outline" className="text-[9px]">
                {src.kind}
              </Badge>
              <span className="flex-1 truncate text-[10px] text-muted-foreground">
                {src.vars.map((v) => v.key).join(", ")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px]"
                onClick={() => stackMutation.mutate(src.nodeId)}
                disabled={stackMutation.isPending}
              >
                Import {src.vars.length}
              </Button>
            </div>
          ))}
        </div>
      )}

      {result && (
        <p className="text-[10px] text-emerald-400">
          {result.created.length} added, {result.updated.length} updated
          {result.skipped.length > 0 && `, ${result.skipped.length} skipped`}.
        </p>
      )}
      {(importMutation.isError || stackMutation.isError) && (
        <p className="text-[10px] text-destructive">
          {((importMutation.error ?? stackMutation.error) as Error).message}
        </p>
      )}
    </div>
  );
}

/** One row of the env list — masked by default, revealed on demand. */
function EnvVarRow({
  projectId,
  envVar,
  version,
  scopeLabel,
  editing,
  onEdit,
  onCancelEdit,
  editKey,
  setEditKey,
  editValue,
  setEditValue,
  onSaveEdit,
  savePending,
  onDelete,
  deletePending,
}: {
  projectId: string;
  envVar: { id: string; key: string; valueMasked: string };
  /** Bumped by the parent on every write, to retire a revealed value. */
  version: number;
  scopeLabel: string;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  editKey: string;
  setEditKey: (v: string) => void;
  editValue: string;
  setEditValue: (v: string) => void;
  onSaveEdit: () => void;
  savePending: boolean;
  onDelete: () => void;
  deletePending: boolean;
}) {
  // The plaintext never rides along with the panel load — it is fetched here,
  // per var, only when the user asks to see or copy it.
  const [revealed, setRevealed] = useState<string | null>(null);
  // An edit or a bulk import can change this var while it is revealed. The
  // mask alone can't detect that (an overwrite of the same length looks
  // identical), so the parent bumps `version` on every write and the cached
  // plaintext is retired rather than left stale on screen.
  const [seenVersion, setSeenVersion] = useState(version);
  if (seenVersion !== version) {
    setSeenVersion(version);
    setRevealed(null);
  }
  const [busy, setBusy] = useState<null | "reveal" | "copy">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchValue = async (): Promise<string | null> => {
    if (revealed !== null) return revealed;
    try {
      const value = await revealEnvVar(projectId, envVar.id);
      setRevealed(value);
      return value;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const toggleReveal = async () => {
    setError(null);
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setBusy("reveal");
    await fetchValue();
    setBusy(null);
  };

  const copy = async () => {
    setError(null);
    setBusy("copy");
    const value = await fetchValue();
    setBusy(null);
    if (value === null) return;
    try {
      await copyText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard blocked — reveal the value and copy it manually.");
    }
  };

  // Mirrors the server's key rule. A blank value means "keep the stored one",
  // so an unchanged key with no new value has nothing to save.
  const trimmedKey = editKey.trim();
  const keyValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey);
  const canSaveEdit =
    keyValid && (trimmedKey !== envVar.key || editValue.length > 0);

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-1.5">
      <div className="flex items-center gap-2">
        {!editing && (
          <code className="text-xs font-medium">{envVar.key}</code>
        )}
        <Badge variant="outline" className="text-[10px]">
          {scopeLabel}
        </Badge>
        {editing ? (
          <form
            className="flex flex-1 gap-2"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSaveEdit) onSaveEdit();
            }}
          >
            <Input
              value={editKey}
              onChange={(e) => setEditKey(e.target.value)}
              placeholder="KEY"
              className="h-7 w-36 font-mono text-xs"
              autoComplete="off"
              {...NO_AUTOFILL}
              autoFocus
            />
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              // Empty means "keep the stored secret" — the point of a rename
              // that does not force revealing the value first.
              placeholder="New value (leave blank to keep)"
              type="password"
              className="h-7 flex-1 font-mono text-xs"
              autoComplete="new-password"
              {...NO_AUTOFILL}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-7"
              disabled={savePending || !canSaveEdit}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={onCancelEdit}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
              {revealed ?? envVar.valueMasked}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={toggleReveal}
              disabled={busy !== null}
              title={revealed !== null ? "Hide value" : "Show value"}
              aria-label={revealed !== null ? "Hide value" : "Show value"}
            >
              {revealed !== null ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={copy}
              disabled={busy !== null}
              title="Copy value"
              aria-label="Copy value"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={onEdit}
            >
              edit
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onDelete}
              disabled={deletePending}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </>
        )}
      </div>
      {error && <p className="mt-1 text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

function EnvVarsEditor({
  projectId,
  envVars,
  repositories,
  suggestions = [],
  stackSources = [],
}: {
  projectId: string;
  envVars: Array<{
    id: string;
    key: string;
    repositoryId: string | null;
    valueMasked: string;
  }>;
  repositories: Array<{ id: string; name: string }>;
  /** Missing .env.example keys from Auto-detect — one click prefills the form. */
  suggestions?: Array<{ key: string; repositoryId: string; repoName: string }>;
  /** Stack canvas nodes carrying env vars, offered as an import source. */
  stackSources?: StackEnvSource[];
}) {
  const qc = useQueryClient();
  // Every write bumps this so any row showing a revealed value drops it —
  // the plaintext on screen would otherwise outlive the value it came from.
  const [writeVersion, setWriteVersion] = useState(0);
  const invalidate = () => {
    setWriteVersion((v) => v + 1);
    qc.invalidateQueries({ queryKey: ["project-setup", projectId] });
  };

  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<string>("project");
  /** "" = type a value by hand; otherwise the preset id supplying it. */
  const [sourceId, setSourceId] = useState("");

  const presets = useQuery({
    queryKey: ["env-presets", projectId],
    queryFn: () => fetchEnvPresets(projectId),
  });
  const selectedPreset = presets.data?.find((p) => p.id === sourceId) ?? null;

  const resetForm = () => {
    setKey("");
    setValue("");
    setSourceId("");
  };

  // One "Add" over two sources. A hand-typed value posts the plaintext; a
  // preset posts only its id, so the secret is resolved server-side and never
  // has to pass through the browser to be stored.
  const addMutation = useMutation({
    mutationFn: async () => {
      const repositoryId = scope === "project" ? null : scope;
      if (selectedPreset) {
        await importEnvVarsFromConfig(projectId, {
          presetIds: [selectedPreset.id],
          repositoryId,
          overwrite: true,
        });
        return;
      }
      await addEnvVar(projectId, { key: key.trim(), value, repositoryId });
    },
    onSuccess: () => {
      resetForm();
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (envVarId: string) => deleteEnvVar(projectId, envVarId),
    onSuccess: invalidate,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const editMutation = useMutation({
    // A blank value is omitted rather than sent: the server keeps the stored
    // secret, so renaming never requires reading it back.
    mutationFn: () =>
      updateEnvVar(projectId, editingId!, {
        key: editKey.trim(),
        ...(editValue ? { value: editValue } : {}),
      }),
    onSuccess: () => {
      setEditingId(null);
      setEditKey("");
      setEditValue("");
      invalidate();
    },
  });

  const repoName = (id: string | null) =>
    id ? (repositories.find((r) => r.id === id)?.name ?? "repo") : null;

  // A preset carries its own value, so only the hand-typed path needs one.
  const canAdd = selectedPreset !== null || Boolean(key.trim() && value);
  const alreadyDefined =
    selectedPreset !== null &&
    envVars.some(
      (v) =>
        v.key === selectedPreset.key &&
        (v.repositoryId ?? "project") === scope,
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Project-wide vars are exported for every shell on the sandbox.
        Repo-scoped vars are written to that repo&apos;s <code>.env</code> after
        clone. Add a project-wide <code>GITHUB_TOKEN</code> /{" "}
        <code>GITLAB_TOKEN</code> / <code>BITBUCKET_TOKEN</code> to clone
        private repos from that host.
      </p>

      {envVars.length > 0 && (
        <div className="space-y-1.5">
          {envVars.map((v) => (
            <EnvVarRow
              key={v.id}
              projectId={projectId}
              envVar={v}
              version={writeVersion}
              scopeLabel={repoName(v.repositoryId) ?? "project"}
              editing={editingId === v.id}
              onEdit={() => {
                setEditingId(v.id);
                setEditKey(v.key);
                setEditValue("");
              }}
              onCancelEdit={() => setEditingId(null)}
              editKey={editKey}
              setEditKey={setEditKey}
              editValue={editValue}
              setEditValue={setEditValue}
              onSaveEdit={() => editMutation.mutate()}
              savePending={editMutation.isPending}
              onDelete={() => deleteMutation.mutate(v.id)}
              deletePending={deleteMutation.isPending}
            />
          ))}
        </div>
      )}

      <EnvImportPanel
        projectId={projectId}
        repositories={repositories}
        stackSources={stackSources}
        existingKeys={envVars}
        onImported={invalidate}
      />

      {(() => {
        const defined = new Set(envVars.map((v) => v.key));
        const missing = suggestions.filter((sug) => !defined.has(sug.key));
        if (missing.length === 0) return null;
        return (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">
              Detected in <code>.env.example</code> and not defined yet — click
              to prefill:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {missing.map((sug) => (
                <button
                  key={sug.key}
                  type="button"
                  onClick={() => {
                    setKey(sug.key);
                    setScope(sug.repositoryId);
                  }}
                  className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] text-amber-300 transition-colors hover:bg-amber-400/20"
                  title={`Expected by ${sug.repoName} — click to fill the form below`}
                >
                  {sug.key}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
      <form
        className="flex flex-wrap gap-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd) addMutation.mutate();
        }}
      >
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY"
          className="w-36 font-mono text-xs"
          autoComplete="off"
          disabled={selectedPreset !== null}
          {...NO_AUTOFILL}
        />
        {selectedPreset ? (
          // The value belongs to the credential, not the form — showing it
          // masked and read-only keeps the plaintext server-side.
          <div className="flex min-w-36 flex-1 items-center rounded-md border border-border/60 bg-muted/20 px-2 font-mono text-xs text-muted-foreground">
            {selectedPreset.valueMasked}
          </div>
        ) : (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            type="password"
            className="flex-1 min-w-36 font-mono text-xs"
            autoComplete="new-password"
            {...NO_AUTOFILL}
          />
        )}
        {(presets.data?.length ?? 0) > 0 && (
          <Select
            value={sourceId}
            onValueChange={(v) => {
              const id = v ?? "";
              setSourceId(id);
              // Picking a config decides the key too — a saved GITHUB_TOKEN
              // cannot be stored under some other name.
              const preset = presets.data?.find((p) => p.id === id);
              if (preset) setKey(preset.key);
              else setKey("");
              setValue("");
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue>
                {(value) =>
                  presets.data?.find((p) => p.id === value)?.label ??
                  "custom value"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">custom value</SelectItem>
              {PRESET_GROUPS.map(({ group, label }) => {
                const rows = presets.data?.filter((p) => p.group === group) ?? [];
                if (rows.length === 0) return null;
                return (
                  <SelectGroup key={group}>
                    <SelectLabel>{label}</SelectLabel>
                    {rows.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label} — {preset.key}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        )}
        <Select value={scope} onValueChange={(v) => setScope(v ?? "project")}>
          <SelectTrigger className="w-32">
            {/* Base UI renders the raw value (a repo id) unless given children. */}
            <SelectValue>
              {(value) =>
                value === "project"
                  ? "project-wide"
                  : (repositories.find((r) => r.id === value)?.name ??
                    "project-wide")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">project-wide</SelectItem>
            {repositories.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={addMutation.isPending || !canAdd}
        >
          {selectedPreset && alreadyDefined ? "Replace" : "Add"}
        </Button>
      </form>
      {selectedPreset && (
        <p className="text-[10px] text-muted-foreground">
          {alreadyDefined
            ? `Replaces the current ${selectedPreset.key} for this scope. `
            : ""}
          Copied by value: rotating <code>{selectedPreset.label}</code> later
          won&apos;t update the project, and this copy takes precedence over the
          global var at launch.
        </p>
      )}
      {(addMutation.isError || editMutation.isError) && (
        <p className="text-xs text-destructive">
          {((addMutation.error ?? editMutation.error) as Error).message}
        </p>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: "border-border bg-muted/30 text-muted-foreground",
  provisioning: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  running: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  paused: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  destroying: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  destroyed: "border-border bg-muted/30 text-muted-foreground",
  error: "border-red-500/20 bg-red-500/10 text-red-300",
};

function SandboxRow({
  projectId,
  sandbox,
  onDestroy,
  destroying,
  onOpenTerminal,
  terminalPath,
  focus,
  autoOpenDev,
}: {
  projectId: string;
  sandbox: SandboxSummary;
  onDestroy: () => void;
  destroying: boolean;
  onOpenTerminal?: (target: string, label: string) => void;
  terminalPath: string;
  /** Arrived here from ⌘J: scroll into view and mark it. */
  focus?: boolean;
  /** The entry was a dev prompt — open the console, not just the row. */
  autoOpenDev?: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const [nameCopied, setNameCopied] = useState(false);
  const [sshCopied, setSshCopied] = useState(false);
  // Held in the row rather than read back out of the bootstrap log: the log
  // keeps only a 400-line tail, and the tailscale section runs early enough
  // that a busy bootstrap pushes the link out of it.
  const [tsAuthUrl, setTsAuthUrl] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  // ⌘J landed on this row: bring it into view, and open the console when the
  // entry was a dev prompt. Runs once per arrival rather than on every render,
  // so closing the console does not immediately reopen it.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const arrived = useRef(false);
  useEffect(() => {
    if (!focus || arrived.current) return;
    arrived.current = true;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (autoOpenDev) setDevOpen(true);
  }, [focus, autoOpenDev]);
  const qc = useQueryClient();
  const { toast } = useToast();
  const active = ACTIVE_STATUSES.includes(sandbox.status);

  // Where the in-app terminal connects. Cloud instances get an SSH session;
  // local sandboxes have no public IP, so they attach to their container with
  // `docker exec` instead — same shell, same checkout.
  //
  // As the agent user, not root: /opt/nexus belongs to it, and anything built
  // from this session (node_modules, .next) would otherwise land root-owned and
  // break the dev servers and the agent, which both run as nexux. Passwordless
  // sudo is configured for the rare step that genuinely needs root.
  const terminalTarget =
    sandbox.provider === "local"
      ? sandbox.instanceId
        ? `docker://${sandbox.instanceId}${terminalPath}`
        : null
      : sandbox.publicIp
        ? `ssh://nexus@${sandbox.publicIp}${terminalPath}`
        : null;

  const dedicate = useMutation({
    mutationFn: (dedicated: boolean) =>
      updateSandbox(projectId, sandbox.id, { dedicated }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] }),
  });

  const power = useMutation({
    mutationFn: (action: "pause" | "resume") =>
      powerSandbox(projectId, sandbox.id, action),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] }),
    onError: (err) =>
      toast({
        title: "Power action failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const openVsCode = async () => {
    try {
      // No path on purpose: `terminalPath` is the main repo's checkout, derived
      // for the terminal's cwd rather than chosen by the user. Sending it here
      // would override the generated multi-root workspace and open that single
      // repo — on a multi-repo project the other folders silently vanish.
      const data = await getVsCodeLink(projectId, sandbox.id);
      if (!data.launched) window.location.href = data.uri;
      toast({
        title: "Opening VS Code",
        description: (
          <span className="flex flex-col gap-1">
            <span>
              {sandbox.provider === "local"
                ? "Attaching via the Dev Containers extension."
                : "Connecting over Remote-SSH."}
            </span>
            {/* The launch is fire-and-forget: nothing reports back whether a
                window actually appeared, so show the uri to fall back on. */}
            <span className="break-all font-mono text-[10px] opacity-70">
              {data.uri}
            </span>
            <span className="text-[10px] opacity-70">
              No window? Open this link manually, or run{" "}
              <code>code --folder-uri</code> with it.
            </span>
          </span>
        ),
      });
    } catch (err) {
      const log = err instanceof ApiError ? err.log : undefined;
      toast({
        title: "VS Code failed",
        description: (
          <span className="flex flex-col gap-1">
            <span>{err instanceof Error ? err.message : "Unknown error"}</span>
            {log && (
              <span className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10px] leading-tight">
                {log}
              </span>
            )}
          </span>
        ),
        variant: "destructive",
      });
    }
  };

  const copyName = async () => {
    try {
      await copyText(sandbox.name);
      setNameCopied(true);
      // Revert the tick so the button stays usable for a second copy.
      setTimeout(() => setNameCopied(false), 1500);
    } catch (err) {
      toast({
        title: "Could not copy the name",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  // The whole command, not the address: Nexus authenticates with its own key,
  // so a bare `ssh nexus@ip` from an outside terminal is refused for a key the
  // user was never told to pass.
  const copySshCommand = async () => {
    if (!sandbox.sshCommand) return;
    try {
      await copyText(sandbox.sshCommand);
      setSshCopied(true);
      setTimeout(() => setSshCopied(false), 1500);
    } catch (err) {
      toast({
        title: "Could not copy the command",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  // Local sandboxes work on bind-mounted host folders — Finder can open
  // those directly. Cloned-in-container repos have no host path; the server
  // says so and the toast relays it.
  const reveal = useMutation({
    mutationFn: () => revealSandboxFiles(projectId, sandbox.id),
    onSuccess: (opened) =>
      toast({
        title: `Opened ${opened.length} folder${opened.length !== 1 ? "s" : ""} in Finder`,
        description: opened.join(" · "),
      }),
    onError: (err: Error) =>
      toast({
        title: "Nothing to open",
        description: err.message,
        variant: "destructive",
      }),
  });

  // Safe to repeat: an already-registered node just reports its address.
  const tailscaleLogin = useMutation({
    mutationFn: () => refreshTailscaleLogin(projectId, sandbox.id),
    onSuccess: (res) => {
      setTsAuthUrl(res.authUrl);
      if (res.authUrl) {
        // Best effort: an async callback may have outlived the click's
        // activation window, so the popup blocker can eat this. The banner's
        // "Approve now" button below is the guaranteed path either way.
        window.open(res.authUrl, "_blank", "noopener,noreferrer");
        toast({
          title: "Approval page opened",
          description:
            "Log in with your identity provider — the node rejoins the tailnet in seconds.",
        });
      } else {
        // No URL means nothing is pending — say which, since "nothing
        // happened" and "already joined" look identical from the outside.
        toast({ title: res.message });
      }
    },
    onError: (err: Error) =>
      toast({
        title: "Could not refresh the Tailscale session",
        description: err.message,
        variant: "destructive",
      }),
  });

  // Minutes, not seconds: a cold install on a fresh box is the slow half.
  const retrySetup = useMutation({
    mutationFn: () => retrySandboxSetup(projectId, sandbox.id),
    onSuccess: (res) => {
      // The health strip is the thing that was red; it has to re-probe or the
      // user is left comparing a green toast against a stale badge.
      qc.invalidateQueries({ queryKey: ["sandbox-health", sandbox.id] });
      toast(
        res.ok
          ? { title: "Setup completed" }
          : {
              title: `Setup still failing for ${res.failed.join(", ")}`,
              description: "Open the bootstrap log for the reason.",
              variant: "destructive",
            },
      );
    },
    onError: (err: Error) =>
      toast({
        title: "Could not retry the setup",
        description: err.message,
        variant: "destructive",
      }),
  });

  const copyPassword = async () => {
    try {
      const password = await getSandboxPassword(projectId, sandbox.id);
      await copyText(password);
      toast({ title: "Root password copied to clipboard" });
    } catch (err) {
      toast({
        title: "Could not fetch the password",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div
      ref={rowRef}
      className={`rounded-md border bg-muted/20 transition-colors ${
        focus ? "border-primary/60 ring-1 ring-primary/30" : "border-border/50"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="flex cursor-pointer items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
          title="Toggle log"
          aria-expanded={showLog}
        >
          {showLog ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span className="font-mono text-xs text-foreground">
            {sandbox.name}
          </span>
        </button>
        <button
          type="button"
          onClick={copyName}
          className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Copy sandbox name"
          title="Copy sandbox name"
        >
          {nameCopied ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
        {sandbox.dedicated && (
          <Badge
            variant="outline"
            className="border-primary/50 text-[10px] text-primary"
            title="Dedicated dev sandbox — chat prompts, no PR pipeline, never auto-destroyed"
          >
            dev
          </Badge>
        )}
        <span
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${STATUS_STYLES[sandbox.status] ?? STATUS_STYLES.pending}`}
        >
          {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {sandbox.status}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {sandbox.provider} · {sandbox.size} @ {sandbox.region}
        </span>
        {parseStackServices(sandbox.stackServices).length > 0 && (
          <span
            className="flex items-center gap-1 text-[10px] text-sky-300"
            title="Stack services provisioned on this sandbox"
          >
            <Database className="h-2.5 w-2.5" />
            {parseStackServices(sandbox.stackServices)
              .map((s) => s.name)
              .join(" · ")}
          </span>
        )}
        {/* The address stays readable, but clicking yields the *runnable*
            command — with -i and the agent user, which a hand-typed
            `ssh <ip>` would both get wrong. */}
        {sandbox.sshCommand ? (
          <button
            type="button"
            onClick={copySshCommand}
            className="flex cursor-pointer items-center gap-1 rounded px-1 text-[10px] text-emerald-300 transition-colors hover:bg-muted"
            title={`Copy for an external terminal:\n${sandbox.sshCommand}`}
            aria-label="Copy the shell command for an external terminal"
          >
            {sshCopied ? (
              <Check className="h-2.5 w-2.5 text-emerald-400" />
            ) : (
              <Copy className="h-2.5 w-2.5" />
            )}
            {/* Short label read off the command's tail rather than rebuilt
                from the parts — the server owns which user it connects as. */}
            <code>
              {sandbox.provider === "local"
                ? `docker exec ${sandbox.name}`
                : `ssh ${sandbox.sshCommand.split(" ").pop()}`}
            </code>
          </button>
        ) : (
          sandbox.publicIp && (
            <code
              className="text-[10px] text-emerald-300"
              title="Public IP (cloud provider)"
            >
              {sandbox.publicIp}
            </code>
          )
        )}
        {sandbox.tailscaleIp && (
          <code
            className="text-[10px] text-sky-300"
            title="Tailscale address — reachable from your tailnet"
          >
            ts {sandbox.tailscaleIp}
          </code>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(sandbox.createdAt), {
            addSuffix: true,
          })}
        </span>
        {sandbox.provider === "local" && sandbox.status === "paused" && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => power.mutate("resume")}
            disabled={power.isPending}
            title="Resume: start the container and revive dockerd + stack services"
          >
            {power.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Resume
          </Button>
        )}
        {sandbox.status === "running" && sandbox.dedicated && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-primary/40 text-primary hover:text-primary"
            onClick={() => setDevOpen(true)}
            title="Open the dev console — chat prompts on this sandbox"
          >
            Dev console
          </Button>
        )}
        {sandbox.status === "running" && (
          <SandboxPreviewButton projectId={projectId} sandbox={sandbox} />
        )}
        {/* Everything else lives in one menu — the row stays readable. */}
        {sandbox.status !== "destroyed" && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Sandbox actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {sandbox.status === "running" && !sandbox.dedicated && (
                <DropdownMenuItem
                  onClick={() => dedicate.mutate(true)}
                  disabled={dedicate.isPending}
                >
                  Make dev sandbox
                </DropdownMenuItem>
              )}
              {sandbox.status === "running" &&
                (sandbox.publicIp || sandbox.provider === "local") && (
                  <DropdownMenuItem onClick={() => void openVsCode()}>
                    Open in VS Code
                  </DropdownMenuItem>
                )}
              {sandbox.status === "running" && terminalTarget && onOpenTerminal && (
                <DropdownMenuItem
                  onClick={() => onOpenTerminal(terminalTarget, sandbox.name)}
                >
                  Open terminal
                </DropdownMenuItem>
              )}
              {sandbox.status === "running" && sandbox.provider === "civo" && (
                <DropdownMenuItem onClick={() => void copyPassword()}>
                  Copy root password
                </DropdownMenuItem>
              )}
              {sandbox.status === "running" && (
                <DropdownMenuItem
                  onClick={() => retrySetup.mutate()}
                  disabled={retrySetup.isPending}
                >
                  {retrySetup.isPending
                    ? "Cloning and installing…"
                    : "Retry setup"}
                </DropdownMenuItem>
              )}
              {sandbox.provider === "local" && (
                <DropdownMenuItem
                  onClick={() => reveal.mutate()}
                  disabled={reveal.isPending}
                >
                  Open files in Finder
                </DropdownMenuItem>
              )}
              {/* Offered whenever this project joins a tailnet at all, not
                  only while a registration is known to be pending: the whole
                  problem is that a pending one is not visible from here. */}
              {sandbox.status === "running" && sandbox.tailnet && (
                <DropdownMenuItem
                  onClick={() => tailscaleLogin.mutate()}
                  disabled={tailscaleLogin.isPending}
                >
                  {tailscaleLogin.isPending
                    ? "Contacting the tailnet…"
                    : "Refresh Tailscale session"}
                </DropdownMenuItem>
              )}
              {sandbox.provider === "local" && sandbox.status === "running" && (
                <DropdownMenuItem
                  onClick={() => power.mutate("pause")}
                  disabled={power.isPending}
                >
                  Pause container
                </DropdownMenuItem>
              )}
              {sandbox.provider === "local" && sandbox.status === "paused" && (
                <DropdownMenuItem
                  onClick={() => power.mutate("resume")}
                  disabled={power.isPending}
                >
                  Resume container
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmOpen(true)}
                disabled={destroying || sandbox.status === "destroying"}
                className="text-destructive focus:text-destructive"
              >
                Destroy sandbox…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {sandbox.status === "destroyed" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDestroy}
            disabled={destroying}
            aria-label="Remove from list"
            title="Remove from list"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Destroy {sandbox.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This runs <code>terraform destroy</code>: the cloud instance,
                  its disk and everything on it are permanently deleted, and
                  billing for it stops. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmOpen(false);
                    onDestroy();
                  }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Destroy
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {sandbox.error && (
        <p className="px-3 pb-2 text-xs text-destructive">{sandbox.error}</p>
      )}
      {/* Sits on the row, not inside the log viewer: this is the one thing
          somebody has to act on, and it should not require opening a tab. */}
      {tsAuthUrl && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px]">
          <Network className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="shrink-0 text-muted-foreground">
            Approve this sandbox on your tailnet:
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 gap-1 border-amber-500/40 px-2 text-[10px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
            onClick={() =>
              window.open(tsAuthUrl, "_blank", "noopener,noreferrer")
            }
          >
            Approve now
            <ExternalLink className="h-3 w-3" />
          </Button>
          <a
            href={tsAuthUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-muted-foreground underline underline-offset-2 hover:text-foreground"
            title={tsAuthUrl}
          >
            {tsAuthUrl}
          </a>
          <button
            type="button"
            onClick={() => setTsAuthUrl(null)}
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {sandbox.status === "running" && (
        <SandboxHealthStrip
          projectId={projectId}
          sandboxId={sandbox.id}
          onShowLog={() => setShowLog(true)}
        />
      )}
      {sandbox.status === "running" && (
        <SandboxProcessPanel projectId={projectId} sandboxId={sandbox.id} />
      )}
      {sandbox.status === "running" && (
        <SandboxBrowserPanel
          projectId={projectId}
          sandboxId={sandbox.id}
          provider={sandbox.provider}
        />
      )}
      {showLog && (
        <>
          <Separator />
          <SandboxLogs
            projectId={projectId}
            sandboxId={sandbox.id}
            active={active}
            running={sandbox.status === "running"}
            isLocal={sandbox.provider === "local"}
            // A local container is exec-able as soon as it exists, which is
            // also when the bootstrap starts writing — no need to wait for
            // "running" to tail it.
            bootstrapTailable={
              sandbox.provider === "local"
                ? Boolean(sandbox.instanceId)
                : sandbox.status === "running" && Boolean(sandbox.publicIp)
            }
          />
        </>
      )}
      {sandbox.dedicated && (
        <DevConsoleSheet
          projectId={projectId}
          sandbox={sandbox}
          open={devOpen}
          onOpenChange={setDevOpen}
        />
      )}
    </div>
  );
}

function SandboxPreviewButton({
  projectId,
  sandbox,
}: {
  projectId: string;
  sandbox: SandboxSummary;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const start = useMutation({
    mutationFn: () => startPreview(projectId, sandbox.id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] });
      toast({
        title: "Live preview ready",
        description: data.previewUrl,
      });
      window.open(data.previewUrl, "_blank", "noopener");
    },
    onError: (err) => {
      // The API sends the app/tunnel log tail alongside the message — showing
      // only the message leaves the user with "it failed" and nothing to act on.
      const log = err instanceof ApiError ? err.log : undefined;
      toast({
        title: "Preview failed",
        description: log ? (
          <span className="flex flex-col gap-1">
            <span>{(err as Error).message}</span>
            <span className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10px] leading-tight">
              {log}
            </span>
          </span>
        ) : (
          (err as Error).message
        ),
        variant: "destructive",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () => stopPreview(projectId, sandbox.id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["sandboxes", projectId] }),
  });

  if (sandbox.previewUrl) {
    return (
      <span className="flex items-center gap-1">
        <a
          href={sandbox.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20"
          title={`Live app: ${sandbox.previewUrl}`}
        >
          <ExternalLink className="h-2.5 w-2.5" />
          Live preview
        </a>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          aria-label="Stop preview"
          title="Stop the app and the tunnel"
        >
          <X className="h-3 w-3" />
        </Button>
      </span>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5"
      onClick={() => start.mutate()}
      disabled={start.isPending}
      title="Run the app here and expose it on a public tunnel"
    >
      {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {start.isPending ? "Starting…" : "Preview"}
    </Button>
  );
}

const TASK_ACTIVE = ["queued", "running"];

const TASK_STATUS_STYLES: Record<string, string> = {
  queued: "border-border bg-muted/30 text-muted-foreground",
  running: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  completed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  error: "border-red-500/20 bg-red-500/10 text-red-300",
};

function ProjectTasksCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const tasks = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => getTasks(projectId),
    refetchInterval: (query) =>
      query.state.data?.some((t) => TASK_ACTIVE.includes(t.status))
        ? 3000
        : false,
  });

  const removeMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(projectId, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", projectId] }),
  });

  const list = tasks.data ?? [];
  const active = list.filter((t) => TASK_ACTIVE.includes(t.status)).length;

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Bot className="h-4 w-4 text-violet-400" />
          Agent tasks
          {active > 0 && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {active} running
            </Badge>
          )}
          <SoundToggle />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {list.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No tasks yet. Send a feature to a sandbox from the Features tab
            (hover a feature → <span className="font-medium">Run</span>).
          </p>
        )}
        {list.map((t) => (
          <TaskRow
            key={t.id}
            projectId={projectId}
            task={t}
            onRemove={() => removeMutation.mutate(t.id)}
            removing={removeMutation.isPending}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// Mutes the completion chime. Persisted in localStorage; read lazily on first
// render (client-only component, so there's no SSR mismatch to worry about).
function SoundToggle() {
  const [enabled, setEnabled] = useState(() =>
    typeof window === "undefined" ? true : isSoundEnabled(),
  );

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="ml-auto"
      aria-label={
        enabled ? "Mute task notifications" : "Unmute task notifications"
      }
      title={enabled ? "Sound on" : "Sound off"}
      onClick={() => {
        const next = !enabled;
        setEnabled(next);
        setSoundEnabled(next);
        if (next) playTaskSound("success"); // preview the chime
      }}
    >
      {enabled ? (
        <Volume2 className="h-3.5 w-3.5" />
      ) : (
        <VolumeX className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </Button>
  );
}

function TaskRow({
  projectId,
  task,
  onRemove,
  removing,
}: {
  projectId: string;
  task: TaskSummary;
  onRemove: () => void;
  removing: boolean;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const active = TASK_ACTIVE.includes(task.status);

  // The row shows the agent's report; the raw log lives in the details dialog.
  const detail = useQuery({
    queryKey: ["task", projectId, task.id],
    queryFn: () => getTask(projectId, task.id),
    enabled: expanded,
    refetchInterval: expanded && active ? 3000 : false,
  });

  const followUpMutation = useMutation({
    mutationFn: () =>
      runTask(projectId, {
        sandboxId: task.sandboxId,
        followUpOf: task.id,
        prompt: followUp.trim(),
      }),
    onSuccess: () => {
      setFollowUp("");
      setFollowUpOpen(false);
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });

  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-muted/20">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={expanded ? "Hide output" : "Show output"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="truncate text-xs font-medium">
          {task.feature?.title ?? task.prompt.slice(0, 40)}
        </span>
        <span
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
            TASK_STATUS_STYLES[task.status] ?? TASK_STATUS_STYLES.queued
          }`}
        >
          {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {task.status === "completed" && <Check className="h-2.5 w-2.5" />}
          {active && task.phase ? `${task.status}: ${task.phase}` : task.status}
        </span>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20"
          >
            <GitPullRequest className="h-2.5 w-2.5" />
            View PR
          </a>
        )}
        {task.previewUrl && (
          <a
            href={task.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20"
            title="Live app on the sandbox (public URL)"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            Live preview
          </a>
        )}
        {task.branch && (
          <code className="text-[10px] text-muted-foreground">
            {task.branch}
          </code>
        )}
        {task.costUsd != null && (
          <Badge variant="outline" className="text-[10px]">
            ${task.costUsd.toFixed(4)}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={() => setDetailsOpen(true)}
          title="Prompt, metadata and the full execution log"
        >
          Details
        </Button>
        {!active && task.branch && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setFollowUpOpen((v) => !v)}
            title="Ask for changes — same branch, same PR, agent keeps its context"
          >
            Follow up
          </Button>
        )}
        {!active && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            disabled={removing}
            aria-label="Remove task from history"
            title="Remove from history"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {task.error && (
        <p className="px-3 pb-2 text-xs break-words text-destructive">
          {task.error}
        </p>
      )}

      {followUpOpen && (
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (followUp.trim()) followUpMutation.mutate();
          }}
        >
          <Textarea
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            placeholder="What should change? e.g. “Use #111 instead of pure black, and add a hover state.”"
            rows={2}
            className="text-xs"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={followUpMutation.isPending || !followUp.trim()}
              className="gap-1.5"
            >
              {followUpMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Send follow-up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setFollowUpOpen(false)}
            >
              Cancel
            </Button>
            <span className="text-[10px] text-muted-foreground">
              Continues on {task.branch}
              {task.prUrl ? " — updates the same PR" : ""}
            </span>
          </div>
          {followUpMutation.isError && (
            <p className="text-xs text-destructive">
              {(followUpMutation.error as Error).message}
            </p>
          )}
        </form>
      )}

      {expanded && (
        <div className="min-w-0 border-t border-border/40 px-3 py-3">
          {detail.isLoading && (
            <p className="text-xs text-muted-foreground">Loading report…</p>
          )}
          {detail.data?.result ? (
            // The agent answers in markdown — render it, don't dump it.
            <MarkdownReport>{detail.data.result}</MarkdownReport>
          ) : (
            !detail.isLoading && (
              <p className="text-xs text-muted-foreground">
                {active
                  ? "The agent is still working — open Details to follow the log."
                  : "No report."}
              </p>
            )
          )}
          {/* Product screenshots collected for this run — same set Telegram gets. */}
          <TaskScreenshots
            projectId={projectId}
            taskId={task.id}
            enabled={expanded && !active}
          />
        </div>
      )}

      <TaskDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        projectId={projectId}
        task={task}
        active={active}
      />
    </div>
  );
}

// Everything an execution produced — prompt, metadata and the raw log —
// behind a button, so the task list stays readable.
function TaskDetailsDialog({
  open,
  onOpenChange,
  projectId,
  task,
  active,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  task: TaskSummary;
  active: boolean;
}) {
  const detail = useQuery({
    queryKey: ["task", projectId, task.id],
    queryFn: () => getTask(projectId, task.id),
    enabled: open,
    refetchInterval: open && active ? 3000 : false,
  });

  const meta: Array<[string, string]> = [
    ["Sandbox", task.sandbox.name],
    ["Branch", task.branch ?? "—"],
    [
      "Status",
      active && task.phase ? `${task.status}: ${task.phase}` : task.status,
    ],
    ["Cost", task.costUsd != null ? `$${task.costUsd.toFixed(4)}` : "—"],
    [
      "Duration",
      task.durationMs != null ? `${(task.durationMs / 1000).toFixed(1)}s` : "—",
    ],
    ["Live preview", task.previewUrl ? "running" : "—"],
    ["Working dir", task.workDir],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] grid-rows-[auto_1fr] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Bot className="h-4 w-4 text-violet-400" />
            {task.feature?.title ?? "Sandbox task"}
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-4 overflow-y-auto">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
            {meta.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {label}
                </dt>
                <dd className="truncate font-mono text-xs" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {(task.prUrl || task.previewUrl) && (
            <div className="space-y-1.5">
              {task.prUrl && (
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs break-all text-violet-300 hover:underline"
                >
                  <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
                  {task.prUrl}
                </a>
              )}
              {task.previewUrl && (
                <a
                  href={task.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-xs break-all text-sky-300 hover:underline"
                  title="The app this task produced, running on the sandbox (public URL)"
                >
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  {task.previewUrl}
                </a>
              )}
            </div>
          )}

          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Prompt
            </p>
            <pre className="max-h-32 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-2 text-[11px] leading-snug whitespace-pre-wrap text-muted-foreground">
              {task.prompt}
            </pre>
          </div>

          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Execution log
              {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            </p>
            <AutoScrollLog
              text={
                detail.data?.log ||
                (detail.isLoading ? "Loading log…" : "No output yet.")
              }
              className="max-h-80 rounded-md border border-border/50 bg-muted/30"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Remote readiness of a running instance: SSH, bootstrap, repo, Claude auth.
function SandboxHealthStrip({
  projectId,
  sandboxId,
  onShowLog,
}: {
  projectId: string;
  sandboxId: string;
  onShowLog: () => void;
}) {
  const health = useQuery({
    queryKey: ["sandbox-health", sandboxId],
    queryFn: () => getSandboxHealth(projectId, sandboxId),
    // Poll fast while the instance is still bootstrapping, then back off.
    refetchInterval: (query) =>
      query.state.data && !query.state.data.bootstrapComplete ? 5000 : 30_000,
    retry: false,
  });

  if (health.isLoading) {
    return (
      <p className="flex items-center gap-1.5 px-3 pb-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Checking instance…
      </p>
    );
  }
  if (health.isError || health.data?.error) {
    return (
      <p className="px-3 pb-2 text-[10px] text-amber-300/90">
        {health.data?.error ?? (health.error as Error).message}
      </p>
    );
  }

  const d = health.data!;
  // Until the bootstrap marker exists, a missing item isn't a failure — the
  // instance is still installing it. Only after that does it mean trouble.
  const installing = !d.bootstrapComplete;
  const state = (ok: boolean): "ok" | "pending" | "fail" =>
    ok ? "ok" : installing ? "pending" : "fail";

  const checks: Array<[string, "ok" | "pending" | "fail"]> = [
    ["ssh", d.reachable ? "ok" : "fail"],
    ["bootstrap", d.bootstrapComplete ? "ok" : "pending"],
    ["repo", state(d.repoPresent)],
    ["claude", state(d.claudeReady)],
    [d.gitCli ?? "gh", state(d.gitReady)],
  ];
  const dirty = d.gitStatus
    ? d.gitStatus.split("\n").filter(Boolean).length
    : 0;

  const STYLES = {
    ok: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    pending: "border-border bg-muted/30 text-muted-foreground",
    fail: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  };

  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-1.5 px-3 pb-2"
    >
      {checks.map(([label, s]) => (
        <span
          key={label}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${STYLES[s]}`}
          title={
            s === "pending"
              ? `${label}: still installing on the instance`
              : s === "fail"
                ? `${label}: not available — check the bootstrap log`
                : `${label}: ready`
          }
        >
          {s === "ok" && <Check className="h-2.5 w-2.5" />}
          {s === "pending" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {s === "fail" && <AlertCircle className="h-2.5 w-2.5" />}
          {label}
        </span>
      ))}
      {installing && (
        <button
          type="button"
          onClick={onShowLog}
          className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          installing… view log
        </button>
      )}
      {dirty > 0 && (
        <span className="text-[10px] text-muted-foreground" title={d.gitStatus}>
          {dirty} uncommitted file{dirty !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

// Two log sources: what the host-side provisioner did from here (terraform
// apply for cloud, docker run for local), and what cloud-init is doing inside
// the instance (the one that answers "why is `claude` still installing?").
function SandboxLogs({
  projectId,
  sandboxId,
  active,
  running,
  isLocal,
  bootstrapTailable,
}: {
  projectId: string;
  sandboxId: string;
  active: boolean;
  running: boolean;
  /** Local containers run `docker run`, not terraform — the tab is relabelled. */
  isLocal?: boolean;
  /**
   * Can /bootstrap-log reach the instance yet? Mirrors that route's own gate:
   * a container only needs to exist, a cloud instance needs SSH to be up. This
   * is why bootstrap is readable mid-provision while the other in-instance
   * sources are not.
   */
  bootstrapTailable?: boolean;
}) {
  // "bootstrap" keeps its own query (it reports completion, which drives the
  // follow-along polling); the rest share the generic log route and need a
  // running instance. Mid-provision the host-side log is the one that always
  // has something, so it is the default; bootstrap is reachable too once the
  // instance exists, and is one click away.
  const [source, setSource] = useState<"terraform" | "bootstrap" | SandboxLogSource>(
    running ? "app" : "terraform",
  );
  const [follow, setFollow] = useState(true);

  const terraform = useQuery({
    queryKey: ["sandbox", projectId, sandboxId],
    queryFn: () => getSandbox(projectId, sandboxId),
    enabled: source === "terraform",
    refetchInterval: active ? 3000 : false,
  });

  const bootstrap = useQuery({
    queryKey: ["sandbox-bootstrap-log", sandboxId],
    queryFn: () => getBootstrapLog(projectId, sandboxId),
    enabled: source === "bootstrap" && Boolean(bootstrapTailable),
    // Follow along while it's still installing, then stop hammering SSH.
    refetchInterval: (query) =>
      query.state.data && !query.state.data.complete ? 5000 : false,
    retry: false,
  });

  const isInstanceLog = source !== "terraform" && source !== "bootstrap";
  const instanceLog = useQuery({
    queryKey: ["sandbox-log", sandboxId, source],
    queryFn: () => getSandboxLog(projectId, sandboxId, source as SandboxLogSource),
    enabled: isInstanceLog && running,
    // A dev server keeps writing, so there is no "complete" to stop on —
    // following is the user's call.
    refetchInterval: follow ? 5000 : false,
    retry: false,
  });

  let text: string;
  if (source === "terraform") {
    text =
      terraform.data?.log ||
      (terraform.isLoading ? "Loading log…" : "No log yet.");
  } else if (source === "bootstrap") {
    // Checked before the !running guard: the bootstrap log is the whole story
    // of a provisioning instance, and it is readable then.
    text = !bootstrapTailable
      ? "Waiting for the instance…"
      : bootstrap.isError
        ? `Could not read the instance log: ${(bootstrap.error as Error).message}`
        : bootstrap.data?.log ||
          (bootstrap.isLoading ? "Reading /var/log/nexus-bootstrap.log…" : "");
  } else if (!running) {
    text = "The instance is not running.";
  } else {
    text = instanceLog.isError
      ? `Could not read the log: ${(instanceLog.error as Error).message}`
      : instanceLog.data?.log ||
        (instanceLog.isLoading ? "Reading the log…" : "");
  }

  const refreshing = isInstanceLog
    ? instanceLog.isFetching
    : source === "bootstrap"
      ? bootstrap.isFetching
      : terraform.isFetching;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
        {SANDBOX_LOG_SOURCES.map((s) => (
          <LogTab
            key={s.id}
            active={source === s.id}
            onClick={() => setSource(s.id)}
            label={s.label}
          />
        ))}
        {/* Same Sandbox.log field either way — terraform apply output for
            cloud, `docker pull`/`docker run` output for a local container. */}
        <LogTab
          active={source === "terraform"}
          onClick={() => setSource("terraform")}
          label={isLocal ? "Provisioning" : "Terraform"}
        />
        <div className="ml-auto flex items-center gap-2">
          {source === "bootstrap" && bootstrapTailable && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {bootstrap.data?.complete ? (
                <>
                  <Check className="h-2.5 w-2.5 text-emerald-400" />
                  finished
                </>
              ) : (
                <>
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  installing…
                </>
              )}
            </span>
          )}
          {isInstanceLog && running && (
            <>
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => setFollow(e.target.checked)}
                  className="h-3 w-3 accent-primary"
                />
                follow
              </label>
              <button
                type="button"
                onClick={() => void instanceLog.refetch()}
                disabled={refreshing}
                className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {refreshing ? "refreshing…" : "refresh"}
              </button>
            </>
          )}
        </div>
      </div>
      {/* Every WARN the bootstrap printed, not just the ones still inside the
          400-line tail. A finished bootstrap scrolls its own failures out of
          view — a tailscale install that lost a race with unattended-upgrades
          left a sandbox off the tailnet, and the reason was 700 lines above
          anything the UI could show. */}
      {source === "bootstrap" &&
        bootstrap.data?.warnings &&
        bootstrap.data.warnings.length > 0 && (
          <div className="mx-3 mt-2 space-y-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px]">
            <div className="flex items-center gap-1.5 text-amber-500">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {bootstrap.data.warnings.length} warning
              {bootstrap.data.warnings.length === 1 ? "" : "s"} during setup
            </div>
            {bootstrap.data.warnings.map((w, i) => (
              <div
                key={`${i}-${w}`}
                className="break-words pl-4.5 font-mono text-muted-foreground"
              >
                {w.replace(/^\[nexux\] WARN:\s*/, "")}
              </div>
            ))}
          </div>
        )}
      {/* Only a self-hosted tailnet reaches this: with no auth key the sandbox
          registers itself and blocks until somebody approves it in a browser
          they are already signed in to. */}
      {source === "bootstrap" && bootstrap.data?.tailscaleAuthUrl && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px]">
          <Network className="h-3 w-3 shrink-0 text-amber-500" />
          <span className="text-muted-foreground">
            Waiting for approval on your tailnet.
          </span>
          <a
            href={bootstrap.data.tailscaleAuthUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate underline underline-offset-2 hover:text-foreground"
          >
            {bootstrap.data.tailscaleAuthUrl}
          </a>
        </div>
      )}
      <AutoScrollLog text={text} />
    </div>
  );
}

function LogTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {label}
    </button>
  );
}
