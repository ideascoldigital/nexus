// Bootstrap templates: start a project from a blank idea instead of existing
// repos. Client-safe data only — scaffold file contents live server-side in
// ./scaffold.ts. `services` are keys into SERVICE_CATALOG and get seeded onto
// the Stack canvas at creation, so the wizard's Stack step opens pre-wired.

export type BootstrapTemplate = {
  key: string;
  name: string;
  tagline: string;
  /** SERVICE_CATALOG keys seeded as stack nodes wired to the repo. */
  services: string[];
  /**
   * Suggested dev command for the repo's stack node (runMode local).
   *
   * npm, always. A template runs before the repo exists, so there is no
   * lockfile to read and any other manager is a coin flip that leaves the node
   * calling something the box may not even have — the value then outlives the
   * guess, because detection fills empty fields rather than correcting stored
   * ones. npm is the one manager Node ships with, and `detectRepo` replaces
   * this with the real answer once there is a repo to inspect.
   */
  localCommand?: string;
  /** Suggested dev port for the repo's stack node. */
  port?: number;
};

export const BOOTSTRAP_TEMPLATES: BootstrapTemplate[] = [
  {
    key: "frontend",
    name: "Frontend",
    tagline: "UIs, SPAs, landing pages — React, Next.js, Vite",
    services: [],
    localCommand: "npm run dev",
    port: 3000,
  },
  {
    key: "backend",
    name: "Backend / API",
    tagline: "Services & APIs with a database ready to go",
    services: ["postgres"],
    localCommand: "npm run dev",
    port: 8080,
  },
  {
    key: "fullstack",
    name: "Full-stack",
    tagline: "UI + API + database + cache, one workspace",
    services: ["postgres", "redis"],
    localCommand: "npm run dev",
    port: 3000,
  },
  {
    key: "scripting",
    name: "Scripting / CLI",
    tagline: "Automation, CLIs, cron jobs, glue code",
    services: [],
  },
  {
    key: "data-ai",
    name: "Data / AI",
    tagline: "Pipelines, notebooks, local LLM experiments",
    services: ["ollama"],
  },
  {
    key: "research",
    name: "Research",
    tagline: "An idea lab — notes, sources, experiments",
    services: [],
  },
  {
    key: "mobile",
    name: "Mobile",
    tagline: "iOS / Android — React Native, Expo, Flutter",
    services: [],
    localCommand: "npm start",
  },
  {
    key: "library",
    name: "Library / Package",
    tagline: "Reusable packages, SDKs, design systems",
    services: [],
  },
];

export type BootstrapTypeKey = (typeof BOOTSTRAP_TEMPLATES)[number]["key"];

export const BOOTSTRAP_TYPE_KEYS = BOOTSTRAP_TEMPLATES.map((t) => t.key);

export function getBootstrapTemplate(
  key: string,
): BootstrapTemplate | undefined {
  return BOOTSTRAP_TEMPLATES.find((t) => t.key === key);
}

/** "My SaaS Idea!" → "my-saas-idea" — used for the workspace directory name. */
export function slugifyProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
