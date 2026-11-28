import assert from "node:assert/strict";
import { test } from "node:test";

import { BOT_COLORS, BOT_SHAPE_PATHS, BOT_SHAPES, isBotShape, randomBotLook, textOn } from "./bot-shapes";

test("every shape has a closed path that stays inside the 100x100 box", () => {
  for (const shape of BOT_SHAPES) {
    const d = BOT_SHAPE_PATHS[shape];
    assert.match(d, /^M.*Z$/, shape);
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    assert.ok(nums.length > 4, shape);
    assert.ok(nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 100), `${shape} out of bounds`);
  }
});

test("shape ids and colors are validated", () => {
  assert.ok(isBotShape("blob"));
  assert.ok(!isBotShape("dragon"));
  assert.ok(BOT_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c)));
});

test("text on a bot color is dark on light colors and white on the rest", () => {
  assert.equal(textOn("#f4f4f5"), "#18181b"); // white
  assert.equal(textOn("#f59e0b"), "#18181b"); // amber
  assert.equal(textOn("#22c55e"), "#18181b"); // green
  assert.equal(textOn("#8b5cf6"), "#ffffff"); // purple
  assert.equal(textOn("#3b82f6"), "#ffffff"); // blue
  assert.equal(textOn("#ec4899"), "#ffffff"); // pink
  assert.equal(textOn("nope"), "#ffffff");
});

test("a roll is always a known shape and colour", () => {
  for (let i = 0; i < 50; i++) {
    const look = randomBotLook();
    assert.ok(BOT_SHAPES.includes(look.shape));
    assert.ok((BOT_COLORS as readonly string[]).includes(look.color));
  }
});

test("a re-roll never repeats the current shape or colour", () => {
  const current = { shape: BOT_SHAPES[0], color: BOT_COLORS[0] };
  for (const r of [0, 0.5, 0.999]) {
    const look = randomBotLook(current, () => r);
    assert.notEqual(look.shape, current.shape);
    assert.notEqual(look.color, current.color);
  }
});
