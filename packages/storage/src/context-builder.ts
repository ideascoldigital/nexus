import path from "path";
import { getConfig } from "@nexux/config";
import { LocalFsStorage } from "./adapters/local";

export interface BrainConfig {
  provider: string;
  model: string;
  config?: Record<string, unknown>;
}

export class ContextBuilder {
  private readonly storage: LocalFsStorage;
  private readonly projectsRoot: string;

  constructor(
    private readonly projectId: string,
    private readonly workspacePath: string,
  ) {
    const { dataDir } = getConfig();
    this.projectsRoot = path.join(dataDir, "projects");
    this.storage = new LocalFsStorage(this.projectsRoot);
  }

  private getProjectSlug(): string {
    return this.projectId.slice(0, 8);
  }

  private getContextRelative(): string {
    return path.join(this.getProjectSlug(), ".claude");
  }

  private getContextAbsolute(): string {
    return path.join(this.projectsRoot, this.getContextRelative());
  }

  async ensureContextDir(): Promise<string> {
    await this.storage.mkdir(this.getContextRelative());
    return this.getContextAbsolute();
  }

  async createSymlink(): Promise<void> {
    const target = this.getContextAbsolute();
    const linkPath = path.join(this.workspacePath, ".claude");

    const linkStorage = new LocalFsStorage(path.dirname(linkPath));
    const linkName = path.basename(linkPath);

    if (await linkStorage.exists(linkName)) {
      const stat = await linkStorage.stat(linkName);
      if (stat.isSymlink) {
        await linkStorage.delete(linkName);
      } else {
        console.warn(
          `[ContextBuilder] .claude already exists and is not a symlink`,
        );
        return;
      }
    }

    await linkStorage.symlink(target, linkName);
  }

  async writeConfig(brain: BrainConfig): Promise<void> {
    await this.ensureContextDir();
    const rel = path.join(this.getContextRelative(), "config.json");
    await this.storage.write(rel, JSON.stringify(brain, null, 2));
  }

  async writeSystemPrompt(content: string): Promise<void> {
    await this.ensureContextDir();
    const rel = path.join(this.getContextRelative(), "system.md");
    await this.storage.write(rel, content);
  }

  async buildInitialContext(brain: BrainConfig): Promise<void> {
    await this.ensureContextDir();
    await this.writeConfig(brain);
    await this.writeSystemPrompt(
      `# Brain: ${brain.provider} - ${brain.model}\n\nThis is the system context for this project.`,
    );
    await this.createSymlink();
  }
}
