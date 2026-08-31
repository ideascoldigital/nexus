import fs from "fs/promises";
import path from "path";
import type { DirEntry, FileStat, StorageAdapter } from "../adapter";

export class LocalFsStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return path.isAbsolute(key) ? key : path.join(this.root, key);
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async readText(key: string): Promise<string> {
    return fs.readFile(this.resolve(key), "utf8");
  }

  async write(key: string, data: Buffer | string): Promise<void> {
    const filePath = this.resolve(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true, recursive: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<FileStat> {
    const s = await fs.lstat(this.resolve(key));
    return {
      size: s.size,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: s.isSymbolicLink(),
      mtime: s.mtime,
    };
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    try {
      return await fs.readdir(dir);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async listDetailed(prefix: string): Promise<DirEntry[]> {
    const dir = this.resolve(prefix);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      }));
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async mkdir(key: string): Promise<void> {
    await fs.mkdir(this.resolve(key), { recursive: true });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const link = this.resolve(linkPath);
    try {
      const s = await fs.lstat(link);
      if (s.isSymbolicLink()) {
        await fs.unlink(link);
      } else {
        throw new Error(
          `Cannot create symlink: ${link} exists and is not a symlink`,
        );
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
  }
}
