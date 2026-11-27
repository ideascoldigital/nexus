import assert from "node:assert/strict";
import { test } from "node:test";

import { approveConfirmation, dropConfirmation, requireConfirmation } from "./nexus-confirmations";

const launch = { key: '["launch","p1","civo",null]', summary: "launch a civo sandbox" };

test("spending waits for the user's tap, and one tap allows exactly one try", () => {
  const id = requireConfirmation("bot1", launch)!;
  assert.match(id, /^act_/);
  assert.equal(requireConfirmation("bot1", launch), id); // asking again is the same card
  assert.equal(approveConfirmation("bot2", id), null); // another chat cannot approve it
  assert.deepEqual(approveConfirmation("bot1", id), { summary: "launch a civo sandbox" });
  assert.equal(requireConfirmation("bot1", launch), null); // approved: go
  assert.notEqual(requireConfirmation("bot1", launch), null); // used up: ask again
});

test("an approval is for that action only, and cancel drops it", () => {
  const id = requireConfirmation("bot3", launch)!;
  approveConfirmation("bot3", id);
  assert.notEqual(requireConfirmation("bot3", { ...launch, key: '["launch","p1","aws",null]' }), null);
  const other = requireConfirmation("bot4", launch)!;
  assert.equal(dropConfirmation("bot4", other), true);
  assert.equal(approveConfirmation("bot4", other), null);
});
