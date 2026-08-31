-- CreateTable
CREATE TABLE "StackNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repositoryId" TEXT,
    "name" TEXT NOT NULL,
    "runMode" TEXT NOT NULL DEFAULT 'docker',
    "image" TEXT,
    "dockerfile" TEXT,
    "buildContext" TEXT,
    "command" TEXT,
    "localCommand" TEXT,
    "workdir" TEXT,
    "ports" JSONB,
    "env" JSONB,
    "volumes" JSONB,
    "detection" JSONB,
    "posX" REAL NOT NULL DEFAULT 0,
    "posY" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StackNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StackNode_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StackEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    CONSTRAINT "StackEdge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StackEdge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "StackNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StackEdge_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "StackNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StackNode_repositoryId_key" ON "StackNode"("repositoryId");

-- CreateIndex
CREATE INDEX "StackNode_projectId_idx" ON "StackNode"("projectId");

-- CreateIndex
CREATE INDEX "StackEdge_projectId_idx" ON "StackEdge"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "StackEdge_sourceId_targetId_key" ON "StackEdge"("sourceId", "targetId");
