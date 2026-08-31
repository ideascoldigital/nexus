import fs from "fs";
import path from "path";
import ignore from "ignore";

const HARD_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
  ".nexux",
];

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs",
  ".php", ".sh", ".bash", ".zsh",
  ".sql", ".prisma",
  ".md", ".mdx", ".markdown", ".txt", ".rst",
  ".json", ".yaml", ".yml", ".toml", ".env.example",
  ".html", ".css", ".scss",
  ".vue", ".svelte",
]);

const MAX_FILE_BYTES = 512 * 1024; // 512KB

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  size: number;
};

export function scanRepo(rootPath: string): ScannedFile[] {
  if (!fs.existsSync(rootPath)) return [];

  const ig = ignore();
  const gitignorePath = path.join(rootPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  const nexuxIgnorePath = path.join(rootPath, ".nexuxignore");
  if (fs.existsSync(nexuxIgnorePath)) {
    ig.add(fs.readFileSync(nexuxIgnorePath, "utf8"));
  }

  const out: ScannedFile[] = [];
  walk(rootPath, rootPath, ig, out);
  return out;
}

function walk(root: string, dir: string, ig: ReturnType<typeof ignore>, out: ScannedFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (HARD_EXCLUDES.includes(entry.name)) continue;

    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);

    if (ig.ignores(rel)) continue;

    if (entry.isDirectory()) {
      walk(root, abs, ig, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      out.push({ absolutePath: abs, relativePath: rel, size: stat.size });
    }
  }
}
