import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOTS_KEYS,
  DOCK_MIN_WIDTH,
  INBOX_DEFAULT_WIDTH,
  PANEL_DEFAULT_WIDTH,
  clampDockWidth,
  clampInboxWidth,
  clampPanelWidth,
  dockModeFor,
  maxDockWidth,
  rememberDockMode,
} from "./bot-layout";

test("every stored preference has its own namespaced key", () => {
  const keys = Object.values(BOTS_KEYS);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((k) => k.startsWith("nexux:bots")));
});

test("the anchored computer leaves the chat room to read and type", () => {
  assert.equal(maxDockWidth(1440), 864); // 1440 - 560, under the 60% cap
  assert.equal(maxDockWidth(2560), 1536); // the 60% cap bites on a wide screen
  assert.equal(clampDockWidth(900, 1440), 864);
  assert.equal(clampDockWidth(520, 1440), 520);
});

test("it never shrinks below a usable screen, even in a narrow window", () => {
  assert.equal(maxDockWidth(700), DOCK_MIN_WIDTH);
  assert.equal(clampDockWidth(120, 1440), DOCK_MIN_WIDTH);
  assert.equal(clampDockWidth(900, 700), DOCK_MIN_WIDTH);
});

test("a missing or broken stored width falls back to the default", () => {
  assert.equal(clampDockWidth(Number.NaN, 1440), 520);
  assert.equal(clampDockWidth(Number.NaN, 760), DOCK_MIN_WIDTH);
});

test("where the screen is kept is remembered per bot, and a new bot keeps the dialog", () => {
  const stored = rememberDockMode({}, "a", "right");
  assert.deepEqual(stored, { a: "right" });
  assert.equal(dockModeFor(stored, "a"), "right");
  assert.equal(dockModeFor(stored, "b"), "off");

  const both = rememberDockMode(stored, "b", "panel");
  assert.deepEqual(both, { a: "right", b: "panel" });
  assert.deepEqual(rememberDockMode(both, "a", "off"), { b: "panel" });
});

test("a bot's choice survives junk, and the old one-for-all boolean is dropped", () => {
  assert.equal(dockModeFor(true, "a"), "off");
  assert.equal(dockModeFor(null, "a"), "off");
  assert.equal(dockModeFor({ a: "sideways" }, "a"), "off");
  assert.deepEqual(rememberDockMode(true, "a", "right"), { a: "right" });
  assert.deepEqual(rememberDockMode({ a: true, b: "panel" }, "a", "right"), { b: "panel", a: "right" });
});

test("the details panel grows for the screen it may hold, within reason", () => {
  assert.equal(clampPanelWidth(380), 380);
  assert.equal(clampPanelWidth(120), 300);
  assert.equal(clampPanelWidth(2000), 760);
  assert.equal(clampPanelWidth(Number.NaN), PANEL_DEFAULT_WIDTH);
});

test("the inbox stays a list: wide enough for a preview line, never the whole view", () => {
  assert.equal(clampInboxWidth(300), 300);
  assert.equal(clampInboxWidth(50), 210);
  assert.equal(clampInboxWidth(1200), 460);
  assert.equal(clampInboxWidth(Number.NaN), INBOX_DEFAULT_WIDTH);
});
