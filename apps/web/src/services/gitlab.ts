/**
 * GitLab Service
 *
 * Issue import for gitlab.com *and* self-hosted instances. Mirrors
 * `services/github.ts`, with two differences that come from the ask:
 *
 * - An account carries the instance it belongs to (`metadata.baseUrl`), so a
 *   single Nexus install can talk to gitlab.com and any number of company
 *   servers at once. Every call is built from that base, never a constant.
 * - The token can come from a saved git `CloudCredential` instead of a pasted
 *   PAT. Most users already added a GitLab token to clone with; making them
 *   mint a second one just to read issues is busywork, and both need the same
 *   `api`/`read_api` scope. `metadata.credentialId` names it; a pasted PAT
 *   still lands in `OAuthToken` the way GitHub's does.
 */

import { prisma } from "@nexux/db";

/** A `ConnectedAccount` row, as Prisma hands it back. */
type ConnectedAccountRow = Awaited<
  ReturnType<typeof prisma.connectedAccount.findUniqueOrThrow>
>;

export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  visibility: string;
  web_url: string;
  open_issues_count?: number;
  last_activity_at: string;
}

export interface GitLabIssueRaw {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  author: { username: string; name: string; avatar_url: string } | null;
  assignees: { username: string }[];
  labels: string[];
  milestone: { title: string } | null;
  closed_at: string | null;
  created_at: string;
  /** issue | incident | test_case | task — GitLab's work-item flavour. */
  issue_type?: string;
  /**
   * Only on group- and epic-scoped listings, where issues come from many
   * projects at once: `references.full` is `group/sub/project#12`, which is the
   * project path without a second lookup per issue.
   */
  references?: { short?: string; relative?: string; full?: string };
  /** Present when the issue hangs off an epic — possibly one in another group. */
  epic?: { id: number; iid: number; title: string; group_id: number } | null;
}

export interface GitLabGroup {
  id: number;
  name: string;
  full_path: string;
  full_name?: string;
  description: string | null;
  web_url: string;
  parent_id: number | null;
}

export interface GitLabEpicRaw {
  /** Global id — the only stable handle, since `iid` repeats across groups. */
  id: number;
  iid: number;
  group_id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  labels: string[];
  author: { username: string } | null;
  start_date: string | null;
  due_date: string | null;
  closed_at: string | null;
  created_at: string;
  references?: { full?: string };
}

export interface GitLabUser {
  username: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
  web_url: string;
}

/** What a GitLab account's `metadata` column holds. */
export interface GitLabAccountMetadata {
  /** Instance origin, no trailing slash and no `/api/v4` — e.g. `https://gitlab.acme.dev`. */
  baseUrl: string;
  /** Saved git credential the token is read from, when not a pasted PAT. */
  credentialId?: string | null;
  username?: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  web_url?: string;
}

// ─── Instance URLs ──────────────────────────────────────────────────────────

/**
 * A user-typed instance URL reduced to a bare origin (plus a subpath, for the
 * installs that live under one).
 *
 * People paste what their browser shows: a trailing slash, the `/api/v4`
 * suffix they read in the docs, or a bare `gitlab.acme.dev` with no scheme.
 * All three mean the same instance, and all three build a broken API URL if
 * concatenated as-is.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A GitLab URL is required");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid GitLab URL: ${input}`);
  }
  if (!url.hostname) throw new Error(`Not a valid GitLab URL: ${input}`);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
  return `${url.origin}${path}`;
}

// ─── Low-level GitLab API helpers ───────────────────────────────────────────

/**
 * Why `fetch` threw, as specifically as the runtime will say.
 *
 * undici collapses every transport failure into the same `TypeError: fetch
 * failed` and hides the real reason one level down in `cause` — sometimes two,
 * for a TLS error inside a connect error. A message that drops that chain can
 * only guess, and guessing "check the URL" sends people to re-check a URL that
 * was right all along while the actual problem (an untrusted certificate, a
 * VPN that is down) goes unmentioned.
 */
