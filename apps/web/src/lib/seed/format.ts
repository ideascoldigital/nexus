/**
 * What a seed file is, from its bytes — and whether it fits the service it is
 * attached to (spec 29).
 *
 * The name is never trusted: `backup.sql` is as often a pg_dump custom archive
 * renamed by hand as it is SQL. Pure, so it is tested against real headers
 * without a filesystem; the store hands it the first bytes (decompressed when
 * the file is gzip).
 */

export type SeedEngine = "postgres" | "mysql" | "mongo";
export type SeedFormat = "pg-sql" | "pg-custom" | "mysql-sql" | "mongo-archive";

export const FORMAT_ENGINE: Record<SeedFormat, SeedEngine> = {
  "pg-sql": "postgres",
  "pg-custom": "postgres",
  "mysql-sql": "mysql",
  "mongo-archive": "mongo",
};

export const FORMAT_LABEL: Record<SeedFormat, string> = {
  "pg-sql": "PostgreSQL SQL dump",
  "pg-custom": "pg_dump custom archive",
  "mysql-sql": "MySQL/MariaDB SQL dump",
  "mongo-archive": "mongodump archive",
};

/**
 * The database a service image runs, or null for anything a seed cannot go
 * into. Matches on the image's repository name, so a registry prefix or a
 * tag never matters, and the common derivatives (PostGIS, Timescale, MariaDB,
 * Percona) count as what they are.
 */
export function engineOfImage(image: string | null | undefined): SeedEngine | null {
  if (!image) return null;
  const repo = image
    .trim()
    .toLowerCase()
    .replace(/@sha256:[a-f0-9]+$/, "")
    .replace(/:[^/]*$/, "");
  const name = repo.split("/").pop() ?? "";
  if (/^(postgres|postgresql|postgis|timescaledb(-ha)?|pgvector|supabase-postgres)$/.test(name) || repo.includes("postgis/")) {
    return "postgres";
  }
  if (/^(mysql|mariadb|percona(-server)?)$/.test(name)) return "mysql";
  if (/^(mongo|mongodb(-community-server)?)$/.test(name)) return "mongo";
  return null;
}

export const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

// mongodump --archive starts with the magic number 0x8199e26d, little-endian.
const MONGO_ARCHIVE_MAGIC = [0x6d, 0xe2, 0x99, 0x81];

/**
 * The format of a dump from its first bytes (already decompressed if it was
 * gzip). `engine` is the target service's database: a plain SQL file with no
 * tool header — hand-written, or a dump with its comments stripped — is taken
 * as that engine's SQL, since SQL text carries no reliable dialect marker.
 * Null: not a dump this knows how to restore.
 */
export function detectSeedFormat(head: Uint8Array, engine: SeedEngine | null): SeedFormat | null {
  if (head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === "PGDMP") return "pg-custom";
  if (MONGO_ARCHIVE_MAGIC.every((b, i) => head[i] === b)) return "mongo-archive";

  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.slice(0, 16_384));
  if (/^--\s*PostgreSQL database (cluster )?dump/m.test(text)) return "pg-sql";
  if (/^--\s*(MySQL|MariaDB) dump/m.test(text) || /^\/\*!\d{5} SET /m.test(text)) return "mysql-sql";

  // Headerless SQL: mostly printable text with statements in it.
  const printable = [...text].filter((c) => c === "\n" || c === "\r" || c === "\t" || (c >= " " && c !== "�")).length;
  const looksLikeText = text.length > 0 && printable / text.length > 0.95;
  if (looksLikeText && /\b(CREATE|INSERT|COPY|ALTER|SET)\b/i.test(text)) {
    if (engine === "postgres") return "pg-sql";
    if (engine === "mysql") return "mysql-sql";
  }
  return null;
}

/**
 * Why a format cannot go into a service, or null when it can. Worded for the
 * person who picked the file: both sides named.
 */
export function seedMismatch(format: SeedFormat, engine: SeedEngine | null, image: string | null): string | null {
  if (!engine) {
    return `${image ?? "This service"} is not a database a seed can restore into (PostgreSQL, MySQL/MariaDB or MongoDB).`;
  }
  const wanted = FORMAT_ENGINE[format];
  return wanted === engine
    ? null
    : `That file is a ${FORMAT_LABEL[format]}, but ${image ?? "this service"} runs ${engine === "mysql" ? "MySQL/MariaDB" : engine === "mongo" ? "MongoDB" : "PostgreSQL"}.`;
}
