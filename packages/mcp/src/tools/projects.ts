import { asObject, optionalString, requiredString } from "../args";
import { ToolInputError, type NewRepositoryInput, type ToolDefinition } from "../types";

/**
 * Creating a project from a conversation (spec 39): the same steps as the
 * dashboard's wizard — scan a folder, pick Git repositories, or bootstrap an
 * idea — then clone and recognise the stack. Credentials are named, never
 * read: a tool passes a credential's id and Nexus applies it on its side.
 */

const projectIdOnly = {
  type: "object" as const,
  properties: { projectId: { type: "string", description: "From nexux_list_projects or nexux_create_project." } },
  required: ["projectId"],
  additionalProperties: false,
};

export const getProject: ToolDefinition<{ projectId: string }> = {
  name: "nexux_get_project",
  description:
    "A project's details: description, folder, and its repositories with where each clone stands " +
    "(pending, cloning, ready, error). Use it to follow a clone started with nexux_clone_repositories.",
  scope: "projects:read",
  inputSchema: projectIdOnly,
  parse: (raw) => ({ projectId: requiredString(asObject(raw), "projectId") }),
  run: async (ctx, args) => {
    const project = await ctx.getProject(args.projectId);
    if (!project) throw new ToolInputError("Project not found");
    return project;
  },
};

export const scanDirectory: ToolDefinition<{ directory: string }> = {
  name: "nexux_scan_directory",
  description:
    "Find the git repositories in a folder on the user's machine (the folder itself, or up to two " +
    "levels below it). Use it when the user wants a project from code they already have; show them " +
    "what was found and ask which ones belong to the project.",
  scope: "projects:read",
  inputSchema: {
    type: "object",
    properties: {
      directory: { type: "string", description: "An absolute path or one starting with ~, e.g. ~/Projects/acme." },
    },
    required: ["directory"],
    additionalProperties: false,
  },
  parse: (raw) => ({ directory: requiredString(asObject(raw), "directory") }),
  run: async (ctx, args) => {
    const result = await ctx.scanDirectory(args.directory);
    if (!result) throw new ToolInputError(`"${args.directory}" is not a folder on this machine`);
    return result;
  },
};

export const listBootstrapTypes: ToolDefinition<Record<string, never>> = {
  name: "nexux_list_bootstrap_types",
  description:
    "The kinds of project an idea can start as (frontend, backend, fullstack…), each with what it " +
    "sets up, and the default folder new ones are created in. Use before nexux_create_project with " +
    "a bootstrap.",
  scope: "projects:read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}),
  run: (ctx) => ctx.listBootstrapTypes(),
};

export const listGitCredentials: ToolDefinition<Record<string, never>> = {
  name: "nexux_list_git_credentials",
  description:
    "The saved GitHub, GitLab and Bitbucket credentials, by name and id (never their values). " +
    "Pass an id as gitCredentialId to clone a private repository with it.",
  scope: "projects:read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}),
  run: (ctx) => ctx.listGitCredentials(),
};

function parseRepositories(value: unknown): NewRepositoryInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ToolInputError("`repositories` must be an array");
  return value.map((item, i) => {
    const obj = asObject(item);
    const repo: NewRepositoryInput = {
      name: requiredString(obj, "name"),
      repoUrl: optionalString(obj, "repoUrl"),
      localPath: optionalString(obj, "localPath"),
      gitCredentialId: optionalString(obj, "gitCredentialId"),
    };
    if (obj.isMain !== undefined) {
      if (typeof obj.isMain !== "boolean") throw new ToolInputError(`\`repositories[${i}].isMain\` must be a boolean`);
      repo.isMain = obj.isMain;
    }
    if (!repo.repoUrl && !repo.localPath) {
      throw new ToolInputError(`\`repositories[${i}]\` needs a repoUrl or a localPath`);
    }
    return repo;
  });
}