function describeFetchFailure(cause: unknown): string {
  const chain: string[] = [];
  let code: string | undefined;
  let err: unknown = cause;
  for (let depth = 0; depth < 5 && err instanceof Error; depth++) {
    const errno = (err as NodeJS.ErrnoException).code;
    code ??= errno;
    chain.push(errno ? `${errno} ${err.message}` : err.message);
    err = (err as { cause?: unknown }).cause;
  }
  const detail = chain.join(" — ") || String(cause);

  // The one failure whose fix is not guessable from the message: a corporate
  // instance behind a private CA. Node trusts its own bundle only.
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return `${detail}. The certificate is not trusted by Node — point NODE_EXTRA_CA_CERTS at your CA bundle and restart Nexus.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${detail}. The hostname does not resolve from this machine.`;
  }
  return detail;
}

/** Failures that will fail again immediately — retrying only wastes the wait. */
function isPermanent(cause: unknown): boolean {
  let err: unknown = cause;
  for (let depth = 0; depth < 5 && err instanceof Error; depth++) {
    const code = (err as NodeJS.ErrnoException).code;
    // An untrusted certificate or a refused connection is a standing fact
    // about the machine, not a blip.
    if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ECONNREFUSED/i.test(code)) {
      return true;
    }
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One request, retried twice on a transport failure.
 *
 * Not gold-plating: on the network this was built against, `getaddrinfo`
 * returned REFUSED for roughly three of every five lookups, and a paged sync
 * makes ten or more requests — so a single flaky resolution killed the whole
 * import and reported it as an unreachable instance. Only the transport is
 * retried; an HTTP status is an answer from GitLab and gets reported as-is,
 * which also keeps a 401 from being hammered three times.
 */
async function fetchWithRetry(
  url: string,
  token: string,
  attempts = 3,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          "PRIVATE-TOKEN": token,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch (cause) {
      last = cause;
      if (isPermanent(cause) || attempt === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }
  throw last;
}

/**
 * One GitLab REST call.
 *
 * `PRIVATE-TOKEN` rather than `Authorization: Bearer` — it is the header a
 * personal access token is documented for, and it also works for project and
 * group access tokens, which is what a shared "CI bot" credential usually is.
 */
async function gitlabFetch<T>(
  baseUrl: string,
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<{ data: T; nextPage: number | null }> {
  const url = new URL(`${baseUrl}/api/v4${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  let res: Response;
  try {
    res = await fetchWithRetry(url.toString(), token);
  } catch (cause) {
    // A self-hosted instance that is only reachable on a VPN fails here, and
    // the bare "fetch failed" says neither which host was tried nor why.
    throw new Error(
      `Could not reach ${baseUrl}: ${describeFetchFailure(cause)}`,
      { cause },
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    const detail =
      typeof body.message === "string"
        ? body.message
        : typeof body.error_description === "string"
          ? body.error_description
          : typeof body.error === "string"
            ? body.error
            : null;
    if (res.status === 401) {
      throw new Error(
        detail ?? "Invalid or expired GitLab token (401 Unauthorized)",
      );
    }
    if (res.status === 404) {
      throw new Error(
        detail ??
          `Not found on ${baseUrl}: ${path} — the token may not have access to it.`,
      );
    }
    throw new Error(detail ?? `GitLab API error ${res.status}: ${path}`);
  }

  // GitLab paginates with headers, not a cursor in the body. `x-next-page` is
  // an empty string on the last page.
  const next = res.headers.get("x-next-page");
  return {
    data: (await res.json()) as T,
    nextPage: next ? Number(next) || null : null,
  };
}

/** Follow `x-next-page` until the list runs out (or `maxPages` is hit). */
async function gitlabFetchAll<T>(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string> = {},
  maxPages = 10,
): Promise<T[]> {
  const all: T[] = [];
  let page: number | null = 1;
  for (let i = 0; i < maxPages && page; i++) {
    const res: { data: T[]; nextPage: number | null } = await gitlabFetch<T[]>(
      baseUrl,
      token,
      path,
      { per_page: "100", ...params, page: String(page) },
    );
    all.push(...res.data);
    page = res.nextPage;
  }
  return all;
}

// ─── Account + token resolution ─────────────────────────────────────────────

function metadataOf(account: { metadata: unknown }): GitLabAccountMetadata {
  return (account.metadata ?? {}) as GitLabAccountMetadata;
}

/** The instance and token to call with, for one saved server. */
export async function getGitLabAuth(
  accountId: string,
): Promise<{ baseUrl: string; token: string }> {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: accountId },
  });
  if (!account || account.providerType !== "gitlab") {
    throw new Error("GitLab server not found");
  }
  const meta = metadataOf(account);
  if (!meta.baseUrl) {
    throw new Error("This GitLab server has no URL configured");
  }

  if (meta.credentialId) {
    const credential = await prisma.cloudCredential.findUnique({
      where: { id: meta.credentialId },
    });
    const token = (credential?.data as { token?: string } | null)?.token;
    if (!token) {
      throw new Error(
        "The saved GitLab credential this server uses is gone or has no token — re-link it in Settings.",
      );
    }
    return { baseUrl: meta.baseUrl, token };
  }

  const stored = await prisma.oAuthToken.findFirst({
    where: { accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!stored) throw new Error("No token found for this GitLab server");
  return { baseUrl: meta.baseUrl, token: stored.accessToken };
}

/** Ask the instance who the token belongs to — the validation step. */
export async function fetchGitLabUser(
  baseUrl: string,
  token: string,
): Promise<GitLabUser> {
  const { data } = await gitlabFetch<GitLabUser>(baseUrl, token, "/user");
  return data;
}

/**
 * Register a GitLab server, validating the token against it first.
 *
 * `credentialId` and `token` are the two ways in: one reuses a credential
 * already saved for cloning, the other pastes a PAT.
 *
 * A server is identified by (instance, token source) — not by (instance, user).
 * One person routinely holds several tokens on one instance (a personal one and
 * a scoped bot one, say), and keying on the login alone made the second "Add
 * server" silently overwrite the first: same label box, same instance, one row.
 * A saved credential is its own handle, so re-picking it updates that server in
 * place; a pasted PAT has no handle, so the login stands in for one, which is
 * also what `addGitHubAccount` does.
 */
export async function addGitLabAccount(input: {
  baseUrl: string;
  label: string;
  token?: string;
  credentialId?: string;
}): Promise<{ account: ConnectedAccountRow; created: boolean }> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);

  let token = input.token?.trim();
  if (input.credentialId) {
    const credential = await prisma.cloudCredential.findUnique({
      where: { id: input.credentialId },
    });
    if (!credential) throw new Error("Saved credential not found");
    if (credential.provider !== "gitlab") {
      throw new Error(
        `"${credential.name}" is a ${credential.provider} credential — pick a GitLab one.`,
      );
    }
    token = (credential.data as { token?: string } | null)?.token;
    if (!token) throw new Error("That credential has no token stored");
  }
  if (!token) {
    throw new Error(
      "Provide a personal access token or pick a saved GitLab credential",
    );
  }

  const user = await fetchGitLabUser(baseUrl, token);

  const metadata: GitLabAccountMetadata = {
    baseUrl,
    credentialId: input.credentialId ?? null,
    username: user.username,
    name: user.name,
    avatar_url: user.avatar_url,
    email: user.email,
    web_url: user.web_url,
  };

  const existing = (
    await prisma.connectedAccount.findMany({
      where: { providerType: "gitlab" },
    })
  ).find((a) => {
    const m = metadataOf(a);
    if (m.baseUrl !== baseUrl) return false;
    return input.credentialId
      ? m.credentialId === input.credentialId
      : !m.credentialId && m.username === user.username;
  });

  if (existing) {
    await prisma.connectedAccount.update({
      where: { id: existing.id },
      data: {
        label: input.label,
        status: "connected",
        lastCheckedAt: new Date(),
        metadata: { ...metadata },
      },
    });
    // Re-pasting a PAT is how a rotated token gets in, so the old one goes.
    // A credential-backed server stores none at all: the secret lives in the
    // credential, and a copy here would be a second thing to rotate.
    await prisma.oAuthToken.deleteMany({ where: { accountId: existing.id } });
    if (!input.credentialId) {
      await prisma.oAuthToken.create({
        data: { accountId: existing.id, accessToken: token },
      });
    }
    return {
      account: await prisma.connectedAccount.findUniqueOrThrow({
        where: { id: existing.id },
      }),
      created: false,
    };
  }

  return {
    account: await prisma.connectedAccount.create({
      data: {
        providerType: "gitlab",
        category: "integration",
        label: input.label,
        authMode: "pat",
        status: "connected",
        lastCheckedAt: new Date(),
        metadata: { ...metadata },
        ...(input.credentialId
          ? {}
          : { oauthTokens: { create: { accessToken: token } } }),
      },
    }),
    created: true,
  };
}

export async function listGitLabAccounts() {
  return prisma.connectedAccount.findMany({
    where: { providerType: "gitlab" },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteGitLabAccount(accountId: string) {
  return prisma.connectedAccount.delete({ where: { id: accountId } });
}

/** Re-check a saved server's token and refresh the user snapshot. */
export async function revalidateGitLabAccount(accountId: string) {
  const account = await prisma.connectedAccount.findUnique({
    where: { id: accountId },
  });
  if (!account || account.providerType !== "gitlab") {
    throw new Error("GitLab server not found");
  }

  try {
    const { baseUrl, token } = await getGitLabAuth(accountId);
    const user = await fetchGitLabUser(baseUrl, token);
    return await prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        status: "connected",
        lastCheckedAt: new Date(),
        metadata: {
          ...metadataOf(account),
          username: user.username,
          name: user.name,
          avatar_url: user.avatar_url,
          email: user.email,
          web_url: user.web_url,
        },
      },
    });
  } catch (error) {
    await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { status: "error", lastCheckedAt: new Date() },
    });
    throw error;
  }
}

// ─── Projects ───────────────────────────────────────────────────────────────

/**
 * Projects the token can see, newest activity first.
 *
 * `membership=true` rather than `owned=true`: on a company server the
 * interesting repos usually belong to a group the user is only a developer on.
 * Search runs server-side because an instance with thousands of projects would
 * not fit in the handful of pages fetched below.
 */
export async function listProjectsForAccount(
  accountId: string,
  search?: string,
): Promise<GitLabProject[]> {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const query = search?.trim();
  return gitlabFetchAll<GitLabProject>(
    baseUrl,
    token,
    "/projects",
    {
      membership: "true",
      archived: "false",
      simple: "true",
      order_by: "last_activity_at",
      with_issues_enabled: "true",
      ...(query ? { search: query } : {}),
    },
    query ? 2 : 5,
  );
}

/** One project by numeric id or `group/subgroup/project` path. */
export async function getGitLabProject(
  accountId: string,
  idOrPath: string,
): Promise<GitLabProject> {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const { data } = await gitlabFetch<GitLabProject>(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(idOrPath)}`,
  );
  return data;
}

// ─── Issues ─────────────────────────────────────────────────────────────────

export async function fetchIssuesFromGitLab(
  accountId: string,
  projectId: number,
  state: "opened" | "closed" | "all" = "all",
): Promise<GitLabIssueRaw[]> {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  return gitlabFetchAll<GitLabIssueRaw>(
    baseUrl,
    token,
    `/projects/${projectId}/issues`,
    {
      ...(state === "all" ? {} : { state }),
      order_by: "updated_at",
      // Confidential issues are part of the backlog for anyone who can see
      // them, and the token's own permissions already decide what comes back.
      scope: "all",
    },
  );
}

/**
 * `group/sub/project` for one issue.
 *
 * A project-scoped sync knows the path already; a group- or epic-scoped one
 * gets issues from many projects at once and reads it out of `references.full`
 * (`operators/operator-central#312`), which is the only place the payload
 * carries it — there is no `project` object on those listings.
 */
function projectPathOf(issue: GitLabIssueRaw, fallback?: string): string {
  const full = issue.references?.full;
  const path = full?.split("#")[0]?.trim();
  return path || fallback || String(issue.project_id);
}

/** The one upsert every sync path shares, so the three cannot drift. */
function issueUpsert(
  accountId: string,
  issue: GitLabIssueRaw,
  projectPath: string,
) {
  // Everything here is refreshed on update, not only on create: a project
  // renamed or moved between groups keeps its id, an issue gets re-parented to
  // a different epic, and a stale cached path or epic is what the review tree
  // would then label the row with.
  const shared = {
    projectPath,
    title: issue.title,
    body: issue.description,
    state: issue.state,
    labels: issue.labels ?? [],
    url: issue.web_url,
    author: issue.author?.username ?? null,
    assignees: (issue.assignees ?? []).map((a) => a.username),
    milestone: issue.milestone?.title ?? null,
    closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
    epicId: issue.epic?.id ?? null,
    epicIid: issue.epic?.iid ?? null,
    epicGroupId: issue.epic?.group_id ?? null,
    epicTitle: issue.epic?.title ?? null,
    syncedAt: new Date(),
  };
  return prisma.gitLabIssue.upsert({
    where: {
      accountId_projectId_issueIid: {
        accountId,
        projectId: issue.project_id,
        issueIid: issue.iid,
      },
    },
    create: {
      accountId,
      projectId: issue.project_id,
      issueIid: issue.iid,
      gitlabCreatedAt: new Date(issue.created_at),
      ...shared,
    },
    update: shared,
  });
}

/** Sync (upsert) a project's issues into the local cache. */
export async function syncGitLabIssues(
  accountId: string,
  projectId: number,
  projectPath: string,
  state: "opened" | "closed" | "all" = "all",
) {
  const issues = await fetchIssuesFromGitLab(accountId, projectId, state);
  await prisma.$transaction(
    // A project listing has no `references.full`, so the caller's path stands.
    issues.map((i) => issueUpsert(accountId, i, projectPathOf(i, projectPath))),
  );
  return { synced: issues.length, projectId, projectPath };
}

/**
 * Sync every issue in a group — subgroups included, which is GitLab's own
 * default for this endpoint and the reason a parent group is worth picking.
 *
 * This is the answer to "500 projects, which one?": on an instance where the
 * work is organised by group rather than by repo, nobody wants to import a
 * dozen projects one at a time to reassemble one team's backlog.
 */
export async function syncGitLabGroupIssues(
  accountId: string,
  // A path works wherever an id does — GitLab accepts a URL-encoded
  // `group/subgroup` as `:id` — which is what lets a pasted URL drive a sync
  // without first looking the group's number up.
  groupId: number | string,
  groupPath: string,
  state: "opened" | "closed" | "all" = "all",
) {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const issues = await gitlabFetchAll<GitLabIssueRaw>(
    baseUrl,
    token,
    `/groups/${encodeURIComponent(groupId)}/issues`,
    {
      ...(state === "all" ? {} : { state }),
      order_by: "updated_at",
      scope: "all",
    },
    // A big group holds thousands; ten pages is the same ceiling the project
    // listing uses, and the caller is told when it bites.
    10,
  );
  await prisma.$transaction(
    issues.map((i) => issueUpsert(accountId, i, projectPathOf(i))),
  );
  return {
    synced: issues.length,
    groupId,
    groupPath,
    // 1000 is `maxPages * per_page`. Saying so beats a silent truncation that
    // reads as "that group only has 1000 issues".
    truncated: issues.length >= 1000,
  };
}

/** Sync the issues attached to one epic (they may span several projects). */
export async function syncGitLabEpicIssues(
  accountId: string,
  // A path works wherever an id does — GitLab accepts a URL-encoded
  // `group/subgroup` as `:id` — which is what lets a pasted URL drive a sync
  // without first looking the group's number up.
  groupId: number | string,
  epicIid: number,
) {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const issues = await gitlabFetchAll<GitLabIssueRaw>(
    baseUrl,
    token,
    `/groups/${encodeURIComponent(groupId)}/epics/${epicIid}/issues`,
  );
  await prisma.$transaction(
    issues.map((i) => issueUpsert(accountId, i, projectPathOf(i))),
  );
  return { synced: issues.length, groupId, epicIid };
}

/**
 * What a cache read is scoped to. One shape per way the dialog can be pointed
 * at work, so a board — which is only ever "this owner's issues, narrowed to a
 * milestone" — needs no reader of its own.
 */
export type IssueScope =
  | { kind: "project"; projectId: number }
  /** Path prefix: `operators` also covers `operators/infra/tf`. */
  | { kind: "group"; groupPath: string }
  /** Exact path — a project-owned board, where no subgroup applies. */
  | { kind: "projectPath"; projectPath: string }
  | { kind: "epic"; epicId: number };

function scopeWhere(scope: IssueScope) {
  switch (scope.kind) {
    case "project":
      return { projectId: scope.projectId };
    case "group":
      // The trailing slash matters: without it `operators` would also swallow
      // a sibling group called `operators-legacy`.
      return { projectPath: { startsWith: `${scope.groupPath}/` } };
    case "projectPath":
      return { projectPath: scope.projectPath };
    case "epic":
      return { epicId: scope.epicId };
  }
}

/** Cached issues for one scope, optionally narrowed by milestone and search. */
export async function getLocalGitLabIssues(
  accountId: string,
  scope: IssueScope,
  opts: { state?: string; search?: string; milestone?: string } = {},
) {
  return prisma.gitLabIssue.findMany({
    where: {
      accountId,
      ...scopeWhere(scope),
      ...(opts.milestone ? { milestone: opts.milestone } : {}),
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.search ? { title: { contains: opts.search } } : {}),
    },
    orderBy: [{ projectPath: "asc" }, { issueIid: "desc" }],
    take: 500,
  });
}

// ─── Boards (GraphQL) ───────────────────────────────────────────────────────

/**
 * GitLab's GraphQL endpoint.
 *
 * Reserved for what REST cannot answer. Board columns are the case: on 18.x the
 * REST board payload returns `label: null` for every list and no `list_type`,
 * so a board's columns are simply invisible there — GraphQL reports them as
 * work-item statuses ("Ready for Dev", "Released"), which is the placement an
 * import would otherwise flatten into open/closed.
 */
async function gitlabGraphQL<T>(
  baseUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${baseUrl}/api/graphql`, token, 3, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach ${baseUrl}: ${describeFetchFailure(cause)}`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new Error(`GitLab GraphQL error ${res.status}`);
  }
  const body = (await res.json()) as {
    data?: T;
    errors?: { message?: string }[];
  };
  if (body.errors?.length) {
    throw new Error(
      body.errors.map((e) => e.message).filter(Boolean).join("; ") ||
        "GitLab GraphQL returned errors",
    );
  }
  if (!body.data) throw new Error("GitLab GraphQL returned no data");
  return body.data;
}

/** `gid://gitlab/Epic/1682` → 1682. GraphQL hands back global ids as strings. */
function numericGid(gid: string | null | undefined): number | null {
  const n = Number(String(gid ?? "").split("/").pop());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface GitLabBoardColumn {
  title: string;
  listType: string;
  position: number | null;
}

export interface GitLabBoardSummary {
  id: number;
  name: string;
  ownerPath: string;
  owner: "group" | "project";
  /** A board is often scoped to one milestone; the URL filter wins over it. */
  milestoneTitle: string | null;
  columns: GitLabBoardColumn[];
}

const BOARD_QUERY = `
query($fullPath: ID!, $boardId: BoardID!) {
  namespace: %OWNER%(fullPath: $fullPath) {
    board(id: $boardId) {
      id
      name
      milestone { title }
      lists { nodes { title listType position } }
    }
  }
}`;

/** Read a board's name, its milestone scope and its columns, in order. */
export async function getGitLabBoard(
  accountId: string,
  ownerPath: string,
  owner: "group" | "project",
  boardId: number,
): Promise<GitLabBoardSummary> {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const data = await gitlabGraphQL<{
    namespace: {
      board: {
        name: string;
        milestone: { title: string } | null;
        lists: { nodes: GitLabBoardColumn[] };
      } | null;
    } | null;
  }>(baseUrl, token, BOARD_QUERY.replace("%OWNER%", owner), {
    fullPath: ownerPath,
    boardId: `gid://gitlab/Board/${boardId}`,
  });

  const board = data.namespace?.board;
  if (!board) {
    throw new Error(
      `Board ${boardId} not found in ${owner} "${ownerPath}" — check the URL, or that the token can see it.`,
    );
  }
  return {
    id: boardId,
    name: board.name,
    ownerPath,
    owner,
    milestoneTitle: board.milestone?.title ?? null,
    // The backlog and closed pseudo-columns are GitLab's own, not the team's
    // workflow, and ordering by position keeps the board's left-to-right shape.
    columns: (board.lists?.nodes ?? [])
      .filter((l) => l.position !== null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
  };
}

/** One issue as the board query returns it. */
interface BoardIssueNode {
  iid: string;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  webUrl: string;
  createdAt: string;
  closedAt: string | null;
  reference: string;
  projectId: number;
  status: { name: string } | null;
  milestone: { title: string } | null;
  epic: {
    id: string;
    iid: string;
    title: string;
    group: { id: string } | null;
  } | null;
  labels: { nodes: { title: string }[] };
  author: { username: string } | null;
  assignees: { nodes: { username: string }[] };
}

const BOARD_ISSUES_QUERY = `
query($fullPath: ID!, $milestone: [String!], $after: String) {
  namespace: %OWNER%(fullPath: $fullPath) {
    issues(milestoneTitle: $milestone, %SUBGROUPS% first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid title description state webUrl createdAt closedAt
        reference(full: true)
        projectId
        status { name }
        milestone { title }
        epic { id iid title group { id } }
        labels { nodes { title } }
        author { username }
        assignees { nodes { username } }
      }
    }
  }
}`;

/**
 * Sync the issues a board shows, keeping the column each one sits in.
 *
 * The milestone filter comes from the URL when it has one and from the board's
 * own scope otherwise — the two agree in the common case, and the URL wins
 * because it is what the user was looking at.
 */
export async function syncGitLabBoard(
  accountId: string,
  board: GitLabBoardSummary,
  milestoneTitle: string | null,
) {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const milestone = milestoneTitle ?? board.milestoneTitle;
  const query = BOARD_ISSUES_QUERY.replace("%OWNER%", board.owner).replace(
    "%SUBGROUPS%",
    // Only a group can span subgroups; passing the argument to a project errors.
    board.owner === "group" ? "includeSubgroups: true," : "",
  );

  const nodes: BoardIssueNode[] = [];
  let after: string | null = null;
  // Ten pages of 100, the ceiling the REST paths use.
  for (let page = 0; page < 10; page++) {
    const data: {
      namespace: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: BoardIssueNode[];
        };
      } | null;
    } = await gitlabGraphQL(baseUrl, token, query, {
      fullPath: board.ownerPath,
      milestone: milestone ? [milestone] : null,
      after,
    });
    const conn = data.namespace?.issues;
    if (!conn) break;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  await prisma.$transaction(
    nodes.map((n) => {
      const shared = {
        projectPath: n.reference.split("#")[0],
        title: n.title,
        body: n.description,
        state: n.state,
        labels: n.labels?.nodes?.map((l) => l.title) ?? [],
        url: n.webUrl,
        author: n.author?.username ?? null,
        assignees: n.assignees?.nodes?.map((a) => a.username) ?? [],
        milestone: n.milestone?.title ?? null,
        closedAt: n.closedAt ? new Date(n.closedAt) : null,
        epicId: numericGid(n.epic?.id),
        epicIid: n.epic ? Number(n.epic.iid) : null,
        epicGroupId: numericGid(n.epic?.group?.id),
        epicTitle: n.epic?.title ?? null,
        boardStatus: n.status?.name ?? null,
        syncedAt: new Date(),
      };
      return prisma.gitLabIssue.upsert({
        where: {
          accountId_projectId_issueIid: {
            accountId,
            projectId: n.projectId,
            issueIid: Number(n.iid),
          },
        },
        create: {
          accountId,
          projectId: n.projectId,
          issueIid: Number(n.iid),
          gitlabCreatedAt: new Date(n.createdAt),
          ...shared,
        },
        update: shared,
      });
    }),
  );

  return {
    synced: nodes.length,
    board: board.name,
    milestone,
    truncated: nodes.length >= 1000,
  };
}

// ─── Groups and epics ───────────────────────────────────────────────────────

/**
 * Groups the token can see. Subgroups included — a team's work usually lives in
 * one, and `civo/dashboard` is a more useful pick than `civo`'s 3476 issues.
 *
 * Deliberately no `min_access_level`: it filters to *direct* memberships, which
 * on a real instance is a tiny fraction of what you can read. Against a live
 * server it cut 100 visible groups down to 9, and searching for a group the
 * user reads through inherited access — `operators` — returned nothing at all.
 * Visibility is already the token's business.
 */
export async function listGroupsForAccount(
  accountId: string,
  search?: string,
): Promise<GitLabGroup[]> {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const query = search?.trim();
  return gitlabFetchAll<GitLabGroup>(
    baseUrl,
    token,
    "/groups",
    {
      order_by: "path",
      sort: "asc",
      ...(query ? { search: query } : {}),
    },
    query ? 2 : 5,
  );
}

/**
 * Sync a group's epics, descendants included.
 *
 * `include_descendant_groups` defaults to true and is left that way on purpose:
 * on a real instance the epics belong to the subgroups, not the parent — the
 * `civo` group returns 1731 with descendants and 649 without.
 */
export async function syncGitLabEpics(
  accountId: string,
  // A path works wherever an id does — GitLab accepts a URL-encoded
  // `group/subgroup` as `:id` — which is what lets a pasted URL drive a sync
  // without first looking the group's number up.
  groupId: number | string,
  groupPath: string,
  state: "opened" | "closed" | "all" = "all",
) {
  const { baseUrl, token } = await getGitLabAuth(accountId);
  const epics = await gitlabFetchAll<GitLabEpicRaw>(
    baseUrl,
    token,
    `/groups/${encodeURIComponent(groupId)}/epics`,
    {
      ...(state === "all" ? {} : { state }),
      order_by: "updated_at",
    },
  );

  await prisma.$transaction(
    epics.map((epic) => {
      // An epic returned by a parent group belongs to whichever descendant owns
      // it, so its own group is stored — not the one queried. `references.full`
      // is `civo/platform&125`, whose left half is that owning group's path.
      const shared = {
        epicIid: epic.iid,
        groupId: epic.group_id,
        groupPath: epic.references?.full?.split("&")[0] || groupPath,
        title: epic.title,
        body: epic.description,
        state: epic.state,
        labels: epic.labels ?? [],
        url: epic.web_url,
        author: epic.author?.username ?? null,
        parentId: epic.parent_id ?? null,
        startDate: epic.start_date ? new Date(epic.start_date) : null,
        dueDate: epic.due_date ? new Date(epic.due_date) : null,
        closedAt: epic.closed_at ? new Date(epic.closed_at) : null,
        syncedAt: new Date(),
      };
      return prisma.gitLabEpic.upsert({
        where: { accountId_epicId: { accountId, epicId: epic.id } },
        create: {
          accountId,
          epicId: epic.id,
          gitlabCreatedAt: new Date(epic.created_at),
          ...shared,
        },
        update: shared,
      });
    }),
  );
  return { synced: epics.length, groupId, groupPath };
}

/**
 * Cached epics for a group.
 *
 * Descendant epics are kept under the group they were synced from by matching
 * the path prefix as well as the id, so picking `civo` still surfaces the epics
 * that actually live in `civo/dashboard`.
 */
export async function getLocalGitLabEpics(
  accountId: string,
  // A number here, unlike the sync helpers: this reads the local cache, whose
  // `groupId` column is GitLab's numeric id and cannot match a path.
  groupId: number,
  groupPath: string,
  opts: { state?: string; search?: string } = {},
) {
  return prisma.gitLabEpic.findMany({
    where: {
      accountId,
      OR: [
        { groupId },
        { groupPath: { startsWith: `${groupPath}/` } },
        { groupPath },
      ],
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.search ? { title: { contains: opts.search } } : {}),
    },
    // "opened" before "closed" — descending, because the two literals sort the
    // wrong way round alphabetically and open work is what people came for.
    orderBy: [{ state: "desc" }, { epicIid: "desc" }],
    take: 200,
  });
}

// ─── Feature ↔ Issue linking ────────────────────────────────────────────────

export async function linkGitLabIssueToFeature(
  featureId: string,
  issueId: string,
) {
  return prisma.featureGitLabIssue.upsert({
    where: { featureId_issueId: { featureId, issueId } },
    create: { featureId, issueId },
    update: {},
  });
}

export async function unlinkGitLabIssueFromFeature(
  featureId: string,
  issueId: string,
) {
  return prisma.featureGitLabIssue.delete({
    where: { featureId_issueId: { featureId, issueId } },
  });
}

export async function getGitLabIssuesForFeature(featureId: string) {
  return prisma.featureGitLabIssue.findMany({
    where: { featureId },
    include: { issue: true },
    orderBy: { createdAt: "asc" },
  });
}
