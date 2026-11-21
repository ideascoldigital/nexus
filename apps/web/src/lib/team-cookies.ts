// Shared sign-ins (spec 31), as Grok Bot does it: sign in on a site with one
// bot and every other bot can reach it too. Each bot keeps its own browser
// (they work in parallel), so sign-ins travel as cookies:
//
//   pull — read a computer's cookies over DevTools, keep only what changed in
//          *that* browser since we last looked (its own logins/logouts), and
//          fold that into the team store;
//   push — set the team store's cookies in every other awake computer, and in
//          each new one as it wakes.
//
// "Changed since we last looked" (a per-bot snapshot) is what stops a stale
// cookie in one browser from overwriting a fresh login made in another.
//
// The store is credentials: ~/.nexux/team-cookies.json, mode 0600, never logged.

import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@nexux/config";
import { getBotCookies, setBotCookies, type BotCookie } from "@nexux/sandbox";

// ---- Pure: keys, diffs, CDP params -------------------------------------------

/**
 * Sites that refuse a copied session: Google notices the same session rotating
 * in two browsers and signs the copy out (it is its defense against stolen
 * cookies). Their cookies never travel — each bot signs in on its own, and its
 * sign-in persists in its own browser profile. Pushing them would also break a
 * bot's own valid sign-in.
 */
const PERSONAL_DOMAINS = [
  /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, // google.com, google.com.co, google.co.uk…
  /(^|\.)youtube\.com$/,
  /(^|\.)gmail\.com$/,
  /(^|\.)googleusercontent\.com$/,
];

export function isShareable(c: Pick<BotCookie, "domain">): boolean {
  const d = c.domain.replace(/^\./, "").toLowerCase();
  return !PERSONAL_DOMAINS.some((re) => re.test(d));
}


export function cookieKey(c: Pick<BotCookie, "domain" | "name" | "path" | "partitionKey">): string {
  return `${c.domain}|${c.name}|${c.path}|${c.partitionKey ? JSON.stringify(c.partitionKey) : ""}`;
}

/** A cookie's identity + value, to notice changes without keeping values twice. */
function fingerprint(c: BotCookie): string {
  return `${c.value}|${c.expires}`;
}

export type Snapshot = Record<string, string>;

export function snapshotOf(cookies: BotCookie[]): Snapshot {
  const s: Snapshot = {};
  for (const c of cookies) s[cookieKey(c)] = fingerprint(c);
  return s;
}

/**
 * What one browser changed since its last snapshot: cookies it set or
 * updated, and keys it dropped (a logout, a cleared session).
 */
export function diffCookies(before: Snapshot, now: BotCookie[]): { upserts: BotCookie[]; removed: string[] } {
  const upserts: BotCookie[] = [];
  const seen = new Set<string>();
  for (const c of now.filter(isShareable)) {
    const k = cookieKey(c);
    seen.add(k);
    if (before[k] !== fingerprint(c)) upserts.push(c);
  }
  const removed = Object.keys(before).filter((k) => !seen.has(k) && isShareable({ domain: k.split("|")[0]! }));
  return { upserts, removed };
}

/**
 * DevTools Storage.setCookies params from a reported cookie (drops read-only
 * fields). Host-only cookies (domain without a leading dot — every __Host-
 * cookie, Google's sign-in ones among them) must be set by URL: given a
 * `domain` they would become domain cookies, which Chrome rejects for
 * __Host- names. That half-copied session is what Google then signs out.
 */
export function toCookieParam(c: BotCookie): Record<string, unknown> {
  const hostOnly = !c.domain.startsWith(".");
  const p: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    ...(hostOnly ? { url: `${c.secure ? "https" : "http"}://${c.domain}${c.path || "/"}` } : { domain: c.domain }),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (!c.session && c.expires > 0) p.expires = c.expires;
  if (c.sameSite) p.sameSite = c.sameSite;
  if (c.priority) p.priority = c.priority;
  if (c.sourceScheme) p.sourceScheme = c.sourceScheme;
  if (typeof c.sourcePort === "number") p.sourcePort = c.sourcePort;
  if (c.partitionKey) p.partitionKey = c.partitionKey;
  return p;
}

export type TeamStore = { cookies: Record<string, BotCookie> };

