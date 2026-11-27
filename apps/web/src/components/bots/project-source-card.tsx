"use client";

// "Where does the code come from?" in a project chat (spec 39): pick a folder
// on this machine, paste Git URLs, or start from an idea. The pick goes back
// to the assistant as the user's message.

import { useState } from "react";
import { FolderOpen, GitBranch, Lightbulb } from "lucide-react";

import { FolderPicker } from "@/components/projects/folder-picker";
import { Button } from "@/components/ui/button";
import { parseGitUrls, sourceAnswer } from "@/lib/nexus-cards";
import { cn } from "@/lib/utils";

export function ProjectSourceCard({
  question,
  disabled,
  onAnswer,
}: {
  question: string;
  disabled: boolean;
  onAnswer: (text: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [git, setGit] = useState("");
  const urls = parseGitUrls(git);
  const row =
    "flex w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5 text-left text-[13.5px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="max-w-[560px] rounded-2xl border border-border bg-card px-4 py-3.5">
      <p className="pb-3 text-[13.5px] font-semibold">{question}</p>
      <div className="space-y-2">
        <button type="button" disabled={disabled} onClick={() => setPicking(true)} className={row}>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            Choose a folder on this Mac
            <span className="block text-[11.5px] text-muted-foreground">Nexus finds the repositories inside it</span>
          </span>
        </button>

        <div className={cn("rounded-xl border border-border bg-background/40 px-3 py-2.5", disabled && "opacity-50")}>
          <div className="flex items-center gap-3 pb-2 text-[13.5px]">
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            Git repositories
          </div>
          <div className="flex gap-2">
            <textarea
              value={git}
              disabled={disabled}
              onChange={(e) => setGit(e.target.value)}
              rows={git.includes("\n") ? 3 : 1}
              placeholder="https://github.com/org/repo.git — one or more"
              className="min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <Button
              size="sm"
              className="h-9 shrink-0 rounded-lg"
              disabled={disabled || urls.length === 0}
              onClick={() => onAnswer(sourceAnswer.git(urls))}
            >
              Use {urls.length > 1 ? `these ${urls.length}` : "it"}
            </Button>
          </div>
        </div>

        <button type="button" disabled={disabled} onClick={() => onAnswer(sourceAnswer.idea)} className={row}>
          <Lightbulb className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            Start from an idea
            <span className="block text-[11.5px] text-muted-foreground">Nexus creates a fresh folder with the stack ready</span>
          </span>
        </button>
      </div>
      <FolderPicker
        open={picking}
        onOpenChange={setPicking}
        initialPath="~/Projects"
        onSelect={(path) => {
          setPicking(false);
          onAnswer(sourceAnswer.folder(path));
        }}
      />
    </div>
  );
}
