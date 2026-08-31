import path from "path";
import { getConfig } from "@nexux/config";
import { LocalFsStorage } from "./adapters/local";
import type { StorageAdapter } from "./adapter";

export type { StorageAdapter, FileStat, DirEntry } from "./adapter";
export { LocalFsStorage } from "./adapters/local";
export { ContextBuilder, type BrainConfig } from "./context-builder";

export function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  return path.join(getConfig().shell.home, p.slice(1));
}

let cached: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const { mode, dataDir } = getConfig();
  if (mode === "local") {
    cached = new LocalFsStorage(dataDir);
    return cached;
  }
  throw new Error(`Storage adapter for mode "${mode}" not implemented yet`);
}
