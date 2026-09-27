/**
 * Test a saved credential. Spec: `specs/28-credential-checks.md`.
 *
 * One module per provider, each a pure function over an injected fetch.
 * Phase 1 covers GitHub; the rest answer "not testable yet" instead of
 * pretending.
 */

import { checkGitHub } from "./github";
import type { CredentialCheck, Fetch } from "./types";

export type { CredentialCheck, CheckLine } from "./types";
export { CHECKABLE_PROVIDERS } from "./types";

export async function checkCredential(
  cred: { provider: string; data: unknown },
  deps: { fetch?: Fetch; now?: () => Date } = {},
): Promise<CredentialCheck | null> {
  const data = (cred.data ?? {}) as { token?: string };
  switch (cred.provider) {
    case "github":
      return checkGitHub(data.token ?? "", deps);
    default:
      return null;
  }
}
