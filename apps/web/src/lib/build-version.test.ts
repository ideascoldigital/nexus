import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVersion, releaseOf, resolveVersion } from "./build-version";

test("releaseOf names the tag a describe counts from", () => {
  // Only the release part of a describe exists on GitHub; the whole string
  // linked to a 404.
  assert.equal(releaseOf("0.1.6-3-g586da57"), "0.1.6");
  assert.equal(releaseOf("v0.1.6"), "0.1.6");
  assert.equal(releaseOf("0.1.6"), "0.1.6");
  assert.equal(releaseOf("1.0.0+build.5"), "1.0.0");
});

const never = () => {
  throw new Error("must not be consulted");
};

test("a baked version wins, with its v stripped", async () => {
  // The image build is the one source that cannot be wrong about itself.
  assert.equal(await resolveVersion("v0.2.0", never, "0.1.4"), "0.2.0");
  assert.equal(await resolveVersion("0.2.0", never, "0.1.4"), "0.2.0");
});

test("an empty NEXUX_VERSION falls through instead of blanking the version", async () => {
  // How every `edge` image was built before release-image.yml learned to
  // derive one: the arg was passed, empty. Treated as a value it would have
  // reported "" as the version.
  const described = async () => "0.1.6-3-g586da57";
  assert.equal(await resolveVersion("", described, "0.1.4"), "0.1.6-3-g586da57");
  assert.equal(
    await resolveVersion("   ", described, "0.1.4"),
    "0.1.6-3-g586da57",
  );
});

test("a dev checkout describes the tree instead of reading package.json", async () => {
  // package.json is three releases stale in this very repo — v0.1.5 and v0.1.6
  // both still carry 0.1.4 — so trusting it made dev report a version the tree
  // had long passed, and the statusbar offer an update it already contained.
  assert.equal(
    await resolveVersion(undefined, async () => "0.1.6-3-g586da57", "0.1.4"),
    "0.1.6-3-g586da57",
  );
});

test("package.json is the last resort, not the first", async () => {
  // A fresh fork with no tags, or an image with no .git and no baked arg.
  assert.equal(
    await resolveVersion(undefined, async () => null, "0.1.4"),
    "0.1.4",
  );
});

test("buildVersion resolves this checkout to a real semver", async () => {
  // The wiring, once, against the actual repo — the injected cases above say
  // nothing about whether `git describe` is called correctly.
  const version = await buildVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, `got ${version}`);
  assert.doesNotMatch(version, /^v/, "the v prefix is stripped");
});
