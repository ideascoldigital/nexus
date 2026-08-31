/**
 * GitHub Projects V2 — GraphQL only (the REST API covers just classic
 * projects). Requires the `project` scope on the account's PAT.
 *
 * Mapping into Nexus: a project's Iteration (sprint) becomes a DevPhase, the
 * Status board column becomes the kanban status, issue items keep
 * FeatureIssue provenance through the GitHubIssue cache, draft items import
 * without a link. PR items are skipped — they're code, not work items.
 */

import { prisma } from "@nexux/db";
import { getPATForAccount } from "./github";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_URL = "https://api.github.com";

async function githubGraphQL<T>(
  pat: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string; type?: string }[];
    message?: string;
  };
  if (!res.ok) {
    throw new Error(json.message || `GitHub GraphQL error ${res.status}`);
  }
  // GraphQL can return PARTIAL data alongside errors — e.g. a token without
  // read:org still resolves the viewer's own projects while the org fields
  // error out. Partial data is useful; only a fully-empty response is fatal.
  if (!json.data) {
    const msg = json.errors?.[0]?.message ?? "GitHub GraphQL returned no data";
    if (json.errors?.[0]?.type === "INSUFFICIENT_SCOPES") {
      throw new Error(
        `${msg} — regenerate the account's token with the scopes from the "Generate token" link.`
      );
    }
    throw new Error(msg);
  }
  return json.data;
}

// ─── Project listing ────────────────────────────────────────────────────────

export interface ProjectV2Summary {
  id: string;
  title: string;
  number: number;
  owner: string; // user or org login
}

type RawProjects = {
  nodes: { id: string; title: string; number: number; closed: boolean }[];
};

const flattenProjects = (
  owner: string,
  projects: RawProjects | null
): ProjectV2Summary[] =>
  (projects?.nodes ?? [])
    .filter((p) => !p.closed)
    .map((p) => ({ id: p.id, title: p.title, number: p.number, owner }));

/**
 * OAuth scopes on a classic PAT, from the response header. Fine-grained
 * tokens don't send it — null means "unknown", not "none".
 */
async function tokenScopes(pat: string): Promise<string[] | null> {
  const res = await fetch(`${REST_URL}/user`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
  });
  const raw = res.headers.get("x-oauth-scopes");
  if (raw === null) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Org logins over REST, not GraphQL: `viewer.organizations` silently returns
 * an EMPTY list without read:org (and errors outright the moment you select
 * `login` on it), while REST /user/orgs still lists public memberships.
 */
