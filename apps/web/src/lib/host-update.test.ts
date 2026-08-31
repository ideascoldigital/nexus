/**
 * The host updating itself.
 *
 * Only the self-update half is covered here: it is the half with no shell — the
 * app writes a request file and a root-side unit acts on it — so what it writes
 * and what it says when it cannot write are the whole contract. The SSH half
 * (`updateHost`) is a `docker compose pull` over a connection to a real
 * machine; there is nothing to assert about it that does not amount to
 * re-asserting `execRemote`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

// Above the import below: host-update reaches @nexux/db through host-ssh.
import { testDbDir } from "../app/api/routes.test-setup";
import {
  isHostInstall,
  readSelfUpdateLog,
  requestSelfUpdate,
} from "./host-update";

const CONTROL = "/host-control";

afterEach(() => {
  delete process.env.NEXUX_ROLE;
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

test("only a host reports itself as one", () => {
  // The button that reaches the self-update route is rendered on this, and the
  // route refuses on it — a laptop has no stack to restart.
  assert.equal(isHostInstall(), false);
  process.env.NEXUX_ROLE = "host";
  assert.equal(isHostInstall(), true);
});

test("a missing control mount is explained, not reported as a crash", async () => {
  // The case that will actually happen: hosts provisioned before self-update
  // existed have no bind mount, so the request cannot be written. The message
  // has to name the way out rather than surfacing an ENOENT.
  if (fs.existsSync(CONTROL)) return; // A real host — nothing to simulate.

  const result = await requestSelfUpdate();
  assert.equal(result.ok, false);
  assert.match(result.message, /created before self-update existed/);
  // Names the manual fallback, since the user is standing on the machine.
  assert.match(result.message, /update\.sh/);
});

test("no log yet reads as null rather than throwing", async () => {
  if (fs.existsSync(path.join(CONTROL, "update.log"))) return;
  assert.equal(await readSelfUpdateLog(), null);
});
