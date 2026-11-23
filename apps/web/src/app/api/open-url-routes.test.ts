import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { openerCommand, POST as openUrl, validateUrl } from "./open-url/route";

afterEach(() => {
  delete process.env.NEXUX_NATIVE;
  delete process.env.NEXUX_OPEN_URL;
});

test("validateUrl accepts http(s) only", () => {
  assert.equal(
    validateUrl("https://github.com/x"),
    "https://github.com/x",
  );
  assert.equal(validateUrl("http://localhost:3000/a"), "http://localhost:3000/a");
  assert.equal(validateUrl("file:///etc/passwd"), null);
  assert.equal(validateUrl("javascript:alert(1)"), null);
  assert.equal(validateUrl("not a url"), null);
  assert.equal(validateUrl(42), null);
  assert.equal(validateUrl(undefined), null);
});

test("openerCommand picks the platform opener", () => {
  assert.deepEqual(openerCommand("darwin", "https://x"), ["open", "https://x"]);
  assert.deepEqual(openerCommand("win32", "https://x"), [
    "rundll32",
    "url.dll,FileProtocolHandler",
    "https://x",
  ]);
  assert.deepEqual(openerCommand("win32", "C:\\repos\\app"), ["explorer.exe", "C:\\repos\\app"]);
  assert.deepEqual(openerCommand("linux", "https://x"), [
    "xdg-open",
    "https://x",
  ]);
});

test("Windows never hands a URL or folder to cmd.exe", () => {
  // cmd re-parses its argument line: with `cmd /c start "" <url>`, the `&`
  // here ran calc. Nothing in the argv may be cmd, and the target must stay
  // one untouched argument.
  for (const target of ["https://x.com/?a&calc", "C:\\work\\a&calc"]) {
    const argv = openerCommand("win32", target);
    assert.ok(!argv.some((a) => /^cmd(\.exe)?$/i.test(a)), target);
    assert.equal(argv.at(-1), target);
  }
});

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/open-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST answers 404 outside the native app", async () => {
  const res = await openUrl(jsonReq({ url: "https://github.com" }));
  assert.equal(res.status, 404);
});

test("POST rejects a non-http url even when native", async () => {
  process.env.NEXUX_NATIVE = "1";
  const res = await openUrl(jsonReq({ url: "file:///etc/passwd" }));
  assert.equal(res.status, 400);
});

test("POST refuses a no-preflight request from another website", async () => {
  // req.json() parses any body, so a text/plain POST — which a page on any
  // site can send without a preflight — used to open its URL.
  process.env.NEXUX_NATIVE = "1";
  const res = await openUrl(
    new Request("http://127.0.0.1/api/open-url", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ url: "https://evil.example" }),
    }),
  );
  assert.equal(res.status, 403);
});

test("POST rejects a body with no url", async () => {
  process.env.NEXUX_NATIVE = "1";
  const res = await openUrl(jsonReq({}));
  assert.equal(res.status, 400);
});
