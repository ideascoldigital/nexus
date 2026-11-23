-- Bots can run their computers on a Docker endpoint (spec 26, D-85), not only
-- on whatever this machine's docker context points at.
--
-- Bot.dockerEndpointId is the choice. SET NULL: removing the endpoint drops
-- the bot back to this machine rather than leaving a row that points nowhere
-- — the API refuses the removal while any of its computers is still up.
ALTER TABLE "Bot" ADD COLUMN "dockerEndpointId" TEXT REFERENCES "DockerEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BotSession.dockerHost is where the container actually is, copied at launch,
-- for the same reason Sandbox keeps one: every exec, stop and recovery path
-- finds the right daemon without a join, and it cannot drift when the bot is
-- pointed elsewhere afterwards. NULL = this machine.
ALTER TABLE "BotSession" ADD COLUMN "dockerHost" TEXT;
