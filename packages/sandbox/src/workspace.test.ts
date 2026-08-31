import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_ROOT,
  SANDBOX_WORKSPACE_PATH,
  pickMainRepo,
  renderCodeWorkspace,
  repoDir,
  resolveVsCodeFolder,
  writeCodeWorkspaceCommand,
  type MainRepoCandidate,
} from "./workspace";

test("every repo becomes a first-level folder", () => {
  const parsed = JSON.parse(
    renderCodeWorkspace([{ name: "Web App" }, { name: "api" }]),
  ) as { folders: { name: string; path: string }[] };

  assert.deepEqual(parsed.folders, [
    { name: "Web App", path: "./web-app" },
    { name: "api", path: "./api" },
  ]);
});

test("paths are relative so the file works over ssh and dev containers", () => {
  const parsed = JSON.parse(renderCodeWorkspace([{ name: "api" }])) as {
    folders: { path: string }[];
  };
  assert.ok(parsed.folders.every((f) => f.path.startsWith("./")));
});

test("an explicit dir overrides the slug", () => {
  const parsed = JSON.parse(
    renderCodeWorkspace([{ name: "Infra", dir: "infra-tf" }]),
  ) as { folders: { path: string }[] };
  assert.equal(parsed.folders[0].path, "./infra-tf");
});

test("repos that slug to the same dir are collapsed", () => {
  const parsed = JSON.parse(
    renderCodeWorkspace([{ name: "my app" }, { name: "My-App" }]),
  ) as { folders: unknown[] };
  assert.equal(parsed.folders.length, 1);
});

test("no repos renders an empty but valid workspace", () => {
  const parsed = JSON.parse(renderCodeWorkspace([])) as { folders: unknown[] };
  assert.deepEqual(parsed.folders, []);
});

test("the write command heredoc is quoted and holds valid json", () => {
  const cmd = writeCodeWorkspaceCommand([{ name: "api" }]);
  assert.ok(cmd.includes(`cat > ${SANDBOX_WORKSPACE_PATH} <<'NEXUX_WORKSPACE_EOF'`));
  const body = cmd.split("NEXUX_WORKSPACE_EOF'\n")[1].split("\nNEXUX_WORKSPACE_EOF")[0];
  JSON.parse(body);
});

test("the write command targets a custom path when given one", () => {
  const cmd = writeCodeWorkspaceCommand([{ name: "api" }], "/opt/nexus/x.code-workspace");
  assert.ok(cmd.includes("cat > /opt/nexus/x.code-workspace <<'NEXUX_WORKSPACE_EOF'"));
});

// --- resolveVsCodeFolder ----------------------------------------------------

test("the workspace file is what a multi-repo sandbox opens", () => {
  assert.equal(
    resolveVsCodeFolder({ workspaceReady: true }),
    SANDBOX_WORKSPACE_PATH,
  );
});

test("without a workspace file it falls back to the sandbox root", () => {
  assert.equal(resolveVsCodeFolder({ workspaceReady: false }), SANDBOX_ROOT);
});

test("an explicit path wins over the workspace", () => {
  assert.equal(
    resolveVsCodeFolder({
      explicitPath: "/opt/nexus/api",
      workspaceReady: true,
    }),
    "/opt/nexus/api",
  );
});

test("a null or empty explicit path does not shadow the workspace", () => {
  for (const explicitPath of [null, undefined, ""]) {
    assert.equal(
      resolveVsCodeFolder({ explicitPath, workspaceReady: true }),
      SANDBOX_WORKSPACE_PATH,
    );
  }
});

test("a custom workspace path is honoured", () => {
  assert.equal(
    resolveVsCodeFolder({
      workspaceReady: true,
      workspacePath: "/opt/nexus/x.code-workspace",
    }),
    "/opt/nexus/x.code-workspace",
  );
});

// --- pickMainRepo ------------------------------------------------------------
// The repo every agent task cds into. Shared with resolveWorkDir so the
// checkout the bootstrap refuses to start without is the same one tasks use —
// two copies of "isMain, then oldest" drift into a box that bootstraps happily
// and fails every task against a directory nobody cloned.

const repo = (over: Partial<MainRepoCandidate> = {}): MainRepoCandidate => ({
  name: "app",
  isMain: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  repoUrl: "https://github.com/acme/app.git",
  localPath: null,
  ...over,
});

test("the flagged repo wins regardless of age", () => {
  const main = pickMainRepo([
    repo({ name: "older", createdAt: new Date("2025-01-01T00:00:00Z") }),
    repo({ name: "flagged", isMain: true, createdAt: new Date("2026-06-01T00:00:00Z") }),
  ]);
  assert.equal(main?.name, "flagged");
});

test("with nothing flagged the oldest wins", () => {
  const main = pickMainRepo([
    repo({ name: "newer", createdAt: new Date("2026-06-01T00:00:00Z") }),
    repo({ name: "oldest", createdAt: new Date("2025-01-01T00:00:00Z") }),
  ]);
  assert.equal(main?.name, "oldest");
});

test("a repo with neither a url nor a local path cannot be the main one", () => {
  const main = pickMainRepo([
    repo({ name: "shell", isMain: true, repoUrl: null, localPath: null }),
    repo({ name: "real" }),
  ]);
  assert.equal(main?.name, "real");
});

test("a local-only repo still counts — a mounted checkout is a checkout", () => {
  const main = pickMainRepo([
    repo({ name: "mounted", repoUrl: null, localPath: "/host/app" }),
  ]);
  assert.equal(main?.name, "mounted");
});

test("a project with no usable repo has no main", () => {
  assert.equal(pickMainRepo([]), null);
  assert.equal(
    pickMainRepo([repo({ repoUrl: null, localPath: null })]),
    null,
  );
});

test("picking does not reorder the caller's array", () => {
  const repos = [
    repo({ name: "newer", createdAt: new Date("2026-06-01T00:00:00Z") }),
    repo({ name: "oldest", createdAt: new Date("2025-01-01T00:00:00Z") }),
  ];
  pickMainRepo(repos);
  assert.equal(repos[0].name, "newer");
});

test("repoDir slugs the name under the sandbox root", () => {
  assert.equal(repoDir("Acme API"), "/opt/nexus/acme-api");
});
