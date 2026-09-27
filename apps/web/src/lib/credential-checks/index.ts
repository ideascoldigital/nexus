/**
 * Test a saved credential. Spec: `specs/28-credential-checks.md`.
 *
 * One module per provider, each a pure function over an injected fetch.
 * Git hosts, Claude Code tokens and LLM keys so far; the rest answer "not
 * testable yet" instead of pretending.
 */

import { checkBitbucket } from "./bitbucket";
import { checkClaude } from "./claude";
import { checkGitHub } from "./github";
import { checkGitLab } from "./gitlab";
import { checkLlmKey } from "./llm";
import type { CredentialCheck, Fetch } from "./types";

export type { CredentialCheck, CheckLine } from "./types";
export { CHECKABLE_PROVIDERS } from "./types";

export async function checkCredential(
  cred: { provider: string; data: unknown },
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck | null> {
  const data = (cred.data ?? {}) as { token?: string; apiKey?: string; registryHost?: string | null };
  switch (cred.provider) {
    case "github":
      return checkGitHub(data.token ?? "", deps);
    case "gitlab":
      return checkGitLab(data.token ?? "", { registryHost: data.registryHost }, deps);
    case "bitbucket":
      return checkBitbucket(data.token ?? "", deps);
    case "claude":
      return checkClaude(data.token ?? "", deps);
    default:
      // LLM keys (spec 16); null for a provider with no check yet.
      return checkLlmKey(cred.provider, data.apiKey ?? "", deps);
  }
}
