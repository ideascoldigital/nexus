import assert from "node:assert/strict";
import { test } from "node:test";

import {
  asObject,
  optionalEnum,
  optionalInt,
  optionalString,
  requiredEnum,
  requiredString,
} from "./args";
import { ToolInputError } from "./types";

// The input boundary: everything here is parsing what a client sent, so the
// interesting cases are the malformed ones.

test("a missing argument object is treated as empty", () => {
  // MCP clients omit `arguments` entirely for a no-argument tool.
  assert.deepEqual(asObject(undefined), {});
  assert.deepEqual(asObject(null), {});
});

test("a non-object argument payload is refused", () => {
  assert.throws(() => asObject("projectId=1"), ToolInputError);
  assert.throws(() => asObject(["p1"]), ToolInputError);
  assert.throws(() => asObject(42), ToolInputError);
});

test("a required string is returned trimmed", () => {
  assert.equal(requiredString({ a: "  x  " }, "a"), "x");
});

test("a required string that is absent, blank or not a string is refused", () => {
  for (const value of [undefined, null, "", "   ", 1, true, {}, []]) {
    assert.throws(
      () => requiredString({ a: value }, "a"),
      ToolInputError,
      `${JSON.stringify(value)} should be refused`,
    );
  }
});

test("the error names the argument, so a client can fix it", () => {
  assert.throws(() => requiredString({}, "projectId"), /projectId/);
});

test("an optional string collapses blank to undefined", () => {
  // "" and "   " mean "not provided", not "provided as empty" — otherwise an
  // empty form field would be sent as a real value.
  assert.equal(optionalString({ a: "   " }, "a"), undefined);
  assert.equal(optionalString({ a: undefined }, "a"), undefined);
  assert.equal(optionalString({}, "a"), undefined);
  assert.equal(optionalString({ a: " x " }, "a"), "x");
});

test("an optional string that is the wrong type is still refused", () => {
  assert.throws(() => optionalString({ a: 5 }, "a"), ToolInputError);
});

test("an optional integer is clamped into range rather than refused", () => {
  const range = { min: 1, max: 100 };
  assert.equal(optionalInt({ a: 500 }, "a", range), 100);
  assert.equal(optionalInt({ a: 0 }, "a", range), 1);
  assert.equal(optionalInt({ a: -5 }, "a", range), 1);
  assert.equal(optionalInt({ a: 50 }, "a", range), 50);
});

test("a fractional integer is floored, and a non-number refused", () => {
  const range = { min: 1, max: 100 };
  assert.equal(optionalInt({ a: 10.9 }, "a", range), 10);
  assert.throws(() => optionalInt({ a: "10" }, "a", range), ToolInputError);
  assert.throws(() => optionalInt({ a: NaN }, "a", range), ToolInputError);
  assert.throws(() => optionalInt({ a: Infinity }, "a", range), ToolInputError);
});

test("an absent optional integer stays absent", () => {
  assert.equal(optionalInt({}, "a", { min: 1, max: 10 }), undefined);
});

test("an enum accepts only its listed values", () => {
  const allowed = ["pause", "resume"] as const;
  assert.equal(requiredEnum({ a: "pause" }, "a", allowed), "pause");
  assert.throws(() => requiredEnum({ a: "destroy" }, "a", allowed), ToolInputError);
  assert.throws(() => requiredEnum({}, "a", allowed), ToolInputError);
});

test("an enum error lists what would have been accepted", () => {
  assert.throws(
    () => requiredEnum({ a: "destroy" }, "a", ["pause", "resume"] as const),
    /pause, resume/,
  );
});

test("an optional enum may be absent but not wrong", () => {
  const allowed = ["civo", "aws"] as const;
  assert.equal(optionalEnum({}, "a", allowed), undefined);
  assert.equal(optionalEnum({ a: "aws" }, "a", allowed), "aws");
  assert.throws(() => optionalEnum({ a: "gcp" }, "a", allowed), ToolInputError);
});
