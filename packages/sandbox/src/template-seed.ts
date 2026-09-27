/**
 * Restoring a project's seed data into its stack services (spec 29 phase 2).
 *
 * Rendered into the bootstrap right after `stack:up` and before the setup
 * script and the repos — the repos' install commands are where migrations
 * run, and they should meet the seeded database, not an empty one.
 *
 * The file does not travel in the script (cloud-init caps user-data at
 * 16–64 KB). The server pushes it to `/opt/nexus/.seeds/<service>/` while the
 * bootstrap runs and writes `.ready` last; this waits for that marker, checks
 * the sha256, and streams the file into the service's own client inside its
 * container. Credentials come from that container's env — the same values
 * the node declares and the repos' DATABASE_URL points at — and are expanded
 * inside the container, so none of them reaches the bootstrap log.
 */

import { stepChain } from "./bootstrap-report";
import { shq } from "./slug";

export const SEEDS_DIR = "/opt/nexus/.seeds";
export const SEED_READY_MARKER = ".ready";
const STACK_COMPOSE = "/opt/nexus/stack/docker-compose.yml";

export type SeedFormat = "pg-sql" | "pg-custom" | "mysql-sql" | "mongo-archive";

export type SandboxSeedSpec = {
  /** Compose service name the seed restores into. */
  service: string;
  fileName: string;
  format: SeedFormat;
  gzipped: boolean;
  sha256: string;
  sizeBytes: number;
};

export const seedRemoteDir = (service: string) => `${SEEDS_DIR}/${service}`;

/**
 * How long to wait for the pushed file: 15 minutes, plus a minute per 100 MB
 * — a slow uplink to a cloud VM is the case this exists for. Past it the
 * sandbox continues with an empty database: a missing seed is not worth a
 * dead sandbox.
 */
export function seedWaitSeconds(sizeBytes: number): number {
  return 900 + Math.ceil(sizeBytes / (100 * 1024 * 1024)) * 60;
}

/**
 * Wait until the service answers over TCP. The official images initialise on
 * a temporary server that only listens on the socket (postgres:
 * listen_addresses='', mysql/mariadb: --skip-networking), then restart; a
 * restore into that temporary server is killed halfway. TCP on 127.0.0.1 is
 * only served by the final one. Mongo's init server does bind 127.0.0.1, so
 * it waits for the entrypoint's temporary config file to be gone as well.
 */
const READY: Record<SeedFormat, string> = {
  "pg-sql": `pg_isready -q -h 127.0.0.1 -U "\${POSTGRES_USER:-postgres}"`,
  "pg-custom": `pg_isready -q -h 127.0.0.1 -U "\${POSTGRES_USER:-postgres}"`,
  "mysql-sql": `MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-\${MARIADB_ROOT_PASSWORD:-}}" "$(command -v mariadb-admin || command -v mysqladmin)" -h127.0.0.1 -uroot ping >/dev/null 2>&1`,
  "mongo-archive": `test ! -e /tmp/docker-entrypoint-temp-config.json && "$(command -v mongosh || command -v mongo)" --quiet --eval "db.runCommand({ping:1})" >/dev/null 2>&1`,
};

/**
 * The restore, reading the dump on stdin. Plain SQL is not run with
 * ON_ERROR_STOP (and MySQL runs with --force): a production dump's
 * `ALTER … OWNER TO prod_user` fails on a database without that role, and
 * stopping there would throw away every row after it. The errors are counted
 * and reported instead.
 */
const RESTORE: Record<SeedFormat, string> = {
  "pg-sql": `psql -q -h 127.0.0.1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"`,
  "pg-custom": `pg_restore --no-owner --no-acl -h 127.0.0.1 -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"`,
  "mysql-sql": `MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-\${MARIADB_ROOT_PASSWORD:-}}" "$(command -v mariadb || command -v mysql)" --force -h127.0.0.1 -uroot \${MYSQL_DATABASE:-\${MARIADB_DATABASE:-}}`,
  "mongo-archive": `mongorestore --quiet --archive --drop \${MONGO_INITDB_ROOT_USERNAME:+--username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}`,
};

/** Password env the container needs for TCP to its own postgres. */
const PG_PASSWORD = `PGPASSWORD="\${POSTGRES_PASSWORD:-}"`;

const WAIT_READY = (format: SeedFormat) =>
  `i=0; until ${READY[format]}; do i=$((i+1)); [ $i -ge 90 ] && { echo "service not ready after 180s" >&2; exit 1; }; sleep 2; done; `;

/**
 * Empty the database before a reset restores into it, so a reset is the seed
 * and nothing else — not the seed on top of whatever the sandbox wrote since.
 * Postgres connects to template1 (never to the database being dropped) and
 * ends its sessions first — the app holds connections open, and DROP DATABASE
 * refuses while any exist. MySQL without MYSQL_DATABASE is left alone: a dump
 * of the whole server creates its own databases. mongorestore --drop already
 * replaces each collection it restores.
 */
