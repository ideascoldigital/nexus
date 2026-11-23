// Vault items (spec 32): what the user keeps for bots — logins, secrets, cards,
// contact details. Pure and client-safe: the forms, the API and the bot manager
// share it. The secret part is sealed in the database and never sent to the
// browser; `toPublicItem` is the only shape that leaves the server.

import { z } from "zod";

export const VAULT_TYPES = ["login", "secret", "card", "contact"] as const;
export type VaultType = (typeof VAULT_TYPES)[number];

/** Which secret fields each type has, and which a bot may have typed for it. */
export const SECRET_FIELDS = {
  login: ["password"],
  secret: ["value"],
  card: ["number", "expiry", "cvc", "holder"],
  contact: ["email", "phone", "address"],
} as const satisfies Record<VaultType, readonly string[]>;

/** Fields a bot may ask Nexus to type into a page (vault_fill). A login's username it types itself. */
export const FILLABLE: Record<VaultType, readonly string[]> = {
  login: ["password"],
  secret: [],
  card: ["number", "expiry", "cvc", "holder"],
  contact: ["email", "phone", "address"],
};

export type VaultItemRow = {
  id: string;
  type: string;
  name: string;
  websites: unknown;
  username: string | null;
  label: string | null;
  hint: string | null;
  secret: unknown;
  botIds: unknown;
  lastUsedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PublicVaultItem = {
  id: string;
  type: VaultType;
  name: string;
  websites: string[];
  username: string | null;
  label: string | null;
  hint: string | null;
  /** null = every bot. */
  botIds: string[] | null;
  /** Which secret fields hold a value — never the values. */
  filled: string[];
  lastUsedAt: string | null;
  updatedAt: string;
};

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const iso = (d: Date | string | null) => (d === null ? null : typeof d === "string" ? d : d.toISOString());

export function toPublicItem(row: VaultItemRow): PublicVaultItem {
  const secret = row.secret && typeof row.secret === "object" ? (row.secret as Record<string, unknown>) : {};
  return {
    id: row.id,
    type: (VAULT_TYPES as readonly string[]).includes(row.type) ? (row.type as VaultType) : "secret",
    name: row.name,
    websites: strList(row.websites),
    username: row.username,
    label: row.label,
    hint: row.hint,
    botIds: Array.isArray(row.botIds) ? strList(row.botIds) : null,
    filled: Object.keys(secret).filter((k) => typeof secret[k] === "string" && (secret[k] as string).length > 0),
    lastUsedAt: iso(row.lastUsedAt),
    updatedAt: iso(row.updatedAt)!,
  };
}

// ---- Input -------------------------------------------------------------------

/** "https://www.Facebook.com/login" → "facebook.com". Empty when it isn't a host. */
export function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^www\./, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || host === "localhost" ? host : "";
  } catch {
    return "";
  }
}

/** A page URL is on one of the login's websites (the site or a subdomain of it). */
export function hostMatches(websites: string[], pageUrl: string): boolean {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return websites.some((w) => {
    const site = normalizeHost(w);
    return Boolean(site) && (host === site || host.endsWith(`.${site}`));
  });
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Luhn check, so a typo'd card number is caught before a bot types it. */
export function luhnOk(number: string): boolean {
  const d = digits(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function cardBrand(number: string): string {
  const d = digits(number);
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "Mastercard";
  if (/^3[47]/.test(d)) return "Amex";
  if (/^6(011|5)/.test(d)) return "Discover";
  return "Card";
}

/** What the list shows for a card: "Visa •••• 4242". */
export function cardLabel(number: string): string {
  return `${cardBrand(number)} •••• ${digits(number).slice(-4)}`;
}

const name = z.string().trim().min(1, "Give it a name").max(120);
const hint = z.string().trim().max(500).nullish();
const botIds = z.array(z.string().min(1)).max(200).nullish();
const opt = (max: number) => z.string().max(max).optional();

/** A secret's name is how MCP configs reference it: {{secret:name}}. */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

export const vaultCreateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("login"),
    websites: z.array(z.string()).min(1, "Add the website").max(10),
    name: name.optional(),
    username: z.string().trim().max(320).nullish(),
    hint,
    botIds,
    secret: z.object({ password: z.string().min(1, "Enter the password").max(1000) }),
  }),
  z.object({
    type: z.literal("secret"),
    name: name.regex(SECRET_NAME, "Letters, digits, - _ . (it's how configs reference it)"),
    hint,
    botIds,
    secret: z.object({ value: z.string().min(1, "Enter the value").max(20_000) }),
  }),
  z.object({
    type: z.literal("card"),
    name: name.optional(),
    hint,
    botIds,
    secret: z.object({
      number: z.string().refine(luhnOk, "That card number doesn't look right"),
      expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "MM/YY"),
      cvc: z.string().regex(/^\d{3,4}$/, "3 or 4 digits"),
      holder: z.string().trim().min(1, "Name on the card").max(120),
    }),
  }),
  z.object({
    type: z.literal("contact"),
    name,
    hint,
    botIds,
    secret: z.object({ email: opt(320), phone: opt(60), address: opt(1000) }),
  }),
]);
export type VaultCreateInput = z.infer<typeof vaultCreateSchema>;

