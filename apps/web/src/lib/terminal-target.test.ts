import { strict as assert } from "node:assert";
import { test } from "node:test";

import { dockerTerminalTarget, terminalTargetAuthority } from "./terminal-target";

test("a container on this machine has no endpoint prefix", () => {
  assert.equal(
    dockerTerminalTarget({ instanceId: "nexux-app", dockerEndpointId: null }, "/opt/nexus"),
    "docker://nexux-app/opt/nexus",
  );
});

test("a container on another machine names the endpoint, never the host", () => {
  assert.equal(
    dockerTerminalTarget({ instanceId: "nexux-app", dockerEndpointId: "cmep1" }, "/opt/nexus"),
    "docker://cmep1@nexux-app/opt/nexus",
  );
  assert.equal(dockerTerminalTarget({ instanceId: null, dockerEndpointId: "cmep1" }, ""), null);
});

test("restored tabs are keyed by container or host, whatever the prefix", () => {
  assert.equal(terminalTargetAuthority("docker://cmep1@nexux-app/opt/nexus"), "nexux-app");
  assert.equal(terminalTargetAuthority("docker://nexux-app/opt/nexus"), "nexux-app");
  assert.equal(terminalTargetAuthority("ssh://nexus@1.2.3.4/opt/nexus"), "1.2.3.4");
  assert.equal(terminalTargetAuthority("/Users/me/code"), null);
});
