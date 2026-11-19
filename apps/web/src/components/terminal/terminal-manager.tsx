"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dockerTerminalTarget, terminalTargetAuthority } from "@/lib/terminal-target";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import { getSandboxes } from "@/services/sandbox";

import {
  TerminalPicker,
  TerminalPickerDialog,
  buildPickerEntries,
  type ShellOption,
} from "./terminal-picker";
import { TerminalPane } from "./terminal-pane";
import { RealTerminal } from "./real-terminal";
import type { TerminalsState, TerminalTab } from "./terminal-types";
import {
  collectLeaves,
  findFirstLeaf,
  makeLeaf,
  newId,
  removeLeaf,
  splitLeaf,
} from "./terminal-tree";

interface TerminalManagerProps {
  projectId: string;
  repositories: Array<{
    id: string;
    name: string;
    localPath: string | null;
    isMain: boolean;
  }>;
  workspacePath: string | null;
  /**
   * Request to open a sandbox session, from the Sandboxes tab. `target` is a
   * full cwd URL — `ssh://user@host/path` for cloud instances, or
   * `docker://container/path` for local ones (no public IP to ssh to).
   * `nonce` makes repeat clicks on the same sandbox re-trigger. Passed as a
   * prop rather than a URL param because history.replaceState doesn't notify
   * useSearchParams, so a param-based handoff would silently no-op.
   */
  sshRequest?: { target: string; label: string; nonce: number } | null;
  onSshHandled?: () => void;
}

const STORAGE_PREFIX = "nexux:terminals:";
const STORAGE_VERSION = 1;
const URL_PARAM = "termTab";

type StoredState = {
  v: number;
  state: TerminalsState;
};

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

function loadState(projectId: string): TerminalsState | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    if (!parsed.state || !Array.isArray(parsed.state.tabs)) return null;
    return parsed.state;
  } catch {
    return null;
  }
}

function saveState(projectId: string, state: TerminalsState) {
  try {
    const payload: StoredState = { v: STORAGE_VERSION, state };
    localStorage.setItem(storageKey(projectId), JSON.stringify(payload));
  } catch {
    // ignore quota / privacy mode
  }
}

