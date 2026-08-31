-- AlterTable
ALTER TABLE "Message" ADD COLUMN "agentRole" TEXT;

-- CreateTable
CREATE TABLE "Phase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'locked',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Phase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "conversationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectDocumentSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "phaseKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "ownerRole" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'empty',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectDocumentSection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ProjectDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectDocumentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectDocumentRevision_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ProjectDocumentSection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectDocumentRevision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Phase_projectId_order_idx" ON "Phase"("projectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Phase_projectId_key_key" ON "Phase"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocument_projectId_key" ON "ProjectDocument"("projectId");

-- CreateIndex
CREATE INDEX "ProjectDocumentSection_documentId_order_idx" ON "ProjectDocumentSection"("documentId", "order");

-- CreateIndex
CREATE INDEX "ProjectDocumentSection_phaseKey_idx" ON "ProjectDocumentSection"("phaseKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocumentSection_documentId_key_key" ON "ProjectDocumentSection"("documentId", "key");

-- CreateIndex
CREATE INDEX "ProjectDocumentRevision_sectionId_createdAt_idx" ON "ProjectDocumentRevision"("sectionId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_agentRole_idx" ON "Message"("agentRole");
