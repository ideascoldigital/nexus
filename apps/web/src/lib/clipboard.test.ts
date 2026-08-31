import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { copyText } from "./clipboard";

/**
 * The module reaches for `navigator` and `document` at call time, so a pair of
 * hand-rolled stubs on globalThis is enough — no DOM implementation needed.
 */
type Stubs = {
  writeText?: (text: string) => Promise<void>;
  execCommand?: (command: string) => boolean;
};

const installed: string[] = [];

function stub({ writeText, execCommand }: Stubs) {
  const appended: { value: string; removed: boolean }[] = [];

  Object.defineProperty(globalThis, "navigator", {
    value: writeText ? { clipboard: { writeText } } : {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => {
        const el = {
          value: "",
          removed: false,
          style: {} as Record<string, string>,
          setAttribute: () => {},
          select: () => {},
          remove() {
            this.removed = true;
          },
        };
        return el;
      },
      body: {
        appendChild: (el: { value: string; removed: boolean }) => {
          appended.push(el);
        },
      },
      execCommand: execCommand ?? (() => false),
    },
    configurable: true,
    writable: true,
  });
  installed.push("navigator", "document");
  return appended;
}

afterEach(() => {
  for (const key of installed.splice(0)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

describe("copyText", () => {
  it("uses the async clipboard when it succeeds", async () => {
    const seen: string[] = [];
    const appended = stub({
      writeText: async (text) => {
        seen.push(text);
      },
    });

    await copyText("ssh nexus-host");

    assert.deepEqual(seen, ["ssh nexus-host"]);
    assert.equal(appended.length, 0, "the textarea path should not have run");
  });

  it("falls back to execCommand when writeText is rejected", async () => {
    // The NotAllowedError a browser throws once focus has moved: the copy is
    // still expected to land, via the legacy path.
    const copies: string[] = [];
    const appended = stub({
      writeText: async () => {
        throw new DOMException("Document is not focused.", "NotAllowedError");
      },
      execCommand: (command) => {
        copies.push(command);
        return true;
      },
    });

    await copyText("ssh nexus-host");

    assert.deepEqual(copies, ["copy"]);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.value, "ssh nexus-host");
    assert.equal(appended[0]?.removed, true, "the textarea should be cleaned up");
  });

  it("falls back when navigator.clipboard is absent (plain http host)", async () => {
    const copies: string[] = [];
    stub({
      execCommand: (command) => {
        copies.push(command);
        return true;
      },
    });

    await copyText("ssh nexus-host");

    assert.deepEqual(copies, ["copy"]);
  });

  it("throws, and still removes the textarea, when both paths fail", async () => {
    const appended = stub({
      writeText: async () => {
        throw new DOMException("Document is not focused.", "NotAllowedError");
      },
      execCommand: () => false,
    });

    await assert.rejects(copyText("ssh nexus-host"), /Copy is not available/);
    assert.equal(appended[0]?.removed, true);
  });
});
