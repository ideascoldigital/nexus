-- DockerEndpoint: another machine's Docker daemon local sandboxes can run on
-- (spec 26). Machine-level, not workspace-scoped — a place, not a secret.
CREATE TABLE "DockerEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "serverVersion" TEXT,
    "arch" TEXT,
    "memTotalMb" INTEGER,
    "lastCheckedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "DockerEndpoint_host_key" ON "DockerEndpoint"("host");

-- Null = this machine's daemon, which is every sandbox that exists today.
-- ADD COLUMN rather than Prisma's table redefinition: a nullable column with
-- a NULL default is one SQLite can add with its REFERENCES in place, and
-- copying every Sandbox row to gain an empty column is risk for nothing.
ALTER TABLE "Sandbox" ADD COLUMN "dockerEndpointId" TEXT REFERENCES "DockerEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
