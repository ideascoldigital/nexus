/**
 * Test a saved credential. Spec: `specs/28-credential-checks.md`.
 *
 * One module per provider, each a pure function over an injected fetch.
 * Every provider Nexux stores credentials for has a check; an unknown one
 * answers "not testable" instead of pretending.
 */

import { checkBitbucket } from "./bitbucket";
import { checkClaude } from "./claude";
import { checkGitHub } from "./github";
import { checkGitLab } from "./gitlab";
import { checkAws, checkCivo, checkTailscale } from "./cloud";
import { checkLlmKey } from "./llm";
import type { CredentialCheck, Fetch } from "./types";

export type { CredentialCheck, CheckLine } from "./types";
export { CHECKABLE_PROVIDERS } from "./types";

export async function checkCredential(
  cred: { provider: string; data: unknown },
  deps: { fetch?: Fetch; now?: () => Date } = {},
  /** Where it is used, when the caller knows: the AWS region sandboxes launch in. */
  context: { awsRegion?: string | null } = {},
): Promise<CredentialCheck | null> {
  const data = (cred.data ?? {}) as {
    token?: string;
    apiKey?: string;
    registryHost?: string | null;
    accessKeyId?: string;
    secretAccessKey?: string;
    authKey?: string | null;
    loginServer?: string | null;
  };
  switch (cred.provider) {
    case "civo":
      return checkCivo(data.token ?? "", deps);
    case "aws":
      return checkAws(
        { accessKeyId: data.accessKeyId ?? "", secretAccessKey: data.secretAccessKey ?? "" },
        { region: context.awsRegion },
        deps,
      );
    case "tailscale":
      return checkTailscale(data, deps);
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