export const createProject: ToolDefinition<{
  name: string;
  description?: string;
  workspacePath?: string;
  repositories?: NewRepositoryInput[];
  bootstrap?: { type: string; parentPath: string };
}> = {
  name: "nexux_create_project",
  description:
    "Create a project. Three ways, as in the dashboard: (1) code already on this machine — pass the " +
    "repositories nexux_scan_directory found (localPath) and the scanned folder as workspacePath; " +
    "(2) Git repositories — pass their repoUrl (and gitCredentialId for private ones), then call " +
    "nexux_clone_repositories; (3) an idea — pass bootstrap {type, parentPath} (see " +
    "nexux_list_bootstrap_types) and no repositories: a fresh folder is created with its stack " +
    "ready. A repoUrl without localPath is given a folder under workspacePath (or ~/Projects/<project>). The first repository is the main one unless one says isMain.",
  scope: "projects:write",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", description: "What the project is, in the user's words. For an idea, the idea." },
      workspacePath: { type: "string", description: "Optional. The folder holding the repositories." },
      repositories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            repoUrl: { type: "string", description: "https or ssh Git URL." },
            localPath: { type: "string", description: "Where it is (or will be) checked out on this machine." },
            isMain: { type: "boolean" },
            gitCredentialId: { type: "string", description: "From nexux_list_git_credentials." },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      bootstrap: {
        type: "object",
        properties: {
          type: { type: "string", description: "A key from nexux_list_bootstrap_types." },
          parentPath: { type: "string", description: "Folder the new project's folder goes in." },
        },
        required: ["type", "parentPath"],
        additionalProperties: false,
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    const repositories = parseRepositories(obj.repositories);
    let bootstrap: { type: string; parentPath: string } | undefined;
    if (obj.bootstrap !== undefined && obj.bootstrap !== null) {
      const b = asObject(obj.bootstrap);
      bootstrap = { type: requiredString(b, "type"), parentPath: requiredString(b, "parentPath") };
    }
    if (bootstrap && repositories?.length) {
      throw new ToolInputError("Pass either repositories or a bootstrap, not both");
    }
    return {
      name: requiredString(obj, "name"),
      description: optionalString(obj, "description"),
      workspacePath: optionalString(obj, "workspacePath"),
      repositories,
      bootstrap,
    };
  },
  run: (ctx, args) => ctx.createProject(args),
};

export const cloneRepositories: ToolDefinition<{ projectId: string }> = {
  name: "nexux_clone_repositories",
  description:
    "Clone a project's repositories that are not checked out yet, with their saved git credential. " +
    "Returns at once with each repository marked cloning; follow it with nexux_get_project.",
  scope: "projects:write",
  inputSchema: projectIdOnly,
  parse: (raw) => ({ projectId: requiredString(asObject(raw), "projectId") }),
  run: (ctx, args) => ctx.cloneRepositories(args.projectId),
};

export const detectStack: ToolDefinition<{ projectId: string }> = {
  name: "nexux_detect_stack",
  description:
    "Recognise a project: read each checked-out repository and report what it is built with — " +
    "languages, frameworks, package manager, install/build/run commands, ports, services it needs. " +
    "Run it after the repositories are ready, and tell the user what was found.",
  scope: "projects:write",
  inputSchema: projectIdOnly,
  parse: (raw) => ({ projectId: requiredString(asObject(raw), "projectId") }),
  run: (ctx, args) => ctx.detectStack(args.projectId),
};

export const sandboxOptions: ToolDefinition<{ projectId: string }> = {
  name: "nexux_sandbox_options",
  description:
    "Where this project's sandbox can run: Docker on this machine (free), other machines' Docker " +
    "endpoints (free), Civo or AWS (cost money; only those with a saved credential). Also the " +
    "project's saved sandbox settings and its current sandboxes. Use it before offering the user " +
    "where to run, and only offer what is available.",
  scope: "sandboxes:read",
  inputSchema: projectIdOnly,
  parse: (raw) => ({ projectId: requiredString(asObject(raw), "projectId") }),
  run: (ctx, args) => ctx.sandboxOptions(args.projectId),
};

const fileArgs = {
  projectId: { type: "string" },
  repository: { type: "string", description: "The repository's name or id, from nexux_get_project." },
};

export const listFiles: ToolDefinition<{ projectId: string; repository: string; path: string }> = {
  name: "nexux_list_files",
  description:
    "List one folder of a project's repository on this machine (no sandbox needed). Paths are relative " +
    "to the repository; omit path for its top. Files marked secret (.env, keys, credentials) exist but " +
    "cannot be read.",
  scope: "files:read",
  inputSchema: {
    type: "object",
    properties: { ...fileArgs, path: { type: "string", description: "Folder inside the repository. Default: its top." } },
    required: ["projectId", "repository"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      projectId: requiredString(obj, "projectId"),
      repository: requiredString(obj, "repository"),
      path: optionalString(obj, "path") ?? ".",
    };
  },
  run: (ctx, args) => ctx.listProjectFiles(args.projectId, args.repository, args.path),
};

function optionalInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolInputError(`\`${key}\` must be a whole number from 1`);
  return v;
}

export const readFile: ToolDefinition<{ projectId: string; repository: string; path: string; offset?: number; limit?: number }> = {
  name: "nexux_read_file",
  description:
    "Read a text file in a project's repository on this machine (no sandbox needed), as numbered lines " +
    "(\"<n>\\t<line>\" — the number and tab are not part of the file). A big file comes in parts: when the " +
    "result has `next`, call again with that offset until you have read what you need.",
  scope: "files:read",
  inputSchema: {
    type: "object",
    properties: {
      ...fileArgs,
      path: { type: "string", description: "File path inside the repository." },
      offset: { type: "integer", description: "First line to read (1-based). Default 1." },
      limit: { type: "integer", description: "At most this many lines. Default: as many as fit." },
    },
    required: ["projectId", "repository", "path"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    return {
      projectId: requiredString(obj, "projectId"),
      repository: requiredString(obj, "repository"),
      path: requiredString(obj, "path"),
      offset: optionalInt(obj, "offset"),
      limit: optionalInt(obj, "limit"),
    };
  },
  run: (ctx, args) => ctx.readProjectFile(args.projectId, args.repository, args.path, args.offset, args.limit),
};

export const editFile: ToolDefinition<{
  projectId: string;
  repository: string;
  path: string;
  oldText: string;
  newText: string;
  all: boolean;
}> = {
  name: "nexux_edit_file",
  description:
    "Change a file in a project's repository on this machine: replace oldText with newText. oldText must be " +
    "copied exactly from the file (without the line numbers nexux_read_file adds) and appear once — add " +
    "surrounding lines to make it unique — or pass all: true to replace every occurrence. Prefer several " +
    "small edits over rewriting a file.",
  scope: "files:write",
  inputSchema: {
    type: "object",
    properties: {
      ...fileArgs,
      path: { type: "string", description: "File path inside the repository." },
      oldText: { type: "string" },
      newText: { type: "string" },
      all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["projectId", "repository", "path", "oldText", "newText"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    if (typeof obj.newText !== "string") throw new ToolInputError("`newText` must be a string");
    if (obj.all !== undefined && typeof obj.all !== "boolean") throw new ToolInputError("`all` must be a boolean");
    return {
      projectId: requiredString(obj, "projectId"),
      repository: requiredString(obj, "repository"),
      path: requiredString(obj, "path"),
      oldText: requiredString(obj, "oldText"),
      newText: obj.newText,
      all: obj.all === true,
    };
  },
  run: (ctx, a) => ctx.editProjectFile(a.projectId, a.repository, a.path, a.oldText, a.newText, a.all),
};

export const writeFile: ToolDefinition<{ projectId: string; repository: string; path: string; content: string }> = {
  name: "nexux_write_file",
  description:
    "Create a file in a project's repository on this machine, or replace one completely (folders are made " +
    "as needed). For changing part of an existing file use nexux_edit_file instead.",
  scope: "files:write",
  inputSchema: {
    type: "object",
    properties: {
      ...fileArgs,
      path: { type: "string", description: "File path inside the repository." },
      content: { type: "string", description: "The whole file." },
    },
    required: ["projectId", "repository", "path", "content"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const obj = asObject(raw);
    if (typeof obj.content !== "string") throw new ToolInputError("`content` must be a string");
    return {
      projectId: requiredString(obj, "projectId"),
      repository: requiredString(obj, "repository"),
      path: requiredString(obj, "path"),
      content: obj.content,
    };
  },
  run: (ctx, a) => ctx.writeProjectFile(a.projectId, a.repository, a.path, a.content),
};

export const PROJECT_TOOLS = [
  listFiles,
  readFile,
  editFile,
  writeFile,
  sandboxOptions,
  getProject,
  scanDirectory,
  listBootstrapTypes,
  listGitCredentials,
  createProject,
  cloneRepositories,
  detectStack,
];
