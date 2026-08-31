/**
 * ClickUp Service
 *
 * OAuth2 (authorization code) integration with ClickUp. The user creates a
 * ClickUp OAuth app once (Settings → Integrations → ClickUp API), pastes its
 * client id/secret here, and from then on connecting an account is a single
 * "Connect" click that round-trips through ClickUp's consent screen.
 *
 * Storage: app credentials in Settings (clickup_client_id /
 * clickup_client_secret), accounts in ConnectedAccount (providerType
 * "clickup", authMode "oauth") + OAuthToken, in-flight CSRF nonces in
 * OAuthState. ClickUp access tokens currently do not expire.
 */

import { randomBytes } from "crypto";
import { prisma } from "@nexux/db";

const CLICKUP_API = "https://api.clickup.com/api/v2";
export const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";

const CLIENT_ID_KEY = "clickup_client_id";
const CLIENT_SECRET_KEY = "clickup_client_secret";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface ClickUpUser {
  id: number;
  username: string;
  email: string;
  color: string | null;
  profilePicture: string | null;
  initials: string | null;
}

/** A type alias, not an interface: this lands in `metadata`, and Prisma's
 *  `InputJsonValue` rejects interfaces (declaration merging means they carry
 *  no index signature). */
export type ClickUpTeam = {
  id: string;
  name: string;
  color: string | null;
  avatar: string | null;
};

// ─── Low-level ClickUp API helper ───────────────────────────────────────────

async function clickupFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${CLICKUP_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { err?: string };
    throw new Error(err.err || `ClickUp API error ${res.status}: ${path}`);
  }

  return res.json() as Promise<T>;
}

// ─── OAuth app credentials (Settings) ───────────────────────────────────────