function shortLabel(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function TerminalManager({
  projectId,
  repositories,
  workspacePath,
  sshRequest,
  onSshHandled,
}: TerminalManagerProps) {
  const searchParams = useSearchParams();
  const urlTabIndexRaw = searchParams.get(URL_PARAM);
  const urlTabIndex = (() => {
    if (!urlTabIndexRaw) return null;
    const n = parseInt(urlTabIndexRaw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  // Running sandboxes are offered as SSH terminal targets alongside local dirs.
  const sandboxes = useQuery({
    queryKey: ["sandboxes", projectId],
    queryFn: () => getSandboxes(projectId),
  });

  // Shells belong to the machine running the pty server (which on a Nexus host
  // is not this browser's), so they are fetched rather than derived here.
  const shellInfo = useQuery({
    queryKey: ["terminal-shells"],
    queryFn: async () => {
      const res = await fetch("/api/terminal/shells", { cache: "no-store" });
      if (!res.ok) throw new Error("failed to list shells");
      return (await res.json()) as {
        shells: ShellOption[];
        defaultShellId: string;
      };
    },
    staleTime: 60_000,
  });
  const shells = shellInfo.data?.shells ?? [];
  const defaultShellId = shellInfo.data?.defaultShellId;

  const entries = useMemo(() => {
    const base = buildPickerEntries(repositories, workspacePath);
    const remote = (sandboxes.data ?? [])
      .filter((s) => s.status === "running")
      .map((s) => {
        // Local sandboxes are containers with no public IP — reached through
        // `docker exec` on their container name instead of ssh.
        if (s.provider === "local") {
          const cwd = dockerTerminalTarget(s, "/opt/nexus");
          return cwd
            ? {
                id: `sandbox:${s.id}`,
                label: s.name,
                cwd,
                hint: `docker exec ${s.instanceId}${s.region !== "local" ? ` on ${s.region}` : ""} → /opt/nexus`,
              }
            : null;
        }
        // As the agent user, not root — it owns /opt/nexus, and a root-owned
        // node_modules/.next left behind by a terminal session breaks the dev
        // servers and the agent. `sudo` here is passwordless.
        return s.publicIp
          ? {
              id: `sandbox:${s.id}`,
              label: s.name,
              cwd: `ssh://nexus@${s.publicIp}/opt/nexus`,
              hint: `ssh nexus@${s.publicIp} → /opt/nexus`,
            }
          : null;
      })
      .filter((e) => e !== null);
    return [...remote, ...base];
  }, [repositories, workspacePath, sandboxes.data]);

  const [state, setState] = useState<TerminalsState>(() => {
    if (typeof window === "undefined") {
      return { tabs: [], activeTabId: null };
    }
    const stored = loadState(projectId);
    if (stored && stored.tabs.length > 0) {
      const idx =
        urlTabIndex !== null && urlTabIndex < stored.tabs.length
          ? urlTabIndex
          : -1;
      return {
        ...stored,
        activeTabId: idx >= 0 ? stored.tabs[idx].id : stored.activeTabId,
      };
    }
    const defaultCwd =
      entries[0]?.cwd || workspacePath || repositories[0]?.localPath || null;
    if (!defaultCwd) return { tabs: [], activeTabId: null };
    const leaf = makeLeaf(defaultCwd);
    const tab: TerminalTab = {
      id: newId("tab"),
      title: shortLabel(defaultCwd),
      root: leaf,
      activeLeafId: leaf.id,
    };
    return { tabs: [tab], activeTabId: tab.id };
  });

  useEffect(() => {
    saveState(projectId, state);
  }, [projectId, state]);

  const activeTabIndex = useMemo(
    () => state.tabs.findIndex((t) => t.id === state.activeTabId),
    [state.tabs, state.activeTabId]
  );

  // Sync activeTabIndex → URL
  const lastPushedRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeTabIndex < 0) return;
    if (lastPushedRef.current === activeTabIndex) return;
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set(URL_PARAM, String(activeTabIndex));
    lastPushedRef.current = activeTabIndex;
    window.history.replaceState(window.history.state, "", url.toString());
  }, [activeTabIndex]);

  // Sync URL → activeTabId (external nav). Skip if we just pushed our state.
  useEffect(() => {
    if (urlTabIndex === null) return;
    if (urlTabIndex === activeTabIndex) return;
    if (lastPushedRef.current === activeTabIndex) return;
    const target = state.tabs[urlTabIndex];
    if (!target) return;
    lastPushedRef.current = urlTabIndex;
    setState((s) => ({ ...s, activeTabId: target.id }));
  }, [urlTabIndex, activeTabIndex, state.tabs]);

  // Drop restored SSH tabs whose sandbox no longer exists (destroyed between
  // sessions) — they'd otherwise show up dead on load.
  // Keyed by whatever the cwd URL carries in its authority slot: the host for
  // ssh, the container name for docker.
  const liveHosts = useMemo(
    () =>
      new Set(
        (sandboxes.data ?? [])
          .filter((s) => s.status === "running")
          .map((s) => (s.provider === "local" ? s.instanceId : s.publicIp))
          .filter((h): h is string => Boolean(h))
      ),
    [sandboxes.data]
  );
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || !sandboxes.data) return;
    prunedRef.current = true;
    setState((s) => {
      const tabs = s.tabs.filter((t) =>
        collectLeaves(t.root).every((l) => {
          const authority = terminalTargetAuthority(l.cwd);
          return !authority || liveHosts.has(authority);
        })
      );
      if (tabs.length === s.tabs.length) return s;
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null);
      return { tabs, activeTabId };
    });
  }, [sandboxes.data, liveHosts]);

  // Open (or focus) an SSH session when the Sandboxes tab asks for one.
  const sshNonce = sshRequest?.nonce ?? null;
  useEffect(() => {
    if (!sshRequest) return;
    const cwd = sshRequest.target;
    setState((s) => {
      const existing = s.tabs.find((t) =>
        collectLeaves(t.root).some((l) => l.cwd === cwd)
      );
      if (existing) {
        return existing.id === s.activeTabId
          ? s
          : { ...s, activeTabId: existing.id };
      }
      const leaf = makeLeaf(cwd);
      const tab: TerminalTab = {
        id: newId("tab"),
        title: sshRequest.label || sshRequest.target,
        root: leaf,
        activeLeafId: leaf.id,
      };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    });
    onSshHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshNonce]);

  const [pendingSplit, setPendingSplit] = useState<{
    tabId: string;
    leafId: string;
    dir: "horizontal" | "vertical";
  } | null>(null);

  const slotsRef = useRef<Map<string, HTMLElement>>(new Map());
  const slotRefCallbacksRef = useRef<
    Map<string, (el: HTMLElement | null) => void>
  >(new Map());
  const [slotsVersion, setSlotsVersion] = useState(0);
  const getSlotRef = useCallback((leafId: string) => {
    let cb = slotRefCallbacksRef.current.get(leafId);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const current = slotsRef.current.get(leafId) ?? null;
        if (current === el) return;
        if (el === null) {
          slotsRef.current.delete(leafId);
        } else {
          slotsRef.current.set(leafId, el);
        }
        setSlotsVersion((v) => v + 1);
      };
      slotRefCallbacksRef.current.set(leafId, cb);
    }
    return cb;
  }, []);

  const allLeaves = useMemo(() => {
    const out: Array<{ id: string; cwd: string; shellId?: string }> = [];
    for (const tab of state.tabs) {
      for (const leaf of collectLeaves(tab.root)) {
        out.push({ id: leaf.id, cwd: leaf.cwd, shellId: leaf.shellId });
      }
    }
    return out;
  }, [state]);

  const openNewTab = useCallback((cwd: string, label: string, shellId?: string) => {
    const leaf = makeLeaf(cwd, shellId);
    const tab: TerminalTab = {
      id: newId("tab"),
      title: label || shortLabel(cwd),
      root: leaf,
      activeLeafId: leaf.id,
    };
    setState((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    }));
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setState((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        activeTabId = tabs[tabs.length - 1]?.id || null;
      }
      return { tabs, activeTabId };
    });
  }, []);

  const activateTab = useCallback((tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  }, []);

  const updateTab = useCallback(
    (tabId: string, fn: (tab: TerminalTab) => TerminalTab | null) => {
      setState((s) => {
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0) return s;
        const next = fn(s.tabs[idx]);
        if (next === null) {
          const tabs = s.tabs.filter((_, i) => i !== idx);
          let activeTabId = s.activeTabId;
          if (activeTabId === tabId) {
            activeTabId = tabs[tabs.length - 1]?.id || null;
          }
          return { tabs, activeTabId };
        }
        const tabs = s.tabs.slice();
        tabs[idx] = next;
        return { ...s, tabs };
      });
    },
    []
  );

  const requestSplit = useCallback(
    (tabId: string, leafId: string, dir: "horizontal" | "vertical") => {
      setPendingSplit({ tabId, leafId, dir });
    },
    []
  );

  const performSplit = useCallback(
    (
      tabId: string,
      leafId: string,
      dir: "horizontal" | "vertical",
      cwd: string,
      shellId?: string
    ) => {
      updateTab(tabId, (tab) => {
        const result = splitLeaf(tab.root, leafId, dir, cwd, shellId);
        if (!result) return tab;
        return {
          ...tab,
          root: result.root,
          activeLeafId: result.newLeafId,
        };
      });
    },
    [updateTab]
  );

  const closePane = useCallback(
    (tabId: string, leafId: string) => {
      updateTab(tabId, (tab) => {
        const nextRoot = removeLeaf(tab.root, leafId);
        if (!nextRoot) return null;
        const firstLeaf = findFirstLeaf(nextRoot);
        return {
          ...tab,
          root: nextRoot,
          activeLeafId: firstLeaf?.id || tab.activeLeafId,
        };
      });
    },
    [updateTab]
  );

  const activatePane = useCallback(
    (tabId: string, leafId: string) => {
      updateTab(tabId, (tab) =>
        tab.activeLeafId === leafId ? tab : { ...tab, activeLeafId: leafId }
      );
    },
    [updateTab]
  );

  const renderTabContent = (tab: TerminalTab) => {
    return (
      <TerminalPane
        node={tab.root}
        activeLeafId={tab.activeLeafId}
        onActivate={(id) => activatePane(tab.id, id)}
        onSplit={(id, dir) => requestSplit(tab.id, id, dir)}
        onClose={(id) => closePane(tab.id, id)}
        getSlotRef={getSlotRef}
      />
    );
  };

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="flex items-center gap-1 border-b border-border/40 pb-1.5">
        <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
          {state.tabs.map((tab) => {
            const isActive = tab.id === state.activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => activateTab(tab.id)}
                className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer transition-colors ${
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                <span className="max-w-[140px] truncate" title={tab.title}>
                  {tab.title}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20"
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <TerminalPicker
          entries={entries}
          onPick={openNewTab}
          shells={shells}
          defaultShellId={defaultShellId}
        />
      </div>

      <div className="relative flex-1 min-h-0">
        {state.tabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No terminals open. Click <span className="mx-1 font-medium">New</span>{" "}
            to start one.
          </div>
        )}
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${
              tab.id === state.activeTabId ? "" : "hidden"
            }`}
          >
            {renderTabContent(tab)}
          </div>
        ))}
      </div>

      {/* RealTerminal reads its shell once, when the socket opens. Mounting
          before the default is known would connect without one and silently get
          the platform default instead of the configured shell. */}
      {!shellInfo.isLoading &&
        allLeaves.map((leaf) => (
          <RealTerminal
            key={leaf.id}
            workingDirectory={leaf.cwd}
            // A pane with no shell of its own follows the configured default.
            // Resolving it here rather than server-side keeps the pty server
            // free of database access — it only runs the id it is handed.
            shellId={leaf.shellId ?? defaultShellId}
            slot={slotsRef.current.get(leaf.id) ?? null}
            slotsVersion={slotsVersion}
          />
        ))}

      <TerminalPickerDialog
        open={pendingSplit !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSplit(null);
        }}
        entries={entries}
        shells={shells}
        defaultShellId={defaultShellId}
        onPick={(cwd, _label, shellId) => {
          if (!pendingSplit) return;
          performSplit(
            pendingSplit.tabId,
            pendingSplit.leafId,
            pendingSplit.dir,
            cwd,
            shellId
          );
          setPendingSplit(null);
        }}
        title="Split terminal in…"
        description="Choose which project directory to open in the new pane."
      />
    </div>
  );
}
