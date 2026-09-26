import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";

import { LAYOUT_WIDTH_BOOT_SCRIPT, LAYOUT_WIDTH_KEY } from "./layout-width";

/** Run the inline <head> script against a fake page, as the browser would. */
function boot(stored: string | null, opts: { storageThrows?: boolean } = {}) {
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error("SecurityError");
      return k === LAYOUT_WIDTH_KEY ? stored : null;
    },
  };
  vm.runInNewContext(LAYOUT_WIDTH_BOOT_SCRIPT, {
    localStorage,
    document: { documentElement: { dataset } },
  });
  return dataset.layout;
}

test("a full-width preference is applied before first paint", () => {
  assert.equal(boot("full"), "full");
});

test("anything else leaves the designed, contained layout", () => {
  assert.equal(boot("contained"), undefined);
  assert.equal(boot(null), undefined);
  assert.equal(boot("wide"), undefined);
});

test("storage that refuses to answer does not break the page", () => {
  assert.doesNotThrow(() => boot("full", { storageThrows: true }));
});
