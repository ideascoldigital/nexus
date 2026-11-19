-- The interactive browser session on a sandbox (spec 23).
--
-- A sandbox running a front end and a back end cannot be tested through
-- tunnels: each process gets its own random public hostname, so the front's
-- API_URL is wrong from the viewer's browser whatever it says, and rewriting it
-- per start only trades that for a stale build-time value. Inside the sandbox
-- both services are plain localhost ports that already agree — so the browser
-- runs there, and the dashboard reaches it over an SSH port-forward.
--
-- Never a public tunnel. The exposed object is a browser with unrestricted
-- access to that instance's localhost, which means the checkouts, the .env
-- files and the git credentials on it. `cdpPort` is loopback-only for the same
-- reason: an open Chrome DevTools port is remote code execution with extra
-- steps, able to read any origin the browser can — file:// included.
--
-- One row per sandbox (the unique index, not just an index): a second session
-- would need its own display, port trio and supervision to solve a problem
-- nobody has. Starting again replaces the one that is there.
--
-- `token` is the VNC password, generated per session. It is written on the
-- instance with `x11vnc -storepasswd` into a 0600 file, never passed on a
-- command line — /proc/<pid>/cmdline is world-readable.
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sandboxId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "display" TEXT NOT NULL DEFAULT ':99',
    "vncPort" INTEGER NOT NULL DEFAULT 5900,
    "wsPort" INTEGER NOT NULL DEFAULT 6080,
    "cdpPort" INTEGER NOT NULL DEFAULT 9222,
    "token" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1440,
    "height" INTEGER NOT NULL DEFAULT 900,
    "error" TEXT,
    "startedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BrowserSession_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Unique: one browser per sandbox.
CREATE UNIQUE INDEX "BrowserSession_sandboxId_key" ON "BrowserSession"("sandboxId");
CREATE INDEX "BrowserSession_sandboxId_idx" ON "BrowserSession"("sandboxId");

-- Off by default, unlike the other install toggles. The session costs memory on
-- an instance nobody may be looking at, and it is only meaningful alongside the
-- Chromium `installAgentBrowser` already provides — so opting in is deliberate.
ALTER TABLE "SandboxConfig" ADD COLUMN "installBrowserSession" BOOLEAN NOT NULL DEFAULT false;
