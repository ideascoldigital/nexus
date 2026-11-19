import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  clampToViewport,
  initialFloatingSpot,
  isUnplaced,
  placementKey,
  readPlacement,
  type PanelPlacement,
  type PlacementStore,
} from "./panel-placement";

/** A localStorage stand-in. `broken` makes every read throw. */
function store(
  entries: Record<string, string> = {},
  broken = false,
): PlacementStore {
  return {
    getItem(k) {
      if (broken) throw new Error("storage blocked");
      return entries[k] ?? null;
    },
    setItem(k, v) {
      if (broken) throw new Error("storage blocked");
      entries[k] = v;
    },
  };
}

const FLOATING: PanelPlacement = { mode: "floating", x: 0, y: 0 };
const VIEWPORT = { width: 1440, height: 900 };

test("a stored dock survives, which is the whole point of storing it", () => {
  const s = store({ [placementKey("propose")]: '{"mode":"docked"}' });
  assert.deepEqual(readPlacement(s, "propose", FLOATING), { mode: "docked" });
});

test("stored coordinates come back exactly", () => {
  const s = store({
    [placementKey("propose")]: '{"mode":"floating","x":180,"y":150}',
  });
  assert.deepEqual(readPlacement(s, "propose", FLOATING), {
    mode: "floating",
    x: 180,
    y: 150,
  });
});

test("each panel's placement is its own", () => {
  const s = store({ [placementKey("a")]: '{"mode":"docked"}' });
  assert.deepEqual(readPlacement(s, "a", FLOATING), { mode: "docked" });
  assert.deepEqual(readPlacement(s, "b", FLOATING), FLOATING);
});

test("nothing stored means the default", () => {
  assert.deepEqual(readPlacement(store(), "propose", FLOATING), FLOATING);
});

test("no storage at all — a server render — means the default", () => {
  assert.deepEqual(readPlacement(undefined, "propose", FLOATING), FLOATING);
});

test("blocked storage falls back instead of throwing", () => {
  // Private browsing. The panel should still open, just without a memory.
  assert.deepEqual(readPlacement(store({}, true), "propose", FLOATING), FLOATING);
});

test("malformed json falls back", () => {
  const s = store({ [placementKey("propose")]: "{not json" });
  assert.deepEqual(readPlacement(s, "propose", FLOATING), FLOATING);
});

test("an unknown mode falls back", () => {
  const s = store({ [placementKey("propose")]: '{"mode":"sideways"}' });
  assert.deepEqual(readPlacement(s, "propose", FLOATING), FLOATING);
});

test("floating without usable numbers falls back", () => {
  for (const raw of [
    '{"mode":"floating"}',
    '{"mode":"floating","x":"12","y":4}',
    '{"mode":"floating","x":null,"y":null}',
  ]) {
    const s = store({ [placementKey("propose")]: raw });
    assert.deepEqual(readPlacement(s, "propose", FLOATING), FLOATING, raw);
  }
});

test("a stored placement is never treated as unplaced", () => {
  // The regression: a docked panel read from storage went through the
  // first-paint positioning path, which floated it and overwrote the stored
  // dock — so the placement only broke on reload, never on a click.
  const s = store({ [placementKey("propose")]: '{"mode":"docked"}' });
  assert.equal(isUnplaced(readPlacement(s, "propose", FLOATING)), false);

  const at = store({
    [placementKey("propose")]: '{"mode":"floating","x":180,"y":150}',
  });
  assert.equal(isUnplaced(readPlacement(at, "propose", FLOATING)), false);
});

test("only the unpositioned default asks to be placed", () => {
  assert.equal(isUnplaced({ mode: "floating", x: 0, y: 0 }), true);
  assert.equal(isUnplaced({ mode: "floating", x: 1, y: 0 }), false);
  assert.equal(isUnplaced({ mode: "docked" }), false);
});

test("a panel inside the viewport is left where it is", () => {
  assert.deepEqual(clampToViewport(300, 200, 416, 512, VIEWPORT), {
    x: 300,
    y: 200,
  });
});

test("a panel off the right or bottom is pulled back into view", () => {
  assert.deepEqual(clampToViewport(9000, 9000, 416, 512, VIEWPORT), {
    x: 1440 - 416 - 8,
    y: 900 - 512 - 8,
  });
});

test("negative coordinates are pulled back to the margin", () => {
  assert.deepEqual(clampToViewport(-500, -500, 416, 512, VIEWPORT), {
    x: 8,
    y: 8,
  });
});

test("a panel wider than the viewport still shows its top left", () => {
  // A phone. Its header — the drag handle and the close button — has to be
  // reachable, so the margin wins over fitting the whole width.
  const { x, y } = clampToViewport(180, 150, 359, 512, {
    width: 375,
    height: 812,
  });
  assert.equal(x, 8);
  assert.equal(y, 150);
});

test("first paint puts an unplaced panel bottom right, fully on screen", () => {
  const { x, y } = initialFloatingSpot(416, 512, VIEWPORT);
  assert.equal(x, 1440 - 416 - 24);
  assert.equal(y, 900 - 512 - 72);
  assert.ok(x + 416 <= VIEWPORT.width);
  assert.ok(y + 512 <= VIEWPORT.height);
});

test("first paint on a phone stays on screen too", () => {
  const vp = { width: 375, height: 812 };
  const { x, y } = initialFloatingSpot(359, 512, vp);
  assert.ok(x >= 8);
  assert.ok(y >= 8);
  assert.ok(y + 512 <= vp.height);
});