const RECREATE: Record<SeedFormat, string> = {
  "pg-sql": PG_RECREATE(),
  "pg-custom": PG_RECREATE(),
  "mysql-sql": `DB="\${MYSQL_DATABASE:-\${MARIADB_DATABASE:-}}"; if [ -n "$DB" ]; then MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-\${MARIADB_ROOT_PASSWORD:-}}" "$(command -v mariadb || command -v mysql)" -h127.0.0.1 -uroot -e "DROP DATABASE IF EXISTS \\\`$DB\\\`; CREATE DATABASE \\\`$DB\\\`"; fi; `,
  "mongo-archive": "",
};

function PG_RECREATE(): string {
  return (
    `U="\${POSTGRES_USER:-postgres}"; D="\${POSTGRES_DB:-$U}"; ` +
    `psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$U" -d template1 ` +
    `-c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$D' AND pid <> pg_backend_pid()" ` +
    `-c "DROP DATABASE IF EXISTS \\"$D\\"" -c "CREATE DATABASE \\"$D\\" OWNER \\"$U\\"" >/dev/null || exit 1; `
  );
}

function restoreInContainer(format: SeedFormat, recreate = false): string {
  const pg = format === "pg-sql" || format === "pg-custom" ? `export ${PG_PASSWORD}; ` : "";
  return `${pg}${WAIT_READY(format)}${recreate ? RECREATE[format] : ""}${RESTORE[format]}`;
}

function assertService(service: string) {
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(service)) {
    throw new Error(`Invalid compose service name for a seed: ${JSON.stringify(service)}`);
  }
}

/**
 * The shared tail of a restore: stream the file in, count the errors it
 * survived, report. Exits non-zero only when the client itself failed.
 */
function restoreLines(seed: SandboxSeedSpec, recreate: boolean): string[] {
  const file = `${seedRemoteDir(seed.service)}/${seed.fileName}`;
  const log = `/var/log/nexus-seed-${seed.service}.log`;
  const read = seed.gzipped ? `gunzip -c ${shq(file)}` : `cat ${shq(file)}`;
  const exec = `docker compose -f ${STACK_COMPOSE} exec -T ${seed.service} sh -c ${shq(restoreInContainer(seed.format, recreate))}`;
  return [
    `echo ${shq(`${seed.sha256}  ${file}`)} | sha256sum -c --status || { echo "[nexux] WARN: seed for ${seed.service} is corrupt (sha256 mismatch) — not restored"; exit 1; }`,
    `echo "[nexux] restoring seed into ${seed.service} (${seed.fileName})"`,
    `started=$(date +%s)`,
    `${read} | ${exec} > ${log} 2>&1; rc=$?`,
    // Errors a restore printed but survived (plain SQL, pg_restore's
    // "errors ignored on restore") are surfaced as a count, not a failure.
    `errs=$(grep -c -E "ERROR|pg_restore: error|Failed:" ${log} || true)`,
    `note=""; [ "\${errs:-0}" -gt 0 ] && note=", $errs error line(s) — see ${log}"`,
    `echo "[nexux] seed ${seed.service}: restored in $(( $(date +%s) - started ))s$note"`,
    `[ "$rc" -eq 0 ] || { tail -n 20 ${log}; exit 1; }`,
  ];
}

/** One bootstrap section per seed, in the order given. */
export function renderSeedRestore(seeds: SandboxSeedSpec[]): string {
  return seeds
    .map((seed) => {
      assertService(seed.service);
      const dir = seedRemoteDir(seed.service);
      const log = `/var/log/nexus-seed-${seed.service}.log`;
      const wait = seedWaitSeconds(seed.sizeBytes);
      const body = [
        `w=0; until [ -f ${shq(`${dir}/${SEED_READY_MARKER}`)} ]; do w=$((w+5)); [ $w -ge ${wait} ] && { echo "[nexux] WARN: seed for ${seed.service} never arrived — continuing with an empty database"; exit 1; }; sleep 5; done`,
        ...restoreLines(seed, false),
      ].join("\n");
      return `echo "[nexux] seed data: ${seed.service} waits for its file"
if command -v docker >/dev/null 2>&1 && [ -f ${STACK_COMPOSE} ]; then
  ${stepChain(`seed:${seed.service}`, "warn", `bash -c ${shq(body)}`, `echo "[nexux] WARN: seed data for ${seed.service} was not restored (see ${log})"`)}
else
  echo "[nexux] WARN: no stack services running — seed for ${seed.service} skipped"
fi`;
    })
    .join("\n\n");
}

/**
 * Reset a running sandbox's service to its seed (spec 29 phase 3): empty the
 * database, restore. Run as root with the file already in place — the caller
 * pushes it first when the seed changed since launch.
 */
export function renderSeedReset(seed: SandboxSeedSpec): string {
  assertService(seed.service);
  return [`set -o pipefail 2>/dev/null; cd /opt/nexus/stack || exit 1`, ...restoreLines(seed, true)].join("\n");
}

/** Shell that prints the sha256 of the seed file on the instance, or nothing. */
export function seedRemoteShaCommand(seed: Pick<SandboxSeedSpec, "service" | "fileName">): string {
  return `sha256sum ${shq(`${seedRemoteDir(seed.service)}/${seed.fileName}`)} 2>/dev/null | cut -d' ' -f1`;
}
