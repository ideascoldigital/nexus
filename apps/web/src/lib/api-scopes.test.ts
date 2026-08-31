import assert from "node:assert/strict";
import { test } from "node:test";

import { SCOPES } from "@nexux/mcp";

import { API_SCOPES, isApiScope } from "./api-scopes";

/**
 * The scope list exists twice on purpose: `@nexux/mcp` must not import the web
 * app (it is meant to be publishable on its own), and the app must not import
 * a package to render a settings checkbox. This file is what stops the two
 * copies drifting — a scope added on one side and not the other would either
 * mint tokens carrying a scope no tool honours, or ship a tool no token can
 * ever be granted.
 */

test("the app and the package agree on the scope list", () => {
  assert.deepEqual([...API_SCOPES], [...SCOPES]);
});

test("every scope the package declares is one the app can validate", () => {
  for (const scope of SCOPES) {
    assert.ok(isApiScope(scope), `${scope} is not accepted by the app`);
  }
});