export async function getClickUpApp(): Promise<{
  clientId: string;
  clientSecret: string;
} | null> {
  const rows = await prisma.settings.findMany({
    where: { key: { in: [CLIENT_ID_KEY, CLIENT_SECRET_KEY] }, isActive: true },
  });
  const clientId = rows.find((r) => r.key === CLIENT_ID_KEY)?.value;
  const clientSecret = rows.find((r) => r.key === CLIENT_SECRET_KEY)?.value;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function saveClickUpApp(clientId: string, clientSecret: string) {
  const upsert = (key: string, value: string) =>
    prisma.settings.upsert({
      where: { key },
      create: { key, value, provider: "clickup", isActive: true },
      update: { value, isActive: true },
    });
  await prisma.$transaction([
    upsert(CLIENT_ID_KEY, clientId),
    upsert(CLIENT_SECRET_KEY, clientSecret),
  ]);
}

// ─── OAuth flow ─────────────────────────────────────────────────────────────

/** Create a CSRF nonce for one authorize round-trip (also prunes stale ones). */
export async function createOAuthState(returnUrl: string): Promise<string> {
  await prisma.oAuthState.deleteMany({
    where: { provider: "clickup", expiresAt: { lt: new Date() } },
  });
  const state = randomBytes(24).toString("hex");
  await prisma.oAuthState.create({
    data: {
      state,
      provider: "clickup",
      returnUrl,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  return state;
}

/** Validate + single-use consume a state nonce. Returns its returnUrl. */
export async function consumeOAuthState(state: string): Promise<string> {
  const row = await prisma.oAuthState.findUnique({ where: { state } });
  if (!row || row.provider !== "clickup") {
    throw new Error("Invalid OAuth state — please retry the connection.");
  }
  await prisma.oAuthState.delete({ where: { id: row.id } });
  if (row.expiresAt < new Date()) {
    throw new Error("OAuth state expired — please retry the connection.");
  }
  return row.returnUrl ?? "/settings?tab=integrations";
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const app = await getClickUpApp();
  if (!app) throw new Error("ClickUp OAuth app is not configured.");

  const res = await fetch(`${CLICKUP_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { err?: string };
    throw new Error(err.err || `ClickUp token exchange failed (${res.status})`);
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("ClickUp token exchange returned no access token.");
  }
  return json.access_token;
}

// ─── Account management ─────────────────────────────────────────────────────

async function fetchTeams(accessToken: string): Promise<ClickUpTeam[]> {
  const { teams } = await clickupFetch<{ teams: ClickUpTeam[] }>(accessToken, "/team");
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    avatar: t.avatar,
  }));
}

/**
 * Authorized workspaces, read live. The workspace picker calls this rather
 * than reading the snapshot in `metadata.teams`: a single failed `/team` at
 * connect time used to persist `[]` and leave the account looking connected
 * while importing nothing. See D-54.
 */
export async function listTeams(accountId: string): Promise<ClickUpTeam[]> {
  return fetchTeams(await getTokenForAccount(accountId));
}

async function fetchIdentity(accessToken: string) {
  const { user } = await clickupFetch<{ user: ClickUpUser }>(accessToken, "/user");
  // Still non-fatal — the token is what matters, and nothing depends on this
  // copy any more. But it is logged: silence here is what made a one-off
  // failure look like an account with no workspaces.
  const teams = await fetchTeams(accessToken).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[clickup] /team failed while reading identity:", message);
    return [] as ClickUpTeam[];
  });
  return {
    userId: user.id,
    username: user.username,
    email: user.email,
    profilePicture: user.profilePicture,
    color: user.color,
    initials: user.initials,
    teams,
  };
}

/**
 * Finish the OAuth flow: validate the token against /user and create or
 * update the ConnectedAccount (de-duped by ClickUp user id).
 */
export async function connectClickUpAccount(accessToken: string) {
  const metadata = await fetchIdentity(accessToken);

  const accounts = await prisma.connectedAccount.findMany({
    where: { providerType: "clickup" },
    include: { oauthTokens: true },
  });
  const existing = accounts.find(
    (a) => (a.metadata as { userId?: number } | null)?.userId === metadata.userId
  );

  if (existing) {
    await prisma.connectedAccount.update({
      where: { id: existing.id },
      data: {
        status: "connected",
        lastCheckedAt: new Date(),
        metadata,
      },
    });
    if (existing.oauthTokens.length > 0) {
      await prisma.oAuthToken.update({
        where: { id: existing.oauthTokens[0].id },
        data: { accessToken },
      });
    } else {
      await prisma.oAuthToken.create({
        data: { accountId: existing.id, accessToken },
      });
    }
    return prisma.connectedAccount.findUnique({ where: { id: existing.id } });
  }

  return prisma.connectedAccount.create({
    data: {
      providerType: "clickup",
      category: "integration",
      label: metadata.username,
      authMode: "oauth",
      status: "connected",
      lastCheckedAt: new Date(),
      metadata,
      oauthTokens: { create: { accessToken } },
    },
  });
}

export async function listClickUpAccounts() {
  return prisma.connectedAccount.findMany({
    where: { providerType: "clickup" },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteClickUpAccount(accountId: string) {
  return prisma.connectedAccount.delete({ where: { id: accountId } });
}

export async function getTokenForAccount(accountId: string): Promise<string> {
  const token = await prisma.oAuthToken.findFirst({
    where: { accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!token) throw new Error("No token found for this ClickUp account");
  return token.accessToken;
}

// ─── Hierarchy (workspaces → spaces → lists) ────────────────────────────────

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpListSummary {
  id: string;
  name: string;
  folderName: string | null;
  taskCount: number | null;
}

export async function listSpaces(
  accountId: string,
  teamId: string
): Promise<ClickUpSpace[]> {
  const token = await getTokenForAccount(accountId);
  const { spaces } = await clickupFetch<{ spaces: { id: string; name: string }[] }>(
    token,
    `/team/${teamId}/space?archived=false`
  );
  return spaces.map((s) => ({ id: s.id, name: s.name }));
}

/** All lists of a space, flattened: foldered (labelled) + folderless. */
export async function listLists(
  accountId: string,
  spaceId: string
): Promise<ClickUpListSummary[]> {
  const token = await getTokenForAccount(accountId);

  type RawList = { id: string; name: string; task_count?: number | null };
  const [{ folders }, { lists }] = await Promise.all([
    clickupFetch<{ folders: { name: string; lists: RawList[] }[] }>(
      token,
      `/space/${spaceId}/folder?archived=false`
    ),
    clickupFetch<{ lists: RawList[] }>(token, `/space/${spaceId}/list?archived=false`),
  ]);

  const toSummary = (l: RawList, folderName: string | null): ClickUpListSummary => ({
    id: l.id,
    name: l.name,
    folderName,
    taskCount: l.task_count ?? null,
  });

  return [
    ...folders.flatMap((f) => f.lists.map((l) => toSummary(l, f.name))),
    ...lists.map((l) => toSummary(l, null)),
  ];
}

// ─── Task sync (ClickUp → local cache) ──────────────────────────────────────

interface RawClickUpTask {
  id: string;
  name: string;
  description: string | null;
  status: { status: string; type: string } | null;
  priority: { priority: string } | null;
  due_date: string | null;
  url: string;
  assignees: { username: string }[];
  tags: { name: string }[];
  parent: string | null;
  list: { id: string; name: string } | null;
  folder: { id: string } | null;
  space: { id: string } | null;
}

/**
 * Fetch a list's tasks (all pages, subtasks and closed included) and upsert
 * them into the local cache — the same shape as GitHub's syncIssues.
 */
export async function syncTasks(
  accountId: string,
  teamId: string,
  listId: string
) {
  const token = await getTokenForAccount(accountId);

  const tasks: RawClickUpTask[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await clickupFetch<{ tasks: RawClickUpTask[]; last_page?: boolean }>(
      token,
      `/list/${listId}/task?page=${page}&include_closed=true&subtasks=true`
    );
    tasks.push(...res.tasks);
    if (res.last_page !== false || res.tasks.length === 0) break;
  }

  const upserts = tasks.map((t) => {
    const data = {
      teamId,
      spaceId: t.space?.id ?? null,
      folderId: t.folder?.id ?? null,
      listId: t.list?.id ?? listId,
      listName: t.list?.name ?? null,
      name: t.name,
      description: t.description?.trim() || null,
      status: t.status?.status ?? null,
      statusType: t.status?.type ?? null,
      priority: t.priority?.priority ?? null,
      dueDate: t.due_date ? new Date(Number(t.due_date)) : null,
      url: t.url,
      assignees: t.assignees.map((a) => a.username),
      tags: t.tags.map((tag) => tag.name),
      parentTaskId: t.parent,
      syncedAt: new Date(),
    };
    return prisma.clickUpTask.upsert({
      where: { accountId_taskId: { accountId, taskId: t.id } },
      create: { accountId, taskId: t.id, ...data },
      update: data,
    });
  });

  await prisma.$transaction(upserts);
  return { synced: tasks.length, listId };
}

/** Cached tasks from the DB (with optional search / closed filter). */
export async function getLocalTasks(
  accountId: string,
  listId: string,
  opts: { search?: string; includeClosed?: boolean } = {}
) {
  return prisma.clickUpTask.findMany({
    where: {
      accountId,
      listId,
      ...(opts.includeClosed ? {} : { NOT: { statusType: "closed" } }),
      ...(opts.search ? { name: { contains: opts.search } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

// ─── Feature ↔ task linking ─────────────────────────────────────────────────

export async function linkTaskToFeature(featureId: string, taskId: string) {
  return prisma.featureClickUpTask.upsert({
    where: { featureId_taskId: { featureId, taskId } },
    create: { featureId, taskId },
    update: {},
  });
}

export async function unlinkTaskFromFeature(featureId: string, taskId: string) {
  return prisma.featureClickUpTask.delete({
    where: { featureId_taskId: { featureId, taskId } },
  });
}

export async function getTasksForFeature(featureId: string) {
  return prisma.featureClickUpTask.findMany({
    where: { featureId },
    include: { task: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Re-hit /user and flip the account's status accordingly. */
export async function revalidateClickUpAccount(accountId: string) {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: accountId },
  });
  if (!account || account.providerType !== "clickup") {
    throw new Error("ClickUp account not found");
  }

  try {
    const accessToken = await getTokenForAccount(accountId);
    const metadata = await fetchIdentity(accessToken);
    return await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { status: "connected", lastCheckedAt: new Date(), metadata },
    });
  } catch {
    return await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { status: "error", lastCheckedAt: new Date() },
    });
  }
}
