/**
 * Conventional branch and commit naming for the work Nexus dispatches.
 *
 * Branches used to be `nexux/<the entire feature title>-<id>`, which announced
 * the tool rather than the change and ran past 110 characters on a real title.
 * A reviewer reads the branch before anything else; it should say what kind of
 * change is arriving, the way every other branch in the repo does.
 *
 * Pure and dependency-free so the classifier can be tested against real titles
 * rather than reasoned about.
 */

export const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "refactor",
  "perf",
  "chore",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

/**
 * Ordered most-specific first: a title mentioning both a bug and a test is a
 * fix with a test, not a test. The first match wins, so the order *is* the
 * precedence and moving an entry changes behaviour.
 *
 * Spanish included deliberately — features here are written in both languages,
 * and a classifier that only knows English would file half of them as `feat`.
 */
const RULES: Array<{ type: ConventionalType; pattern: RegExp }> = [
  {
    type: "fix",
    pattern:
      /\b(fix|bug|bugfix|hotfix|broken|crash|regression|failing|arregl\w*|corrig\w*|corregir|falla|error)\b/i,
  },
  {
    type: "docs",
    pattern: /\b(docs?|documentation|documentaci[oó]n|readme|changelog)\b/i,
  },
  {
    type: "test",
    pattern: /\b(tests?|testing|e2e|spec|coverage|pruebas?)\b/i,
  },
  {
    type: "perf",
    pattern:
      /\b(perf|performance|rendimiento|optimi[sz]\w*|optimizar|speed|latency|memory leak)\b/i,
  },
  {
    type: "refactor",
    pattern:
      /\b(refactor\w*|cleanup|clean up|simplif\w*|rename|reorganiz\w*|restructur\w*|reestructur\w*)\b/i,
  },
  {
    type: "chore",
    pattern:
      /\b(chore|bump|upgrade|update deps|dependenc\w*|config\w*|ci|build|lint|actualiz\w* (deps|dependencias))\b/i,
  },
];

/**
 * The conventional type a feature title describes.
 *
 * `feat` is the default because it is the honest one for "add a thing", which
 * is what most features are — and a wrong `feat` is a smaller lie than a wrong
 * `fix`, which tells a reviewer something broke when nothing did.
 */
export function conventionalType(title: string): ConventionalType {
  // An explicit prefix outranks any guess: "fix: foo" was already classified
  // by whoever wrote it.
  const explicit = title.match(/^\s*([a-z]+)\s*(\([^)]*\))?\s*[:!]/i)?.[1];
  if (explicit) {
    const lower = explicit.toLowerCase();
    const known = CONVENTIONAL_TYPES.find((t) => t === lower);
    if (known) return known;
    // "Bug: …" is the shape the issue trackers produce, and it is a fix.
    if (lower === "bug") return "fix";
  }
  for (const { type, pattern } of RULES) {
    if (pattern.test(title)) return type;
  }
  return "feat";
}

/** Longest slug kept in a branch name. */
const MAX_SLUG = 48;

/**
 * Title → branch slug: lowercase, dash-separated, cut at a word boundary.
 *
 * The cap is the point. Git accepts a 110-character ref, but nothing else
 * does comfortably — it wraps in every UI, and truncating mid-word makes the
 * tail unreadable, so the cut lands on the last whole word that fits.
 */
export function branchSlug(title: string): string {
  const cleaned = title
    // Drop a leading "feat:" / "Bug:" — it becomes the prefix instead.
    .replace(/^\s*[a-z]+\s*(\([^)]*\))?\s*[:!]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length <= MAX_SLUG) return cleaned || "task";
  const cut = cleaned.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf("-");
  // Keep a whole word unless the first one is already too long to fit.
  return (lastDash > 12 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/**
 * The branch a dispatched run works on: `<type>/<slug>-<suffix>`.
 *
 * The suffix is what keeps two runs of the same feature apart; it stays even
 * when the slug is short, since re-dispatching a feature is routine.
 */
export function branchName(title: string, suffix: string): string {
  return `${conventionalType(title)}/${branchSlug(title)}-${suffix}`;
}

/**
 * The PR title: `type: subject`, with the subject's first letter lowered the
 * way conventional commits expect.
 *
 * A title that already carries a valid prefix is passed through — re-prefixing
 * would produce `feat: fix: …`.
 */
export function conventionalTitle(title: string): string {
  const trimmed = title.trim();
  const explicit = trimmed.match(/^([a-z]+)(\([^)]*\))?!?:/i)?.[1];
  if (explicit && CONVENTIONAL_TYPES.some((t) => t === explicit.toLowerCase())) {
    return trimmed;
  }
  const type = conventionalType(trimmed);
  const subject = trimmed
    .replace(/^\s*[a-z]+\s*(\([^)]*\))?\s*[:!]\s*/i, "")
    .trim();
  const body = subject || trimmed;
  return `${type}: ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
}
