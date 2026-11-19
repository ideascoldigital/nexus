-- SeedData: a database backup restored into one stack service when a sandbox
-- starts (spec 29). The file itself lives in the data dir, not here.
CREATE TABLE "SeedData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "stackNodeId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "gzipped" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SeedData_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SeedData_stackNodeId_fkey" FOREIGN KEY ("stackNodeId") REFERENCES "StackNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SeedData_stackNodeId_key" ON "SeedData"("stackNodeId");
CREATE INDEX "SeedData_projectId_idx" ON "SeedData"("projectId");
