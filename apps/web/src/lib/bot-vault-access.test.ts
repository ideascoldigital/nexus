import assert from "node:assert/strict";
import test from "node:test";

import { checkVault, grantVault, revokeVault } from "./bot-vault-access";

test("a vault token works for its bot while the prompt runs, then never again", () => {
  const t = grantVault({ botId: "b1", runId: "r1", container: "c1" , dockerHost: null });
  assert.equal(checkVault(t, "b1")?.runId, "r1");
  assert.equal(checkVault(t, "b2"), null); // another bot's computer
  assert.equal(checkVault("nope", "b1"), null);
  assert.equal(checkVault(null, "b1"), null);
  revokeVault(t);
  assert.equal(checkVault(t, "b1"), null);
});