/**
 * Fold one browser's changes into the team store. Returns what other browsers
 * must apply. Only sign-ins and renewals travel — never removals: a site that
 * drops a session in one browser (a half-copied login, a security check)
 * must not sign every other bot out with it. Signing out of a site in one bot
 * therefore leaves the others signed in.
 */
export function applyChanges(
  team: TeamStore,
  changes: { upserts: BotCookie[]; removed: string[] },
  now = Date.now() / 1000,
): { set: Record<string, unknown>[]; changed: boolean } {
  const set: Record<string, unknown>[] = [];
  for (const c of changes.upserts) {
    const k = cookieKey(c);
    const prev = team.cookies[k];
    if (prev && fingerprint(prev) === fingerprint(c)) continue;
    team.cookies[k] = c;
    set.push(toCookieParam(c));
  }
  // Expired cookies — and sites that refuse shared sessions — have no business in the store.
  for (const [k, c] of Object.entries(team.cookies)) {
    if ((!c.session && c.expires > 0 && c.expires < now) || !isShareable(c)) {
      delete team.cookies[k];
    }
  }
  return { set, changed: set.length > 0 };
}

// ---- Store on disk -----------------------------------------------------------

const storePath = () => path.join(getConfig().dataDir, "team-cookies.json");
const snapshotPath = (botId: string) => path.join(getConfig().dataDir, "team-cookies-snapshots", `${botId}.json`);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function loadTeamStore(): TeamStore {
  return readJson<TeamStore>(storePath(), { cookies: {} });
}

// ---- With computers (DevTools over docker exec) -----------------------------

// One sync at a time: pulls and pushes read-modify-write the same store.
const g = globalThis as unknown as { nexuxCookieQueue?: Promise<unknown> };
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = (g.nexuxCookieQueue ?? Promise.resolve()).then(fn, fn);
  g.nexuxCookieQueue = next.catch(() => undefined);
  return next;
}

/** A computer just woke: give it the team's sign-ins, then remember what it has. */
export function seedComputer(
  botId: string,
  container: string,
  dockerHost: string | null = null,
): Promise<void> {
  return serial(async () => {
    const team = loadTeamStore();
    const now = Date.now() / 1000;
    const live = Object.values(team.cookies).filter(
      (c) => isShareable(c) && (c.session || c.expires <= 0 || c.expires > now),
    );
    const target = { host: dockerHost };
    await setBotCookies(container, live.map(toCookieParam), target);
    writePrivate(snapshotPath(botId), snapshotOf(await getBotCookies(container, target)));
  });
}

/**
 * Take what changed in one computer's browser into the team store and pass it
 * to the other awake computers. Returns how many cookies travelled.
 *
 * The team is not necessarily on one daemon (D-85): every computer carries the
 * host its container lives on, so a sign-in made on this machine reaches a
 * teammate on another one the same way.
 */
export function shareFromComputer(
  botId: string,
  container: string,
  others: { botId: string; container: string; dockerHost: string | null }[],
  dockerHost: string | null = null,
): Promise<number> {
  return serial(async () => {
    const before = readJson<Snapshot>(snapshotPath(botId), {});
    const now = await getBotCookies(container, { host: dockerHost });
    const team = loadTeamStore();
    const { set, changed } = applyChanges(team, diffCookies(before, now));
    writePrivate(snapshotPath(botId), snapshotOf(now));
    if (!changed) return 0;
    writePrivate(storePath(), team);
    for (const o of others) {
      try {
        const to = { host: o.dockerHost };
        await setBotCookies(o.container, set, to);
        // What we just gave it is not "its" change: fold it into its snapshot.
        const snap = readJson<Snapshot>(snapshotPath(o.botId), {});
        for (const c of await getBotCookies(o.container, to)) snap[cookieKey(c)] = fingerprint(c);
        writePrivate(snapshotPath(o.botId), snap);
      } catch (err) {
        console.warn(`[bots] could not share sign-ins with ${o.botId}:`, err instanceof Error ? err.message : err);
      }
    }
    return set.length;
  });
}

/** A bot is deleted: forget its snapshot (the team's sign-ins stay). */
export function removeCookieSnapshot(botId: string): void {
  fs.rmSync(snapshotPath(botId), { force: true });
}
