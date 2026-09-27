/**
 * What testing a credential says about it. Spec: `specs/28-credential-checks.md`.
 *
 * Never contains the secret: this is stored on the row and sent to the
 * browser.
 */
export type CheckLine = {
  label: string;
  /** null = cannot be told from here — never guessed as true or false. */
  ok: boolean | null;
  detail?: string;
};

export type CredentialCheck = {
  /** fail: unusable. warn: works, but not for everything Nexux may need. */
  status: "ok" | "warn" | "fail";
  /** Who the provider says this is — an account login, an ARN, … */
  identity: string | null;
  expiresAt: string | null;
  /** null when the provider cannot list them (e.g. fine-grained tokens). */
  scopes: string[] | null;
  checks: CheckLine[];
  checkedAt: string;
};

/** fetch, injected so every provider is testable without a network. */
export type Fetch = typeof fetch;

/** Providers with a check (spec 28 phase 1: GitHub). The UI offers Test only for these. */
export const CHECKABLE_PROVIDERS: ReadonlySet<string> = new Set(["github"]);

/** Days before expiry at which a working token turns into a warning. */
export const EXPIRY_WARN_DAYS = 14;
