// Server-only: materialize a bootstrap project on disk. Creates the workspace
// directory, writes a small type-aware scaffold (README + docs/IDEA.md +
// .gitignore, plus extras per template) and initializes a git repo with an
// initial commit so the project is immediately sandbox-cloneable.
//
// Follows repo conventions: execFile argv arrays (never string shells), and
// git add uses explicit file paths only.

import { mkdir, writeFile, readdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { getConfig } from "@nexux/config";
import { expandHome } from "@nexux/storage";
import {
  getBootstrapTemplate,
  slugifyProjectName,
  type BootstrapTemplate,
} from "./templates";

const execFileAsync = promisify(execFile);

export class BootstrapError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type ScaffoldInput = {
  name: string;
  description?: string;
  type: string;
  parentPath: string;
};

export type ScaffoldResult = {
  dir: string;
  slug: string;
  template: BootstrapTemplate;
  /** Non-fatal issues (e.g. git unavailable) surfaced to the client. */
  warnings: string[];
};

const GITIGNORE = `node_modules/
dist/
build/
.next/
.turbo/
coverage/
*.log
.env
.env.*
!.env.example
.DS_Store
`;

function ideaDoc(input: ScaffoldInput, template: BootstrapTemplate): string {
  return `# ${input.name} — Idea

> Type: **${template.name}** · bootstrapped with Nexus

## The idea

${input.description?.trim() || "_Describe the idea in one or two sentences._"}

## Problem

_What hurts today? Who feels it?_

## Solution

_How does this fix it? What's the unfair advantage?_

## MVP scope

- [ ] _Smallest thing that proves the idea_

## Open questions

- _What don't we know yet?_
`;
}

function readme(input: ScaffoldInput, template: BootstrapTemplate): string {
  return `# ${input.name}

${input.description?.trim() || `A ${template.name.toLowerCase()} project.`}

> Bootstrapped as **${template.name}** — ${template.tagline}.

Start with [docs/IDEA.md](docs/IDEA.md).
`;
}

/** Extra scaffold files per template, path → content. */
function templateExtras(template: BootstrapTemplate): Record<string, string> {
  switch (template.key) {
    case "research":
      return {
        "research/NOTES.md": "# Notes\n\n_Running log — newest on top._\n",
        "research/SOURCES.md":
          "# Sources\n\n| Source | Link | Takeaway |\n|---|---|---|\n",
        "research/EXPERIMENTS.md":
          "# Experiments\n\n_Hypothesis → method → result, one section each._\n",
      };
    case "scripting":
      return {
        "scripts/README.md":
          "# Scripts\n\n_One script, one job. Document usage at the top of each file._\n",
      };
    case "data-ai":
      return {
        "notebooks/README.md":
          "# Notebooks\n\n_Exploration lives here; promote stable code to src/._\n",
      };
    default:
      return {};
  }
}

/**
 * Create `<parentPath>/<slug>` with the template scaffold and a git repo.
 * Throws BootstrapError(409) if the directory already exists and is not empty.
 */
export async function scaffoldBootstrapProject(
  input: ScaffoldInput,
): Promise<ScaffoldResult> {
  const template = getBootstrapTemplate(input.type);
  if (!template) {
    throw new BootstrapError(`Unknown bootstrap type "${input.type}"`);
  }

  const slug = slugifyProjectName(input.name);
  if (!slug) {
    throw new BootstrapError("Project name produces an empty folder name");
  }

  const parent = expandHome(input.parentPath.trim());
  if (!path.isAbsolute(parent)) {
    throw new BootstrapError("Location must be an absolute path (or ~/...)");
  }
  const dir = path.join(parent, slug);

  // Refuse to write into an existing non-empty directory.
  try {
    const entries = await readdir(dir);
    if (entries.length > 0) {
      throw new BootstrapError(
        `Directory already exists and is not empty: ${dir}`,
        409,
      );
    }
  } catch (err) {
    if (err instanceof BootstrapError) throw err;
    // ENOENT — good, we'll create it.
  }

  const files: Record<string, string> = {
    "README.md": readme(input, template),
    ".gitignore": GITIGNORE,
    "docs/IDEA.md": ideaDoc(input, template),
    ...templateExtras(template),
  };

  try {
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Permission failures are a user-fixable location problem, not a server
    // fault — on a Nexus host everything outside the workspace volume is
    // unwritable. Surface them as a 400 with the fix instead of a bare 500.
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new BootstrapError(
        `Nexus cannot write to ${parent}. Choose a folder under ${
          getConfig().workspaceRoot
        } instead.`,
      );
    }
    throw err;
  }

  const warnings: string[] = [];
  try {
    await execFileAsync("git", ["-C", dir, "init"], { timeout: 10_000 });
    await execFileAsync("git", ["-C", dir, "add", ...Object.keys(files)], {
      timeout: 10_000,
    });
    // Identity passed inline: a host container has no global git config, and
    // commit refuses to run without one.
    await execFileAsync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=Nexus",
        "-c",
        "user.email=nexux@localhost",
        "commit",
        "-m",
        `chore: bootstrap ${template.key} project`,
      ],
      { timeout: 10_000 },
    );
  } catch (err) {
    warnings.push(
      `git init/commit failed — workspace created without version control: ${
        err instanceof Error ? err.message.split("\n")[0] : String(err)
      }`,
    );
  }

  return { dir, slug, template, warnings };
}
