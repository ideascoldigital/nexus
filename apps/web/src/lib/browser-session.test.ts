import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above ./browser-session — it reaches prisma at import
// time and the client is built when the module loads.
import "./browser-session.test-setup";
import { endpointForwardArgs, forwardArgs, generateToken } from "./browser-session";

const BASE = {
  localPort: 45123,
  remotePort: 6080,
  host: "203.0.113.10",
  user: "nexus",
  privateKeyPath: "/data/ssh/id_ed25519",
};

test("the forward binds loopback on both ends", () => {
  const args = forwardArgs(BASE);
  const spec = args[args.indexOf("-L") + 1];
  // ssh honours GatewayPorts, so the local bind address is not a default worth
  // trusting: without it a config could publish the sandbox's browser to this
  // machine's whole network.
  assert.equal(spec, "127.0.0.1:45123:127.0.0.1:6080");
  assert.ok(!args.some((a) => a.includes("0.0.0.0")));
  assert.ok(!args.some((a) => a.includes("*:")));
});

test("the forward carries no remote command", () => {
  // -N: this connection exists only to forward. A shell here would be a second
  // way onto the instance that nothing supervises.
  assert.ok(forwardArgs(BASE).includes("-N"));
});

test("a forward that cannot bind fails instead of connecting anyway", () => {
  // Without ExitOnForwardFailure ssh connects, logs, and leaves a session the
  // UI believes is serving a port nothing listens on.
  assert.ok(forwardArgs(BASE).includes("ExitOnForwardFailure=yes"));
});

test("only the sandbox key is offered", () => {
  const args = forwardArgs(BASE);
  // Agent-loaded keys otherwise exhaust the server's MaxAuthTries before the
  // right one is ever tried.
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.equal(args[args.indexOf("-i") + 1], BASE.privateKeyPath);
});

test("a dead instance drops the forward instead of hanging", () => {
  const args = forwardArgs(BASE);
  assert.ok(args.includes("ServerAliveInterval=15"));
  assert.ok(args.includes("ConnectTimeout=15"));
});

test("the target is the last argument, user@host", () => {
  const args = forwardArgs(BASE);
  assert.equal(args[args.length - 1], "nexus@203.0.113.10");
});

test("the token is exactly what the VNC protocol keeps", () => {
  // VNC truncates the password to 8 bytes. Generating more would be theatre:
  // the extra characters are discarded, so the secret shown would not be the
  // one that authenticates.
  for (let i = 0; i < 50; i++) {
    const token = generateToken();
    assert.equal(token.length, 8);
    assert.match(token, /^[a-zA-Z0-9]+$/);
  }
});

test("tokens differ between sessions", () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
  // Not a randomness test — a constant or a per-process value would show here.
  assert.ok(seen.size > 190, `expected distinct tokens, got ${seen.size}/200`);
});

test("the token alphabet avoids characters that misread when retyped", () => {
  const joined = Array.from({ length: 300 }, () => generateToken()).join("");
  for (const ambiguous of ["l", "I", "O", "o", "0", "1", "B", "8"]) {
    assert.ok(
      !joined.includes(ambiguous),
      `${ambiguous} is easy to misread and should not appear`,
    );
  }
});

// --- forwards to another machine's Docker (spec 26) -------------------------

test("an endpoint forward lands on the remote's loopback, through the user's own ssh", () => {
  const args = endpointForwardArgs({
    localPort: 51000,
    remotePort: 49153,
    dockerHost: "ssh://jairo@omarchy:2222",
  });
  // Loopback on both ends: docker published the bridge on the remote's
  // 127.0.0.1 only, and this end must not offer it to the LAN.
  assert.ok(args.includes("127.0.0.1:51000:127.0.0.1:49153"), args.join(" "));
  assert.deepEqual(args.slice(-2), ["--", "jairo@omarchy"]);
  assert.ok(args.includes("-p") && args[args.indexOf("-p") + 1] === "2222");
  // The sandbox key is authorized inside sandboxes, not on the endpoint.
  assert.ok(!args.includes("-i"), args.join(" "));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
});

test("an ssh-config alias forwards with no user and no port of its own", () => {
  const args = endpointForwardArgs({ localPort: 1, remotePort: 2, dockerHost: "ssh://omarchy" });
  assert.equal(args.at(-1), "omarchy");
  assert.ok(!args.includes("-p"));
});

test("a host that is not an endpoint never becomes an ssh argument", () => {
  assert.throws(
    () => endpointForwardArgs({ localPort: 1, remotePort: 2, dockerHost: "tcp://box:2375" }),
    /Not a Docker endpoint host/,
  );
});
