/**
 * The obvious mistakes, named before any provider is asked.
 *
 * A provider answers a malformed value with a bare 401, which reads as
 * "expired" or "missing scope" — the wrong fix. The value itself usually says
 * what happened: whitespace from a sloppy paste, or a shell command pasted in
 * place of its output (`gh auth token | pbcopy` saved as the token, which
 * happened).
 */

/** Token prefixes by provider, where the provider has them. */
const PREFIXES: Record<string, string[]> = {
  github: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
  gitlab: ["glpat-", "gloas-", "gldt-"],
  claude: ["sk-ant-oat"],
};

export type ShapeProblem = { fatal: boolean; message: string };

export function shapeProblems(provider: string, secret: string): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  if (!secret) return [{ fatal: true, message: "No token is saved on this credential." }];

  if (secret !== secret.trim()) {
    problems.push({
      fatal: false,
      message: "It starts or ends with whitespace — a copy/paste artefact that providers reject.",
    });
  }
  const v = secret.trim();
  if (/\s/.test(v) || /[|;&`$<>]/.test(v)) {
    problems.push({
      fatal: true,
      message:
        /\b(gh|glab|op|pbcopy|echo|cat)\b/.test(v)
          ? "This looks like a shell command, not its output — run the command and save what it prints."
          : "It contains spaces or shell characters, which no token does.",
    });
  }
  const prefixes = PREFIXES[provider];
  if (prefixes && !prefixes.some((p) => v.startsWith(p))) {
    problems.push({
      fatal: false,
      message: `It doesn't start like a ${provider} token (${prefixes.join(", ")}) — make sure it is the token itself.`,
    });
  }
  return problems;
}
