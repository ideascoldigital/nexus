import assert from "node:assert/strict";
import { test } from "node:test";

import { attachedContainerAuthority } from "./vscode-launch";

const decode = (authority: string) =>
  Buffer.from(authority.replace(/^attached-container\+/, ""), "hex").toString("utf8");

test("a container on this machine keeps the bare-name authority", () => {
  assert.equal(decode(attachedContainerAuthority("nexux-app-1", null)), "nexux-app-1");
});

test("a container on another machine's Docker names that daemon as its host", () => {
  const config = JSON.parse(decode(attachedContainerAuthority("nexux-app-1", "ssh://omarchy")));
  assert.deepEqual(config, { containerName: "nexux-app-1", settings: { host: "ssh://omarchy" } });
});

