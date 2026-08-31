import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Browsers and password managers pattern-match credential-looking inputs
// (a secret field next to a "name" field) and autofill saved passwords into
// them. Spread this on such inputs — the data-* attrs opt out of 1Password,
// LastPass, Bitwarden and Dashlane; pair with autoComplete="off" (text) or
// "new-password" (password inputs, where Chrome ignores "off").
export const NO_AUTOFILL: Record<string, string> = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
}

// Checkout directory name for a repo on a sandbox instance. Must stay in
// sync with safeSlug in @nexux/sandbox (not imported here — that package
// pulls in node builtins and can't enter the client bundle).
export function sandboxRepoSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "repo"
  )
}
