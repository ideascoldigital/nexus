-- A repository is not a node (spec 25 piece 1).
--
-- `StackNode.repositoryId` was UNIQUE, which encoded "one repo, one node" in
-- the schema itself. That holds for a repo with a single app and breaks for
-- every other shape a project actually arrives in: a monorepo with `apps/web`
-- and `apps/api` needs two nodes pointing at the same Repository, and could
-- not have them.
--
-- The stack describes what *boots*; a git is how the code arrived. Discovering
-- runnable units (lib/stack/units.ts) and detecting each one makes the number
-- of repositories irrelevant — but only once the database stops insisting on
-- the old model.
--
-- Nothing depended on the uniqueness: every read is by `id`, and the one query
-- that filters on this column (the detect route, re-deriving phases after a
-- rescan) already uses findMany. The index stays as a plain one, because that
-- query is exactly what it exists to serve.
DROP INDEX "StackNode_repositoryId_key";

CREATE INDEX "StackNode_repositoryId_idx" ON "StackNode"("repositoryId");
