import { strict as assert } from "node:assert";
import { test } from "node:test";

import { clampPanelWidth } from "./use-resizable-panel";

// The drawer width is restored from localStorage before React knows how big
// the window is. These cover the boundary behaviour that decides whether a
// remembered width survives that restore.

const bounds = { minWidth: 360, maxWidthGap: 120 };

test("keeps a width that already fits", () => {
  assert.equal(clampPanelWidth(576, { ...bounds, viewport: 1440 }), 576);
});

test("raises a too-small width to the minimum", () => {
  assert.equal(clampPanelWidth(120, { ...bounds, viewport: 1440 }), 360);
});

test("caps the width so a strip of the page stays clickable", () => {
  assert.equal(clampPanelWidth(2000, { ...bounds, viewport: 1440 }), 1320);
});

test("an unmeasured viewport does not shrink a stored width", () => {
  // Regression: clamping against innerWidth === 0 collapsed every restored
  // width down to minWidth, so a resized drawer reopened tiny.
  assert.equal(clampPanelWidth(845, { ...bounds, viewport: 0 }), 845);
  assert.equal(clampPanelWidth(845, { ...bounds, viewport: -1 }), 845);
});

test("the minimum still applies without a viewport", () => {
  assert.equal(clampPanelWidth(50, { ...bounds, viewport: 0 }), 360);
});

test("the minimum wins on a viewport narrower than the panel", () => {
  // A 400px window can't honour both the gap and the minimum — staying
  // usable beats leaving the strip.
  assert.equal(clampPanelWidth(576, { ...bounds, viewport: 400 }), 360);
});
