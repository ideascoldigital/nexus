// What survives a bot's computer (spec 31): the shared workspace and each
// bot's browser profile. On this machine both are host folders bind-mounted
// into every computer, so a bot that wakes up finds its files and its
// sign-ins, and bots see each other's work — like teammates on a shared drive.
//
// On another machine's daemon there is no folder of ours to mount (D-85), so
// the same two things live in named volumes on that daemon: they still outlive
// the computer and are still shared between bots there, just not on this disk
// and not visible in Finder.

import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@nexux/config";
import { BOT_CHROME_PROFILE, BOT_WORKSPACE } from "@nexux/sandbox";

/** ~/.nexux/workspace — mounted as /workspace in every bot's computer. */
export function workspaceRoot(): string {
  return path.join(getConfig().dataDir, "workspace");
}

/** ~/.nexux/bot-profiles/<botId> — one bot's Chromium profile (cookies, sign-ins). */
export function botProfileDir(botId: string): string {
  return path.join(getConfig().dataDir, "bot-profiles", botId);
}

/** A bot's own folder under the workspace: "Creative Designer" → "creative-designer". */
export function workspaceFolderFor(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "bot";
}

/** The bot's working directory inside its computer. */
export function botWorkdir(name: string): string {
  return `${BOT_WORKSPACE}/${workspaceFolderFor(name)}`;
}

/**
 * The workspace and profile as named volumes on the daemon that runs the
 * computer — the remote counterpart of `botMounts`. Docker reads a `-v` source
 * that is not an absolute path as a volume name and creates it on first use,
 * taking the image's ownership of that path, so there is no host side to
 * prepare. What there *is* no host side for is the bot's own folder under the
 * workspace, which `botMounts` makes with `mkdirSync`: the computer makes that
 * one itself before a prompt runs (`runBotPrompt`).
 *
 * The workspace volume is shared, like the folder it stands in for; the
 * profile is per bot, like its folder.
 */
export function botVolumes(bot: { id: string }): { host: string; container: string }[] {
  return [
    { host: "nexux-bot-workspace", container: BOT_WORKSPACE },
    { host: `nexux-bot-profile-${bot.id}`, container: BOT_CHROME_PROFILE },
  ];
}

/** Create the host folders and return the mounts for a bot's computer. */
export function botMounts(bot: { id: string; name: string }): { host: string; container: string }[] {
  const root = workspaceRoot();
  fs.mkdirSync(path.join(root, workspaceFolderFor(bot.name)), { recursive: true });
  const profile = botProfileDir(bot.id);
  fs.mkdirSync(profile, { recursive: true });
  return [
    { host: root, container: BOT_WORKSPACE },
    { host: profile, container: BOT_CHROME_PROFILE },
  ];
}

/** A bot is deleted: its sign-ins go with it. Its workspace folder stays — it is shared work. */
export function removeBotProfile(botId: string): void {
  fs.rmSync(botProfileDir(botId), { recursive: true, force: true });
}