async function listOrgLogins(pat: string): Promise<string[]> {
  const res = await fetch(`${REST_URL}/user/orgs?per_page=100`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return [];
  const orgs = (await res.json().catch(() => [])) as { login?: string }[];
  return Array.isArray(orgs) ? orgs.flatMap((o) => (o.login ? [o.login] : [])) : [];
}

/**
 * Boards owned by each org. `organization(login:)` resolves WITHOUT read:org
 * as long as no org field that requires it (login, id, name…) is selected —
 * which is why the owner comes from the login we asked for, not the response.
 */
async function listOrgProjects(
  pat: string,
  logins: string[]
): Promise<ProjectV2Summary[]> {
  if (logins.length === 0) return [];
  const capped = logins.slice(0, 20);
  const params = capped.map((_, i) => `$l${i}: String!`).join(", ");
  const fields = capped
    .map(
      (_, i) =>
        `o${i}: organization(login: $l${i}) { projectsV2(first: 50) { nodes { id title number closed } } }`
    )
    .join("\n");

  const data = await githubGraphQL<
    Record<string, { projectsV2: RawProjects | null } | null>
  >(
    pat,
    `query(${params}) { ${fields} }`,
    Object.fromEntries(capped.map((login, i) => [`l${i}`, login]))
  );

  return capped.flatMap((login, i) =>
    flattenProjects(login, data[`o${i}`]?.projectsV2 ?? null)
  );
}

/**
 * Boards linked to repos the account can reach — the only way to see a board
 * owned by someone else (a collaboration) short of pasting its URL.
 */
async function listRepoLinkedProjects(pat: string): Promise<ProjectV2Summary[]> {
  const data = await githubGraphQL<{
    viewer: {
      repositories: {
        nodes: ({ nameWithOwner: string; projectsV2: RawProjects | null } | null)[];
      } | null;
    } | null;
  }>(
    pat,
    `query {
      viewer {
        repositories(
          first: 100
          affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            nameWithOwner
            projectsV2(first: 10) { nodes { id title number closed } }
          }
        }
      }
    }`
  );

  return (data.viewer?.repositories?.nodes ?? []).flatMap((repo) =>
    repo
      ? flattenProjects(repo.nameWithOwner.split("/")[0], repo.projectsV2)
      : []
  );
}

export interface ProjectV2List {
  projects: ProjectV2Summary[];
  /** Non-fatal note for the UI when some boards are certainly out of reach. */
  warning: string | null;
}

/**
 * Every board the account can see: its own, its orgs', and any linked to a
 * repo it collaborates on. Each source is queried separately and degrades on
 * its own — GitHub validates scopes for the WHOLE query before executing
 * anything, so one scope-gated field would otherwise take the rest down.
 */
export async function listProjectsV2(accountId: string): Promise<ProjectV2List> {
  const pat = await getPATForAccount(accountId);

  const own = await githubGraphQL<{
    viewer: { login: string; projectsV2: RawProjects | null } | null;
  }>(
    pat,
    `query {
      viewer {
        login
        projectsV2(first: 50) { nodes { id title number closed } }
      }
    }`
  );
  if (!own.viewer) throw new Error("GitHub returned no viewer for this token");

  const degraded = (source: string) => (err: unknown) => {
    console.warn(
      `[github-projects] ${source} unavailable:`,
      err instanceof Error ? err.message : err
    );
    return [] as ProjectV2Summary[];
  };

  const [orgLogins, scopes] = await Promise.all([
    listOrgLogins(pat).catch(() => [] as string[]),
    tokenScopes(pat).catch(() => null),
  ]);
  const [orgProjects, repoProjects] = await Promise.all([
    listOrgProjects(pat, orgLogins).catch(degraded("org boards")),
    listRepoLinkedProjects(pat).catch(degraded("repo-linked boards")),
  ]);

  const seen = new Set<string>();
  const projects = [
    ...flattenProjects(own.viewer.login, own.viewer.projectsV2),
    ...orgProjects,
    ...repoProjects,
  ].filter((p) => !seen.has(p.id) && seen.add(p.id));

  // read:org gates org *membership* discovery, so a token without it misses
  // every board in an org whose membership is private — say so instead of
  // presenting a short list as complete.
  const warning =
    scopes && !scopes.includes("read:org")
      ? "This token has no read:org scope, so boards in orgs with private membership stay hidden. Regenerate it from Settings → Integrations, or paste the board URL below."
      : null;

  return { projects, warning };
}

// ─── Resolving a board by URL ───────────────────────────────────────────────

export interface ProjectRef {
  login: string;
  number: number;
}

/**
 * Accepts a board URL (`github.com/orgs/acme/projects/3`, `/users/me/...`,
 * with or without a `/views/1` tail) or the shorthand `acme/3`.
 */
export function parseProjectRef(input: string): ProjectRef | null {
  const trimmed = input.trim();
  const url = trimmed.match(
    /github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)/i
  );
  if (url) return { login: url[1], number: Number(url[2]) };
  const short = trimmed.match(/^([A-Za-z0-9-_.]+)[/#](\d+)$/);
  if (short) return { login: short[1], number: Number(short[2]) };
  return null;
}

type RawProject = { id: string; title: string; number: number } | null;

/**
 * Resolve one board by owner + number — the escape hatch for boards no
 * listing reaches: another user's, or an org whose membership is private.
 */
export async function resolveProjectV2(
  accountId: string,
  input: string
): Promise<ProjectV2Summary> {
  const ref = parseProjectRef(input);
  if (!ref) {
    throw new Error(
      "Paste a board URL like https://github.com/orgs/acme/projects/3"
    );
  }

  const pat = await getPATForAccount(accountId);
  // Both owner types in one query: the wrong one comes back as a NOT_FOUND
  // error alongside usable partial data, which githubGraphQL keeps.
  const data = await githubGraphQL<{
    organization: { projectV2: RawProject } | null;
    user: { projectV2: RawProject } | null;
  }>(
    pat,
    `query($login: String!, $number: Int!) {
      organization(login: $login) { projectV2(number: $number) { id title number } }
      user(login: $login) { projectV2(number: $number) { id title number } }
    }`,
    { login: ref.login, number: ref.number }
  );

  const found = data.organization?.projectV2 ?? data.user?.projectV2 ?? null;
  if (!found) {
    throw new Error(
      `No project #${ref.number} under "${ref.login}" is visible to this token — check the URL, and that the token has the project scope (plus read:org for private org boards).`
    );
  }
  return {
    id: found.id,
    title: found.title,
    number: found.number,
    owner: ref.login,
  };
}

// ─── Project items ──────────────────────────────────────────────────────────

export interface ProjectV2Item {
  itemId: string;
  type: "ISSUE" | "DRAFT_ISSUE";
  title: string;
  body: string | null;
  statusColumn: string | null;
  iteration: string | null;
  priority: string | null;
  /** GitHubIssue cache row (upserted during fetch) — null for drafts. */
  issue: { id: string; number: number; url: string; repo: string } | null;
}

/**
 * Board column name → kanban status. Free-form names, stable heuristics.
 *
 * Shared with the GitLab board import (spec 22): GitLab 18 models its columns
 * as work-item statuses with the same vocabulary teams use on GitHub Projects
 * — "Ready for Dev", "In progress", "Released" — so one heuristic serves both
 * rather than the two drifting apart.
 *
 * Order matters: "Ready for Review" has to reach the review branch before the
 * "ready" one, or it lands in todo.
 */
export function mapColumnToStatus(column: string | null): string {
  const c = (column ?? "").toLowerCase();
  if (/progress|doing/.test(c)) return "in_progress";
  if (/review/.test(c)) return "in_review";
  if (/done|complete|closed|shipped|released/.test(c)) return "done";
  if (/todo|to do|ready|next/.test(c)) return "todo";
  return "backlog";
}

export function mapProjectPriority(priority: string | null): string {
  const p = (priority ?? "").toLowerCase();
  if (/urgent|critical|p0/.test(p)) return "urgent";
  if (/high|p1/.test(p)) return "high";
  if (/low|p3|p4/.test(p)) return "low";
  return "medium";
}

type RawFieldValue = {
  name?: string; // single-select value
  title?: string; // iteration value
  field?: { name?: string };
};

type RawItem = {
  id: string;
  type: string;
  fieldValues: { nodes: RawFieldValue[] };
  content:
    | {
        number?: number;
        title?: string;
        body?: string | null;
        state?: string;
        url?: string;
        repository?: { name: string; owner: { login: string } };
      }
    | null;
};

export async function getProjectV2Items(
  accountId: string,
  ghProjectId: string
): Promise<{ title: string; items: ProjectV2Item[] }> {
  const pat = await getPATForAccount(accountId);

  type ItemsPage = {
    node: {
      title: string;
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawItem[];
      };
    } | null;
  };

  const rawItems: RawItem[] = [];
  let title = "";
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: ItemsPage = await githubGraphQL<ItemsPage>(
      pat,
      `query($id: ID!, $after: String) {
        node(id: $id) {
          ... on ProjectV2 {
            title
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                type
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      title
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
                content {
                  ... on Issue {
                    number title body state url
                    repository { name owner { login } }
                  }
                  ... on DraftIssue { title body }
                }
              }
            }
          }
        }
      }`,
      { id: ghProjectId, after }
    );
    if (!data.node) throw new Error("GitHub project not found");
    title = data.node.title;
    rawItems.push(...data.node.items.nodes);
    if (!data.node.items.pageInfo.hasNextPage) break;
    after = data.node.items.pageInfo.endCursor;
  }

  const items: ProjectV2Item[] = [];
  for (const raw of rawItems) {
    if (raw.type !== "ISSUE" && raw.type !== "DRAFT_ISSUE") continue;
    if (!raw.content?.title) continue;

    const fieldValue = (predicate: (name: string) => boolean) =>
      raw.fieldValues.nodes.find((v) => predicate(v.field?.name?.toLowerCase() ?? ""));
    const statusColumn = fieldValue((n) => n === "status")?.name ?? null;
    const iteration = fieldValue((n) => n === "iteration" || n === "sprint")?.title ?? null;
    const priority = fieldValue((n) => n === "priority")?.name ?? null;

    let issue: ProjectV2Item["issue"] = null;
    if (raw.type === "ISSUE" && raw.content.repository && raw.content.number != null) {
      const owner = raw.content.repository.owner.login;
      const repo = raw.content.repository.name;
      // Items can come from any repo, so the cache row may not exist yet —
      // upsert it here so FeatureIssue provenance always has a target.
      const row = await prisma.gitHubIssue.upsert({
        where: {
          accountId_owner_repo_issueNumber: {
            accountId,
            owner,
            repo,
            issueNumber: raw.content.number,
          },
        },
        create: {
          accountId,
          owner,
          repo,
          issueNumber: raw.content.number,
          title: raw.content.title,
          body: raw.content.body ?? null,
          state: (raw.content.state ?? "open").toLowerCase(),
          url: raw.content.url ?? "",
          syncedAt: new Date(),
        },
        update: {
          title: raw.content.title,
          body: raw.content.body ?? null,
          state: (raw.content.state ?? "open").toLowerCase(),
          url: raw.content.url ?? "",
          syncedAt: new Date(),
        },
      });
      issue = {
        id: row.id,
        number: raw.content.number,
        url: raw.content.url ?? "",
        repo: `${owner}/${repo}`,
      };
    }

    items.push({
      itemId: raw.id,
      type: raw.type,
      title: raw.content.title,
      body: raw.content.body ?? null,
      statusColumn,
      iteration,
      priority,
      issue,
    });
  }

  return { title, items };
}

