// Reading a project's own folders for the project chat (spec 39): list a
// folder or read a text file inside one of the project's repositories —
// nothing outside them (symlinks resolved), and never what holds secrets
// (.env files, private keys, credential files, .git internals). Read-only.

import fs from "node:fs/promises";
import path from "node:path";

export const MAX_READ_BYTES = 200 * 1024;
const MAX_ENTRIES = 500;

/** Files whose content is a secret: listed (marked), never read. Pure. */
export function isSecretFile(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  if (parts.includes(".git")) return true;
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks|ppk|kdbx|tfstate|tfvars)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true;
  return [
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".pgpass",
    ".htpasswd",
    "credentials",
    "credentials.json",
    "serviceaccountkey.json",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml",
    ".dockercfg",
    "auth.json",
  ].includes(name);
}

export class ProjectFileError extends Error {}

/**
 * `rel` inside `root`, with every symlink resolved; throws when it leaves the
 * root or does not exist.
 */
export async function resolveInside(root: string, rel: string): Promise<{ abs: string; rel: string }> {
  if (rel.includes("\0")) throw new ProjectFileError("Bad path");
  const realRoot = await fs.realpath(root).catch(() => {
    throw new ProjectFileError("The repository's folder is not on this machine");
  });
  const wanted = path.resolve(realRoot, rel.replace(/^[/\\]+/, ""));
  const real = await fs.realpath(wanted).catch(() => {
    throw new ProjectFileError(`"${rel}" does not exist`);
  });
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ProjectFileError("That path is outside the project");
  }
  return { abs: real, rel: path.relative(realRoot, real) || "." };
}

export type ProjectFileEntry = { name: string; dir: boolean; size: number; secret?: true };

export async function listProjectDir(root: string, rel: string) {
  const { abs, rel: clean } = await resolveInside(root, rel || ".");
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) throw new ProjectFileError(`"${clean}" is a file; read it instead`);
  if (clean !== "." && isSecretFile(clean)) throw new ProjectFileError("That folder is not shown here");
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: ProjectFileEntry[] = [];
  for (const d of dirents.slice(0, MAX_ENTRIES)) {
    const childRel = clean === "." ? d.name : path.join(clean, d.name);
    const dir = d.isDirectory();
    const size = dir ? 0 : await fs.stat(path.join(abs, d.name)).then((s) => s.size).catch(() => 0);
    entries.push({ name: d.name, dir, size, ...(isSecretFile(childRel) ? { secret: true as const } : {}) });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { path: clean, entries, truncated: dirents.length > MAX_ENTRIES };
}

export async function readProjectFile(root: string, rel: string) {
  const { abs, rel: clean } = await resolveInside(root, rel);
  if (isSecretFile(clean)) throw new ProjectFileError(`"${clean}" may hold secrets, so it is not shown here`);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new ProjectFileError(`"${clean}" is a folder; list it instead`);
  const handle = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    await handle.read(buf, 0, buf.length, 0);
    if (buf.includes(0)) return { path: clean, size: stat.size, binary: true as const };
    return { path: clean, size: stat.size, content: buf.toString("utf8"), truncated: stat.size > MAX_READ_BYTES };
  } finally {
    await handle.close();
  }
}

/** A chunk the chat can take in one go: Claude Code moves a bigger tool result to a file it then cannot open. */
export const CHAT_CHUNK_BYTES = 12 * 1024;
const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/**
 * Lines `offset`.. of a text file (1-based), as many as fit in one chat-sized
 * chunk (at most `limit`), numbered so the chat can say where it is.
 */
export async function readProjectFileLines(root: string, rel: string, offset = 1, limit = 2000) {
  const { abs, rel: clean } = await resolveInside(root, rel);
  if (isSecretFile(clean)) throw new ProjectFileError(`"${clean}" may hold secrets, so it is not shown here`);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new ProjectFileError(`"${clean}" is a folder; list it instead`);
  if (stat.size > MAX_EDIT_BYTES) throw new ProjectFileError(`"${clean}" is too big to read (${stat.size} bytes)`);
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) return { path: clean, size: stat.size, binary: true as const };
  const lines = buf.toString("utf8").split("\n");
  const start = Math.max(1, Math.floor(offset));
  const out: string[] = [];
  let bytes = 0;
  for (let i = start - 1; i < lines.length && out.length < Math.max(1, limit); i++) {
    const line = `${i + 1}\t${lines[i]}`;
    if (out.length > 0 && bytes + line.length > CHAT_CHUNK_BYTES) break;
    out.push(line);
    bytes += line.length + 1;
  }
  const end = start + out.length - 1;
  return {
    path: clean,
    totalLines: lines.length,
    fromLine: start,
    toLine: end,
    ...(end < lines.length ? { next: `call again with offset ${end + 1} for the rest` } : {}),
    content: out.join("\n"),
  };
}

/** Where a file may be written: inside the root, not a secret, its nearest existing folder inside too. */
async function writableTarget(root: string, rel: string): Promise<{ abs: string; rel: string }> {
  if (rel.includes("\0") || !rel.trim()) throw new ProjectFileError("Bad path");
  const realRoot = await fs.realpath(root).catch(() => {
    throw new ProjectFileError("The repository's folder is not on this machine");
  });
  const wanted = path.resolve(realRoot, rel.replace(/^[/\\]+/, ""));
  const clean = path.relative(realRoot, wanted);
  if (clean.startsWith("..") || path.isAbsolute(clean) || !clean) throw new ProjectFileError("That path is outside the project");
  if (isSecretFile(clean)) throw new ProjectFileError(`"${clean}" may hold secrets, so it cannot be written from here`);
  // An existing file (or symlink) must really be inside; a new one's nearest existing folder must be.
  let probe = wanted;
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real) {
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new ProjectFileError("That path is outside the project");
      if (probe === wanted && (await fs.stat(real)).isDirectory()) throw new ProjectFileError(`"${clean}" is a folder`);
      return { abs: probe === wanted ? real : wanted, rel: clean };
    }
    probe = path.dirname(probe);
  }
}

/** Create or overwrite a text file inside the project (folders made as needed). */
export async function writeProjectFile(root: string, rel: string, content: string) {
  if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new ProjectFileError("That content is too big");
  const { abs, rel: clean } = await writableTarget(root, rel);
  const existed = await fs.stat(abs).then(() => true).catch(() => false);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { path: clean, created: !existed, bytes: Buffer.byteLength(content) };
}

/** Replace exact text in a file: once (it must be unique) or everywhere with `all`. */
export async function editProjectFile(root: string, rel: string, oldText: string, newText: string, all = false) {
  if (!oldText) throw new ProjectFileError("oldText must not be empty");
  if (oldText === newText) throw new ProjectFileError("oldText and newText are the same");
  const { abs, rel: clean } = await writableTarget(root, rel);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new ProjectFileError(`"${clean}" does not exist; write it instead`);
  if (stat.size > MAX_EDIT_BYTES) throw new ProjectFileError(`"${clean}" is too big to edit`);
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new ProjectFileError(`"${clean}" is a binary file`);
  const text = buf.toString("utf8");
  const count = text.split(oldText).length - 1;
  if (count === 0) throw new ProjectFileError(`oldText was not found in "${clean}" — read the file again and copy it exactly`);
  if (count > 1 && !all) {
    throw new ProjectFileError(`oldText appears ${count} times in "${clean}" — add surrounding lines to make it unique, or pass all: true`);
  }
  await fs.writeFile(abs, all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText), "utf8");
  return { path: clean, replaced: all ? count : 1 };
}
