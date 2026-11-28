import assert from "node:assert/strict";
import { test } from "node:test";

import { isMissingClaudeToken, looksLikeClaudeToken, NO_CLAUDE_TOKEN } from "./claude-setup";

test("the runners' missing-token error is recognised, others are not", () => {
  assert.ok(isMissingClaudeToken(NO_CLAUDE_TOKEN));
  assert.ok(!isMissingClaudeToken("Docker is not running"));
  assert.ok(!isMissingClaudeToken(null));
});

test("a setup-token token passes the shape check, junk does not", () => {
  assert.ok(looksLikeClaudeToken(`sk-ant-oat01-${"a".repeat(40)}`));
  assert.ok(!looksLikeClaudeToken("hola"));
  assert.ok(!looksLikeClaudeToken("sk-ant-oat01-short"));
});