// ─── Nexus project ↔ GitHub project link (for re-sync) ──────────────────────

const linkKey = (projectId: string) => `github_project_link:${projectId}`;

export interface GitHubProjectLink {
  accountId: string;
  ghProjectId: string;
  title: string;
}

export async function getProjectLink(
  projectId: string
): Promise<GitHubProjectLink | null> {
  const row = await prisma.settings.findUnique({
    where: { key: linkKey(projectId) },
  });
  if (!row?.isActive) return null;
  try {
    return JSON.parse(row.value) as GitHubProjectLink;
  } catch {
    return null;
  }
}

export async function saveProjectLink(
  projectId: string,
  link: GitHubProjectLink
) {
  const value = JSON.stringify(link);
  await prisma.settings.upsert({
    where: { key: linkKey(projectId) },
    create: { key: linkKey(projectId), value, provider: "github", isActive: true },
    update: { value, isActive: true },
  });
}

/**
 * Re-sync: pull the linked board and move already-imported features to the
 * column's status — and to the iteration's phase when a DevPhase with that
 * name exists. Never creates features or phases; import is the only path
 * that adds work.
 */
export async function syncProjectV2(projectId: string) {
  const link = await getProjectLink(projectId);
  if (!link) throw new Error("This project is not linked to a GitHub project");

  const { items } = await getProjectV2Items(link.accountId, link.ghProjectId);

  const phases = await prisma.devPhase.findMany({ where: { projectId } });
  const phaseByName = new Map(phases.map((p) => [p.name.toLowerCase(), p.id]));

  let updated = 0;
  for (const item of items) {
    if (!item.issue) continue;
    const featureLink = await prisma.featureIssue.findFirst({
      where: { issueId: item.issue.id, feature: { projectId } },
      include: { feature: true },
    });
    if (!featureLink) continue;

    const status = mapColumnToStatus(item.statusColumn);
    const phaseId = item.iteration
      ? (phaseByName.get(item.iteration.toLowerCase()) ?? featureLink.feature.devPhaseId)
      : featureLink.feature.devPhaseId;

    if (
      featureLink.feature.status !== status ||
      featureLink.feature.devPhaseId !== phaseId
    ) {
      await prisma.feature.update({
        where: { id: featureLink.feature.id },
        data: { status, devPhaseId: phaseId },
      });
      updated++;
    }
  }

  return { checked: items.length, updated };
}
