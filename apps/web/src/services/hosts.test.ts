import assert from "node:assert/strict";
import { test } from "node:test";

import "./services.test-setup";
import {
  HOST_IN_FLIGHT,
  HOST_REGIONS,
  HOST_SIZES,
  type HostStatus,
} from "./hosts";

// Every host status the type allows. Kept here by hand so that adding a status
// without deciding whether it polls fails a test rather than silently landing
// on one side.
const ALL_STATUSES: HostStatus[] = [
  "pending",
  "provisioning",
  "bootstrapping",
  "running",
  "error",
  "destroying",
  "destroyed",
];

// --- HOST_IN_FLIGHT ----------------------------------------------------------
// This list is what keeps the hosts table polling. A terminal status listed
// here polls a row that will never change again; a moving status left out
// leaves the row frozen until a manual refresh.

test("the statuses that are still moving are all polled", () => {
  for (const status of ["pending", "provisioning", "bootstrapping", "destroying"] as const) {
    assert.ok(HOST_IN_FLIGHT.includes(status), `${status} is not polled`);
  }
});

test("no settled status is polled", () => {
  // running/error/destroyed are where a host stops changing. Polling them is
  // an endless request loop against a row with no further updates.
  for (const status of ["running", "error", "destroyed"] as const) {
    assert.ok(!HOST_IN_FLIGHT.includes(status), `${status} is polled forever`);
  }
});

test("every status is either in flight or settled, never unclassified", () => {
  // Guards the case this list is actually for: a new status added to the type
  // and not considered here.
  for (const status of ALL_STATUSES) {
    assert.equal(typeof HOST_IN_FLIGHT.includes(status), "boolean");
  }
  assert.equal(ALL_STATUSES.length, 7);
});

test("the in-flight list holds no duplicates", () => {
  assert.equal(new Set(HOST_IN_FLIGHT).size, HOST_IN_FLIGHT.length);
});

test("the in-flight list names only real statuses", () => {
  for (const status of HOST_IN_FLIGHT) {
    assert.ok(ALL_STATUSES.includes(status), `${status} is not a HostStatus`);
  }
});

// --- HOST_REGIONS / HOST_SIZES -----------------------------------------------
// Both feed the create-host form and are sent verbatim to the provider, so a
// stale entry is only discovered when provisioning fails.

test("both providers offer regions and sizes", () => {
  for (const provider of ["civo", "aws"] as const) {
    assert.ok(HOST_REGIONS[provider].length > 0, `${provider} has no regions`);
    assert.ok(HOST_SIZES[provider].length > 0, `${provider} has no sizes`);
  }
});

test("no region is listed twice for a provider", () => {
  for (const provider of ["civo", "aws"] as const) {
    const regions = HOST_REGIONS[provider];
    assert.equal(new Set(regions).size, regions.length, provider);
  }
});

test("no size value is listed twice for a provider", () => {
  // A duplicate value renders two identical options and makes the selected one
  // ambiguous.
  for (const provider of ["civo", "aws"] as const) {
    const values = HOST_SIZES[provider].map((s) => s.value);
    assert.equal(new Set(values).size, values.length, provider);
  }
});

test("every size has a label, and the label names its value", () => {
  // The dropdown shows only the label; one that does not start with the value
  // being sent is how the wrong instance type gets picked.
  for (const provider of ["civo", "aws"] as const) {
    for (const size of HOST_SIZES[provider]) {
      assert.ok(size.label.length > 0, `${size.value} has no label`);
      assert.ok(
        size.label.startsWith(size.value),
        `${size.value} label does not name it: ${size.label}`,
      );
    }
  }
});

test("civo sizes are all on one generation", () => {
  // The catalog moved g3 -> g4 wholesale. A half-migrated list passes type
  // checking and fails only at provision time, on whichever size was missed.
  for (const size of HOST_SIZES.civo) {
    assert.ok(
      size.value.startsWith("g4s."),
      `${size.value} is not a g4 size`,
    );
  }
});

test("aws sizes are all instance types, not civo ones", () => {
  for (const size of HOST_SIZES.aws) {
    assert.ok(size.value.includes("."), `${size.value} is not an instance type`);
    assert.ok(!size.value.startsWith("g4s."), `${size.value} is a civo size`);
  }
});

test("civo regions are the uppercase codes civo uses", () => {
  // Civo matches these case-sensitively; a lowercased code is rejected.
  for (const region of HOST_REGIONS.civo) {
    assert.equal(region, region.toUpperCase(), `${region} is not uppercase`);
  }
});

test("aws regions are the lowercase codes aws uses", () => {
  for (const region of HOST_REGIONS.aws) {
    assert.equal(region, region.toLowerCase(), `${region} is not lowercase`);
    assert.match(region, /^[a-z]{2}-[a-z]+-\d$/, `${region} is malformed`);
  }
});

test("exactly one size per provider is marked recommended", () => {
  // The form preselects it; two recommendations or none makes that arbitrary.
  for (const provider of ["civo", "aws"] as const) {
    const recommended = HOST_SIZES[provider].filter((s) =>
      s.label.includes("(recommended)"),
    );
    assert.equal(recommended.length, 1, provider);
  }
});

test("the sizes that cannot run embeddings say so", () => {
  // Embeddings need headroom for the model. A 2 GB host that does not warn is
  // how someone provisions one and finds search silently unavailable.
  for (const provider of ["civo", "aws"] as const) {
    const smallest = HOST_SIZES[provider][0];
    assert.match(smallest.label, /no embeddings/, provider);
  }
});