/** Edits: public fields, and any secret field given non-empty replaces the stored one. */
export const vaultUpdateSchema = z.object({
  name: name.optional(),
  websites: z.array(z.string()).max(10).optional(),
  username: z.string().trim().max(320).nullish(),
  hint,
  botIds,
  secret: z.record(z.string(), z.string().max(20_000)).optional(),
});

/** Create input → the row to store (public part + secret), or the problem. */
export function itemFromInput(input: VaultCreateInput): { ok: true; row: Omit<VaultItemRow, "id" | "lastUsedAt" | "createdAt" | "updatedAt"> } | { ok: false; error: string } {
  const base = { hint: input.hint?.trim() || null, botIds: input.botIds?.length ? input.botIds : null };
  switch (input.type) {
    case "login": {
      const websites = [...new Set(input.websites.map(normalizeHost).filter(Boolean))];
      if (websites.length === 0) return { ok: false, error: "That website doesn't look right" };
      return {
        ok: true,
        row: { ...base, type: "login", name: input.name?.trim() || websites[0]!, websites, username: input.username?.trim() || null, label: null, secret: input.secret },
      };
    }
    case "secret":
      return { ok: true, row: { ...base, type: "secret", name: input.name, websites: null, username: null, label: null, secret: input.secret } };
    case "card": {
      const label = cardLabel(input.secret.number);
      const secret = { ...input.secret, number: digits(input.secret.number) };
      return { ok: true, row: { ...base, type: "card", name: input.name?.trim() || label, websites: null, username: null, label, secret } };
    }
    case "contact": {
      const secret = Object.fromEntries(Object.entries(input.secret).filter(([, v]) => v && v.trim()));
      if (Object.keys(secret).length === 0) return { ok: false, error: "Add an email, a phone or an address" };
      return { ok: true, row: { ...base, type: "contact", name: input.name, websites: null, username: null, label: input.name, secret } };
    }
  }
}

/** May this bot use the entry? */
export function botMayUse(item: { botIds: unknown }, botId: string): boolean {
  return !Array.isArray(item.botIds) || item.botIds.length === 0 || item.botIds.includes(botId);
}

// ---- {{secret:name}} in MCP configs --------------------------------------------

const REF = /\{\{\s*secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,59})\s*\}\}/g;

/** Every secret a config refers to. */
export function secretRefs(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(REF)) out.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

/**
 * Replace {{secret:name}} in every string of an mcpServers object. A server
 * referring to a secret that is missing (or not this bot's) is dropped and
 * named in `missing`, so it isn't started with a literal placeholder.
 */
export function resolveSecretRefs(
  servers: Record<string, unknown>,
  lookup: (name: string) => string | null,
): { servers: Record<string, unknown>; missing: Array<{ server: string; secret: string }> } {
  const missing: Array<{ server: string; secret: string }> = [];
  const out: Record<string, unknown> = {};
  for (const [server, def] of Object.entries(servers)) {
    const absent = secretRefs(def).filter((n) => lookup(n) === null);
    if (absent.length) {
      for (const secret of absent) missing.push({ server, secret });
      continue;
    }
    const sub = (v: unknown): unknown => {
      if (typeof v === "string") return v.replace(REF, (_, n: string) => lookup(n)!);
      if (Array.isArray(v)) return v.map(sub);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
      return v;
    };
    out[server] = sub(def);
  }
  return { servers: out, missing };
}
