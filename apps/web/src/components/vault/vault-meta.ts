import { CreditCard, KeyRound, UserRound, Variable } from "lucide-react";

import type { VaultType } from "@/lib/vault-items";

export const VAULT_TYPE_META: Record<VaultType, { label: string; plural: string; icon: typeof KeyRound; blurb: string }> = {
  login: { label: "Login", plural: "Logins", icon: KeyRound, blurb: "A bot signs in with it — the password is typed for it" },
  secret: { label: "Secret", plural: "Secrets", icon: Variable, blurb: "API key or connection string for an MCP server" },
  card: { label: "Card", plural: "Cards", icon: CreditCard, blurb: "A bot pays with it, after you confirm" },
  contact: { label: "Contact info", plural: "Contacts", icon: UserRound, blurb: "Email, phone and address for forms" },
};
