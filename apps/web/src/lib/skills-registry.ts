// skills.sh registry integration (server-side).
//
// skills.sh exposes fuzzy search at /api/search?q=…, returning entries whose
// id is "<owner>/<repo>/<skillName>" where skillName is the SKILL.md
// frontmatter `name` — NOT necessarily the directory name. Resolution walks
// the GitHub tree for SKILL.md files and matches frontmatter names, using the
// active git credential when available (unauthenticated works, rate-limited).
// When the API refuses — 60 requests an hour without a token, shared by every
// app on this IP — the repo's archive from codeload.github.com is read instead:
// no API quota, and it brings the skill's whole folder (references, scripts).

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { matchSkillMd, rankSkillPaths } from "@/lib/skill-match";
import { resolveGitCredential } from "@/lib/sandbox-manager";

const REGISTRY = "https://skills.sh";

export type RegistrySkill = {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
};

export type ResolvedSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  body: string;
  path: string;
  repoUrl: string;
  /** The skill's folder, SKILL.md included — only when it came from the repo's archive. */
  files?: { path: string; content: Buffer }[];
};

export async function searchRegistry(query: string): Promise<RegistrySkill[]> {
  const res = await fetch(
    `${REGISTRY}/api/search?q=${encodeURIComponent(query)}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`skills.sh search failed (${res.status})`);
  const data = (await res.json()) as { skills?: RegistrySkill[] };
  return data.skills ?? [];
}

async function githubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "nexux",
  };
  // Credentials are global — any saved github token authenticates the fetch.
  const cred = await resolveGitCredential(null).catch(() => null);
  if (cred?.provider === "github") {
    headers.authorization = `Bearer ${cred.token}`;
  }
  return headers;
}

function parseId(id: string) {
  const parts = id.split("/");
  if (parts.length < 3 || parts.some((p) => !p || p === "." || p === "..")) throw new Error("Invalid skill id");
  return { owner: parts[0], repo: parts[1], skillName: parts.slice(2).join("/") };
}

/**
 * Find and fetch the SKILL.md behind a registry id ("owner/repo/skillName"):
 * through the GitHub API, else through the repo's archive.
 */
export async function resolveRegistrySkill(id: string): Promise<ResolvedSkill> {
  parseId(id);
  try {
    return await resolveViaApi(id);
  } catch (apiErr) {
    try {
      return await resolveViaArchive(id);
    } catch (archiveErr) {
      const a = apiErr instanceof Error ? apiErr.message : String(apiErr);
      const b = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
      throw new Error(a === b ? a : `${b} (GitHub API: ${a})`);
    }
  }
}

async function resolveViaApi(id: string): Promise<ResolvedSkill> {
  const { owner, repo, skillName } = parseId(id);

  const headers = await githubHeaders();
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers, cache: "no-store" },
  );
  if (!treeRes.ok) {
    throw new Error(`Could not read ${owner}/${repo} (${treeRes.status})`);
  }
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string }>;
  };
  const candidates = (tree.tree ?? [])
    .filter((t) => t.type === "blob" && t.path.endsWith("SKILL.md"))
    .map((t) => t.path);
  if (candidates.length === 0) {
    throw new Error("No SKILL.md files found in the repository");
  }

  const ranked = rankSkillPaths(candidates, skillName);

  const rawHeaders = { ...headers, accept: "application/vnd.github.raw" };
  for (const path of ranked.slice(0, 15)) {
    const fileRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      { headers: rawHeaders, cache: "no-store" },
    );
    if (!fileRes.ok) continue;
    const content = await fileRes.text();
    const hit = matchSkillMd(content, skillName);
    if (hit) {
      return { id, ...hit, content, path, repoUrl: `https://github.com/${owner}/${repo}/blob/HEAD/${path}` };
    }
  }
  throw new Error(
    `Could not locate "${skillName}" inside ${owner}/${repo} — the repo layout may be unsupported`,
  );
}

const run = promisify(execFile);
/** A repo archive bigger than this is not a skills repo worth unpacking. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

async function walk(dir: string, out: string[] = [], limit = 50_000): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= limit || SKIP_DIRS.has(e.name)) continue;
    const full = nodePath.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, limit);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** The repo's HEAD as a tarball from codeload — no API quota — unpacked in a temp folder. */
async function resolveViaArchive(id: string): Promise<ResolvedSkill> {
  const { owner, repo, skillName } = parseId(id);
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`, {
    headers: { "user-agent": "nexux" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Could not download ${owner}/${repo} (${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES) {
    throw new Error(`${owner}/${repo} is too big to unpack`);
  }
  const archive = Buffer.from(await res.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`${owner}/${repo} is too big to unpack`);

  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "nexux-skill-"));
  try {
    const file = nodePath.join(tmp, "repo.tar.gz");
    const root = nodePath.join(tmp, "repo");
    await fs.writeFile(file, archive);
    await fs.mkdir(root);
    await run("tar", ["-xzf", file, "-C", root, "--strip-components", "1"], { timeout: 60_000 });

    const rel = (p: string) => nodePath.relative(root, p).split(nodePath.sep).join("/");
    const candidates = (await walk(root)).filter((p) => nodePath.basename(p) === "SKILL.md").map(rel);
    if (candidates.length === 0) throw new Error("No SKILL.md files found in the repository");

    for (const path of rankSkillPaths(candidates, skillName)) {
      const content = await fs.readFile(nodePath.join(root, path), "utf8").catch(() => null);
      const hit = content ? matchSkillMd(content, skillName) : null;
      if (!content || !hit) continue;
      // The skill's folder, the way its own repo lays it out.
      const dir = nodePath.dirname(nodePath.join(root, path));
      const files: { path: string; content: Buffer }[] = [];
      let bytes = 0;
      for (const f of await walk(dir, [], MAX_SKILL_FILES * 5)) {
        if (files.length >= MAX_SKILL_FILES) break;
        const buf = await fs.readFile(f);
        if (bytes + buf.length > MAX_SKILL_BYTES) continue;
        bytes += buf.length;
        files.push({ path: nodePath.relative(dir, f).split(nodePath.sep).join("/"), content: buf });
      }
      return { id, ...hit, content, path, repoUrl: `https://github.com/${owner}/${repo}/blob/HEAD/${path}`, files };
    }
    throw new Error(`Could not locate "${skillName}" inside ${owner}/${repo} — the repo layout may be unsupported`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
