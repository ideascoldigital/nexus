import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool, toolByName, toolsFor } from "../registry";
import type { CreateProjectInput, NexuxContext, ProjectDetail } from "../types";

const detail: ProjectDetail = {
  id: "p1",
  name: "Acme",
  description: null,
  workspacePath: null,
  bootstrapType: null,
  createdAt: "2026-11-26T00:00:00.000Z",
  repositories: [],
};

function ctxWith(over: Partial<NexuxContext>): NexuxContext {
  return new Proxy(over as NexuxContext, {
    get: (target, key) =>
      key in target
        ? target[key as keyof NexuxContext]
        : async () => {
            throw new Error(`unexpected call: ${String(key)}`);
          },
  });
}

test("creating, cloning and detecting need projects:write; reading needs projects:read", () => {
  for (const name of ["nexux_create_project", "nexux_clone_repositories", "nexux_detect_stack"]) {
    assert.equal(toolByName(name)?.scope, "projects:write", name);
  }
  for (const name of ["nexux_get_project", "nexux_scan_directory", "nexux_list_bootstrap_types", "nexux_list_git_credentials"]) {
    assert.equal(toolByName(name)?.scope, "projects:read", name);
  }
  assert.ok(!toolsFor(["projects:read"]).some((t) => t.name === "nexux_create_project"));
});

test("a project from Git URLs reaches the host as given", async () => {
  let got: CreateProjectInput | null = null;
  const ctx = ctxWith({
    createProject: async (input) => {
      got = input;
      return detail;
    },
  });
  const res = await callTool(ctx, ["projects:write"], "nexux_create_project", {
    name: " Acme ",
    repositories: [
      { name: "api", repoUrl: "https://github.com/acme/api.git", gitCredentialId: "c1" },
      { name: "web", repoUrl: "https://github.com/acme/web.git", isMain: true },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(got, {
    name: "Acme",
    description: undefined,
    workspacePath: undefined,
    bootstrap: undefined,
    repositories: [
      { name: "api", repoUrl: "https://github.com/acme/api.git", localPath: undefined, gitCredentialId: "c1" },
      { name: "web", repoUrl: "https://github.com/acme/web.git", localPath: undefined, gitCredentialId: undefined, isMain: true },
    ],
  });
});

test("a project needs somewhere its code comes from, and only one way", async () => {
  const ctx = ctxWith({ createProject: async () => detail });
  const noSource = await callTool(ctx, ["projects:write"], "nexux_create_project", {
    name: "A",
    repositories: [{ name: "api" }],
  });
  assert.deepEqual(noSource, { ok: false, error: "`repositories[0]` needs a repoUrl or a localPath" });
  const both = await callTool(ctx, ["projects:write"], "nexux_create_project", {
    name: "A",
    repositories: [{ name: "api", localPath: "~/x" }],
    bootstrap: { type: "frontend", parentPath: "~/Projects" },
  });
  assert.deepEqual(both, { ok: false, error: "Pass either repositories or a bootstrap, not both" });
});

test("an idea is a bootstrap with its type and folder", async () => {
  let got: CreateProjectInput | null = null;
  const ctx = ctxWith({
    createProject: async (input) => {
      got = input;
      return detail;
    },
  });
  await callTool(ctx, ["projects:write"], "nexux_create_project", {
    name: "Recetas",
    description: "Una app de recetas",
    bootstrap: { type: "fullstack", parentPath: "~/Projects" },
  });
  assert.deepEqual(got!.bootstrap, { type: "fullstack", parentPath: "~/Projects" });
  assert.equal(got!.repositories, undefined);
});

test("scanning a path that is not a folder says so", async () => {
  const ctx = ctxWith({ scanDirectory: async () => null });
  const res = await callTool(ctx, ["projects:read"], "nexux_scan_directory", { directory: "~/nope" });
  assert.deepEqual(res, { ok: false, error: '"~/nope" is not a folder on this machine' });
});

test("an unknown project is an error, not an empty answer", async () => {
  const ctx = ctxWith({ getProject: async () => null });
  const res = await callTool(ctx, ["projects:read"], "nexux_get_project", { projectId: "nope" });
  assert.deepEqual(res, { ok: false, error: "Project not found" });
});
