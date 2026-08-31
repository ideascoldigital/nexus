"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { GitBranch, Lock } from "lucide-react";

export interface PickedGitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
}

interface GitHubAccount {
  id: string;
  label: string;
}

interface RepoOption extends PickedGitHubRepo {
  id: number;
  private: boolean;
}

/** GitHub's own page cap for /user/repos, and what the list below asks for. */
const PER_PAGE = 100;

/**
 * Fills a "Git URL" field from a connected GitHub account instead of making
 * someone find and paste the URL. Deliberately a *button beside* the field
 * rather than a replacement for it: a repo on a host Nexus has no token for,
 * or one past the first page below, still has to be typeable. Same shape as
 * the folder-browse button next to Local Path.
 *
 * Renders nothing at all when no GitHub account is connected — a disabled
 * button pointing at Settings would be noise in a form that already works
 * without it.
 */
export function GitHubRepoPicker({
  onSelect,
  disabled,
}: {
  onSelect: (repo: PickedGitHubRepo) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");

  // Shared cache key with the import dialogs — opening this after one of those
  // costs nothing.
  const { data: accounts = [] } = useQuery<GitHubAccount[]>({
    queryKey: ["github-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/github/accounts");
      if (!res.ok) throw new Error("Failed to load GitHub accounts");
      return res.json();
    },
  });

  const activeAccountId = accountId || accounts[0]?.id || "";

  const { data: repos = [], isLoading } = useQuery<RepoOption[]>({
    queryKey: ["github-repos", activeAccountId],
    queryFn: async () => {
      const res = await fetch(`/api/github/accounts/${activeAccountId}/repos`);
      if (!res.ok) throw new Error("Failed to load repositories");
      return res.json();
    },
    enabled: open && !!activeAccountId,
  });

  if (accounts.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton
        disabled={disabled}
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            title="Pick from a connected GitHub account"
          />
        }
      >
        <GitBranch className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent className="p-0 w-96" align="end">
        {/* Only worth the row when there is a choice to make. */}
        {accounts.length > 1 && (
          <select
            value={activeAccountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full h-8 border-b border-border bg-transparent px-2 text-xs"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <Command>
          <CommandInput placeholder="Search repositories..." />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading repositories..." : "No repository found."}
            </CommandEmpty>
            {repos.map((r) => (
              <CommandItem
                key={r.id}
                value={r.full_name}
                onSelect={() => {
                  onSelect({
                    name: r.name,
                    full_name: r.full_name,
                    html_url: r.html_url,
                  });
                  setOpen(false);
                }}
              >
                <span className="truncate flex-1">{r.full_name}</span>
                {r.private && (
                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </CommandItem>
            ))}
          </CommandList>
          {/* The route asks for one page, newest first. Saying so beats a list
              that silently stops short — and the field beside this button is
              the answer for anything older. */}
          {repos.length === PER_PAGE && (
            <p className="border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
              Showing the {PER_PAGE} most recently updated. Paste the URL
              directly for anything older.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
