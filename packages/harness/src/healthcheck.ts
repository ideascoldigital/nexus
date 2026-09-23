// Spec 24, piece 2 — compose healthchecks for the services we recognize.
//
// The bootstrap brings stack services up with
// `docker compose up -d --wait --wait-timeout 180`, which reads as "wait until
// they are ready". It does not: without a `healthcheck` block, compose waits
// for *running*, and for postgres that is true several seconds before it
// accepts a connection. A repo whose install runs migrations therefore loses a
// race the bootstrap believed it had already won.
//
// Derived from the image rather than carried on the node, deliberately. A
// StackNode persists its image and env; it does not persist which catalog
// entry (if any) it was created from, and a user may type `postgres:16`
// themselves or pull one from a private registry. Matching on the image means
// a hand-typed postgres gets the same readiness guarantee as a catalog one,
// and a node whose image we do not recognize simply behaves as it does today.

export type ComposeHealthcheck = {
  /** Compose's exec form: ["CMD", …] or ["CMD-SHELL", "…"]. */
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  /** Grace period before a failing check counts against `retries`. */
  start_period: string;
};

/**
 * Probes by image family.
 *
 * Each one asks the service's own protocol, not the port: a listening socket
 * is what `--wait` already effectively checks, and it is exactly the state
 * that lies. `pg_isready` completes the handshake; a TCP connect does not.
 *
 * The env vars are read inside the container (`CMD-SHELL`), so a project that
 * renamed `POSTGRES_USER` still probes as the right user, and the default
 * matches the image's own default rather than the catalog's.
 */
const PROBES: { match: RegExp; test: string[] }[] = [
  {
    // postgres, postgis, pgvector, timescale — all ship pg_isready.
    match: /(^|\/)(postgres|postgis|pgvector|timescale)/i,
    test: ["CMD-SHELL", 'pg_isready -U "${POSTGRES_USER:-postgres}" -q'],
  },
  {
    match: /(^|\/)(mysql|mariadb|percona)/i,
    // -h 127.0.0.1 rather than localhost: mysqladmin reads "localhost" as a
    // unix socket, which is up before the network listener a client will use.
    test: [
      "CMD-SHELL",
      'mysqladmin ping -h 127.0.0.1 --silent || mariadb-admin ping -h 127.0.0.1 --silent',
    ],
  },
  {
    match: /(^|\/)redis|(^|\/)valkey/i,
    test: ["CMD-SHELL", 'redis-cli ping | grep -q PONG'],
  },
  {
    match: /(^|\/)mongo/i,
    // mongosh on 6+, mongo on older images: the tags differ across projects
    // and only one of the two binaries exists in any given image.
    test: [
      "CMD-SHELL",
      `mongosh --quiet --eval 'db.adminCommand("ping")' || mongo --quiet --eval 'db.adminCommand("ping")'`,
    ],
  },
  {
    match: /(^|\/)minio/i,
    // MinIO's own liveness endpoint; it 200s only once the object store is
    // serving, which is later than the process binding :9000.
    test: ["CMD-SHELL", "curl -fsS http://localhost:9000/minio/health/live"],
  },
  {
    match: /(^|\/)ollama/i,
    // The image has no curl; its own CLI is the dependable probe.
    test: ["CMD-SHELL", "ollama list >/dev/null 2>&1"],
  },
  {
    match: /(^|\/)(rabbitmq)/i,
    test: ["CMD-SHELL", "rabbitmq-diagnostics -q ping"],
  },
];

/**
 * Timing.
 *
 * `start_period` is what keeps a slow first boot from being reported as
 * unhealthy: inside it, a failing probe does not count against `retries`.
 * Postgres initializing a fresh data directory routinely takes longer than
 * `interval * retries` would otherwise allow, and that is the very first run
 * of every new sandbox.
 *
 * The totals stay well inside the bootstrap's existing `--wait-timeout 180`,
 * so adding a healthcheck can never make a stack that used to come up time
 * out instead.
 */
const TIMING = {
  interval: "5s",
  timeout: "3s",
  retries: 12,
  start_period: "30s",
} as const;

/** Strips the registry and tag/digest, leaving `namespace/name`. */
function imageName(image: string): string {
  // Digest first: `postgres@sha256:…` must not be split on the colon.
  const noDigest = image.split("@")[0];
  const parts = noDigest.split("/");
  const last = parts[parts.length - 1];
  // A tag's colon only ever appears in the last segment; a registry's port
  // colon appears in the first, which is why this splits the last one only.
  parts[parts.length - 1] = last.split(":")[0];
  return parts.join("/");
}

/**
 * The healthcheck for an image, or null when we do not recognize it.
 *
 * Null is a real answer, not a fallback: inventing a generic probe for an
 * unknown image would either be a port check (which tells us nothing more than
 * `--wait` already does) or a guess that marks a healthy service unhealthy and
 * blocks the whole `up`. Unknown images behave exactly as they do today.
 */
export function healthcheckFor(
  image: string | null | undefined,
): ComposeHealthcheck | null {
  if (!image?.trim()) return null;
  const name = imageName(image.trim());
  const probe = PROBES.find((p) => p.match.test(name));
  return probe ? { test: [...probe.test], ...TIMING } : null;
}
