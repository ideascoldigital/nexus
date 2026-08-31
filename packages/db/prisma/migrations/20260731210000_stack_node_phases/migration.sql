-- Ordered StackPhase[] on the stack node: the node's commands, each declaring
-- what it does (install/build/services/run/stop) and what executes it (host,
-- compose, compose-extern, container). See spec 17 / D-20.
--
-- runMode + the loose command columns could not express a repo that installs on
-- the host, brings infra up in Docker and then runs the app — that needed two
-- nodes for one repo. Nor could `managesServices` say *which* containers a
-- launcher starts, so status scanned directories and `needsDocker` missed a
-- `make dev` whose recipe is `docker compose up`.
ALTER TABLE "StackNode" ADD COLUMN "phases" JSONB;

-- Deliberately not backfilled here. Deriving a phase means reading the node's
-- cached detection to find the `make` target a command invokes and what its
-- recipe does — `phasesOf()` in apps/web/src/lib/stack/phases.ts. Reimplementing
-- that in SQL would be a second, silently diverging copy of the rule.
--
-- Instead the column stays NULL and readers fall back to deriving on the fly,
-- which is exactly what they did before this migration. Rows fill in as they
-- are saved, or in one pass via `pnpm --filter @nexux/web stack:backfill-phases`.
