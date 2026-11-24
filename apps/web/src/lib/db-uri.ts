// Database connection strings as people paste them: the password straight
// from a password manager, `@`, `:`, `/` or `#` and all. Drivers want the
// user and password percent-encoded, and reject (MongoDB) or misread
// (Postgres) the raw form — "Invalid connection string" for a value that looks
// right. Nexus encodes them on the way into a bot's computer, so pasting the
// string as Atlas shows it, with the real password in it, just works.

const SCHEME = /^(mongodb(?:\+srv)?|postgres(?:ql)?):\/\//i;

/** Decode what is already encoded, then encode it all — so %40 stays %40 and @ becomes %40. */
function encodePart(s: string): string {
  let plain = s;
  try {
    plain = decodeURIComponent(s);
  } catch {
    // A literal "%" that is not an escape: it is part of the password.
  }
  return encodeURIComponent(plain);
}

/**
 * The same connection string with its user and password percent-encoded.
 * Hosts never contain "@", so the last "@" ends the credentials, whatever the
 * password holds. Anything that is not a MongoDB / Postgres URL is returned as is.
 */
export function normalizeDbUri(raw: string): string {
  const v = raw.trim();
  const m = v.match(SCHEME);
  if (!m) return raw;
  const rest = v.slice(m[0].length);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return v;
  const creds = rest.slice(0, at);
  const colon = creds.indexOf(":");
  const user = colon === -1 ? creds : creds.slice(0, colon);
  const pass = colon === -1 ? null : creds.slice(colon + 1);
  return `${m[0]}${encodePart(user)}${pass === null ? "" : `:${encodePart(pass)}`}@${rest.slice(at + 1)}`;
}
