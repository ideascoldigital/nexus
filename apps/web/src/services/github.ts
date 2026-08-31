/**
 * GitHub Service
 *
 * Handles GitHub API calls using Personal Access Tokens (PAT).
 * Accounts are stored in ConnectedAccount + OAuthToken tables.
 */

import { prisma } from "@nexux/db";

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; avatar_url: string };
  description: string | null;
  private: boolean;
  html_url: string;
  open_issues_count: number;
  updated_at: string;
}

export interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: { login: string; avatar_url: string } | null;
  assignees: { login: string }[];
  labels: { name: string; color: string }[];
  milestone: { title: string } | null;
  closed_at: string | null;
  created_at: string;
  /** Present when the "issue" is actually a pull request */
  pull_request?: { url: string };
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

// ─── Low-level GitHub API helpers ───────────────────────────────────────────

async function githubFetch<T>(
  pat: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`https://api.github.com${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.message || `GitHub API error ${res.status}: ${path}`
    );
  }

  return res.json() as Promise<T>;
}

// ─── PAT helpers ────────────────────────────────────────────────────────────

export async function getPATForAccount(accountId: string): Promise<string> {
  const token = await prisma.oAuthToken.findFirst({
    where: { accountId },
    orderBy: { createdAt: "desc" },
  });

  if (!token) {
    throw new Error("No token found for this GitHub account");
  }

  return token.accessToken;
}

// ─── Account management ─────────────────────────────────────────────────────

/**
 * Validate a PAT and create/update a ConnectedAccount.
 * Returns the account with GitHub user info in metadata.
 */
export async function addGitHubAccount(pat: string, label: string) {
  // Validate PAT by fetching the authenticated user
  const user = await githubFetch<GitHubUser>(pat, "/user");

  // Check if an account for this GitHub login already exists
  const allGithubAccounts = await prisma.connectedAccount.findMany({
    where: { providerType: "github" },
    include: { oauthTokens: true },
  });
  const existing = allGithubAccounts.find(
    (a) => (a.metadata as { login?: string } | null)?.login === user.login
  ) ?? null;

  if (existing) {
    // Update token and label
    await prisma.connectedAccount.update({
      where: { id: existing.id },
      data: {
        label,
        status: "connected",
        lastCheckedAt: new Date(),
        metadata: {
          login: user.login,
          name: user.name,
          avatar_url: user.avatar_url,
          email: user.email,
        },
      },
    });

    // Replace token
    if (existing.oauthTokens.length > 0) {
      await prisma.oAuthToken.update({
        where: { id: existing.oauthTokens[0].id },
        data: { accessToken: pat, updatedAt: new Date() },
      });
    } else {
      await prisma.oAuthToken.create({
        data: { accountId: existing.id, accessToken: pat },
      });
    }

    return prisma.connectedAccount.findUnique({ where: { id: existing.id } });
  }

  // Create new account
  const account = await prisma.connectedAccount.create({
    data: {
      providerType: "github",
      category: "integration",
      label,
      authMode: "pat",
      status: "connected",
      lastCheckedAt: new Date(),
      metadata: {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
        email: user.email,
      },
      oauthTokens: {
        create: { accessToken: pat },
      },
    },
  });

  return account;
}

export async function listGitHubAccounts() {
  return prisma.connectedAccount.findMany({
    where: { providerType: "github" },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteGitHubAccount(accountId: string) {
  return prisma.connectedAccount.delete({ where: { id: accountId } });
}

// ─── Repos ──────────────────────────────────────────────────────────────────

export async function listReposForAccount(
  accountId: string,
  page = 1
): Promise<GitHubRepo[]> {
  const pat = await getPATForAccount(accountId);
  return githubFetch<GitHubRepo[]>(pat, "/user/repos", {
    sort: "updated",
    per_page: "100",
    page: String(page),
    affiliation: "owner,collaborator,organization_member",
  });
}

// ─── Issues ─────────────────────────────────────────────────────────────────

export async function fetchIssuesFromGitHub(
  accountId: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open",
  page = 1
): Promise<GitHubIssueRaw[]> {
  const pat = await getPATForAccount(accountId);
  const issues = await githubFetch<GitHubIssueRaw[]>(
    pat,
    `/repos/${owner}/${repo}/issues`,
    {
      state,
      per_page: "100",
      page: String(page),
      sort: "updated",
      // exclude pull requests
      filter: "all",
    }
  );
  // GitHub issues endpoint returns PRs too — filter them out
  return issues.filter((i) => !i.pull_request);
}

/**
 * Sync (upsert) issues from GitHub into the local DB for a given repo.
 */
export async function syncIssues(
  accountId: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "all"
) {
  const issues = await fetchIssuesFromGitHub(accountId, owner, repo, state);

  const upserts = issues.map((issue) =>
    prisma.gitHubIssue.upsert({
      where: {
        accountId_owner_repo_issueNumber: {
          accountId,
          owner,
          repo,
          issueNumber: issue.number,
        },
      },
      create: {
        accountId,
        owner,
        repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        assignees: issue.assignees.map((a) => a.login),
        milestone: issue.milestone?.title ?? null,
        closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
        githubCreatedAt: new Date(issue.created_at),
        syncedAt: new Date(),
      },
      update: {
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        url: issue.html_url,
        author: issue.user?.login ?? null,
        assignees: issue.assignees.map((a) => a.login),
        milestone: issue.milestone?.title ?? null,
        closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
        syncedAt: new Date(),
      },
    })
  );

  await prisma.$transaction(upserts);
  return { synced: issues.length, owner, repo };
}

/**
 * Get cached issues from DB (with optional search).
 */
export async function getLocalIssues(
  accountId: string,
  owner: string,
  repo: string,
  opts: { state?: string; search?: string } = {}
) {
  return prisma.gitHubIssue.findMany({
    where: {
      accountId,
      owner,
      repo,
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.search
        ? { title: { contains: opts.search } }
        : {}),
    },
    orderBy: { githubCreatedAt: "desc" },
    take: 100,
  });
}

// ─── Feature ↔ Issue linking ─────────────────────────────────────────────────

export async function linkIssueToFeature(featureId: string, issueId: string) {
  return prisma.featureIssue.upsert({
    where: { featureId_issueId: { featureId, issueId } },
    create: { featureId, issueId },
    update: {},
  });
}

export async function unlinkIssueFromFeature(
  featureId: string,
  issueId: string
) {
  return prisma.featureIssue.delete({
    where: { featureId_issueId: { featureId, issueId } },
  });
}

export async function getIssuesForFeature(featureId: string) {
  return prisma.featureIssue.findMany({
    where: { featureId },
    include: { issue: true },
    orderBy: { createdAt: "asc" },
  });
}
