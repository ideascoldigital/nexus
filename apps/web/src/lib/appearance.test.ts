import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";

import {
  APPEARANCE_BOOT_SCRIPT,
  LAYOUT_WIDTH_KEY,
  THEME_KEY,
  ZOOM_KEY,
  parseZoom,
  resolveTheme,
  stepZoom,
} from "./appearance";

/** Run the inline <head> script against a fake page, as the browser would. */
function boot(stored: Record<string, string>, opts: { prefersDark?: boolean; storageThrows?: boolean } = {}) {
  const dataset: Record<string, string> = {};
  const classes = new Set(["dark"]);
  vm.runInNewContext(APPEARANCE_BOOT_SCRIPT, {
    localStorage: {
      getItem: (k: string) => {
        if (opts.storageThrows) throw new Error("SecurityError");
        return stored[k] ?? null;
      },
    },
    matchMedia: () => ({ matches: opts.prefersDark ?? true }),
    document: { documentElement: { dataset, classList: { remove: (c: string) => classes.delete(c) } } },
  });
  return { layout: dataset.layout, dark: classes.has("dark") };
}

test("nothing stored is the designed default: contained and dark", () => {
  assert.deepEqual(boot({}), { layout: undefined, dark: true });
});

test("stored preferences are in place before first paint", () => {
  assert.deepEqual(
    boot({ [LAYOUT_WIDTH_KEY]: "full", [ZOOM_KEY]: "1.25", [THEME_KEY]: "light" }),
    // Zoom is not the boot script's: it belongs to the desktop shell.
    { layout: "full", dark: false },
  );
});

test("system follows the OS at boot", () => {
  assert.equal(boot({ [THEME_KEY]: "system" }, { prefersDark: false }).dark, false);
  assert.equal(boot({ [THEME_KEY]: "system" }, { prefersDark: true }).dark, true);
});

test("a nonsense stored zoom reads as 100%", () => {
  assert.equal(parseZoom("9"), 1);
  assert.equal(parseZoom("abc"), 1);
  assert.equal(parseZoom("0.1"), 1);
  assert.equal(parseZoom("1.5"), 1.5);
});

test("storage that refuses to answer does not break the page", () => {
  assert.doesNotThrow(() => boot({}, { storageThrows: true }));
});

test("zoom steps like a browser's, and stops at the ends", () => {
  assert.equal(stepZoom(1, "in"), 1.1);
  assert.equal(stepZoom(1, "out"), 0.9);
  assert.equal(stepZoom(1.05, "in"), 1.1); // off-step values snap onward
  assert.equal(stepZoom(2, "in"), 2);
  assert.equal(stepZoom(0.67, "out"), 0.67);
  assert.equal(stepZoom(1.5, "reset"), 1);
});

test("theme resolution", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("system", false), "light");
});
