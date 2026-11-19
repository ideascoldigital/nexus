import assert from "node:assert/strict";
import { test } from "node:test";

import type { BotCookie } from "@nexux/sandbox";

import { applyChanges, cookieKey, diffCookies, isShareable, snapshotOf, toCookieParam, type TeamStore } from "./team-cookies";

const future = Math.floor(Date.now() / 1000) + 3600;
const ck = (name: string, value: string, extra: Partial<BotCookie> = {}): BotCookie => ({
  name,
  value,
  domain: ".example.com",
  path: "/",
  expires: future,
  secure: true,
  httpOnly: true,
  session: false,
  size: name.length + value.length,
  ...extra,
});

test("only what changed in that browser counts", () => {
  const before = snapshotOf([ck("SID", "old"), ck("NID", "x")]);
  const { upserts, removed } = diffCookies(before, [ck("SID", "new"), ck("NID", "x"), ck("HSID", "h")]);
  assert.deepEqual(upserts.map((c) => `${c.name}=${c.value}`), ["SID=new", "HSID=h"]);
  assert.deepEqual(removed, []);
  assert.deepEqual(diffCookies(before, [ck("NID", "x")]).removed, [cookieKey(ck("SID", ""))]);
});

test("a stale browser does not overwrite a fresh login made elsewhere", () => {
  const team: TeamStore = { cookies: { [cookieKey(ck("SID", ""))]: ck("SID", "fresh-from-isa") } };
  // Gastos still holds an old SID it had all along: unchanged in *its* browser, so no change.
  const gastosBefore = snapshotOf([ck("SID", "stale")]);
  const { set, changed } = applyChanges(team, diffCookies(gastosBefore, [ck("SID", "stale")]));
  assert.equal(changed, false);
  assert.equal(set.length, 0);
  assert.equal(team.cookies[cookieKey(ck("SID", ""))]?.value, "fresh-from-isa");
});

test("sign-ins travel; a removal in one browser never signs the others out", () => {
  const team: TeamStore = { cookies: {} };
  let r = applyChanges(team, { upserts: [ck("SID", "v1")], removed: [] });
  assert.equal(r.changed, true);
  assert.equal(r.set[0]?.value, "v1");
  // Google dropped the session in one bot's browser: the team keeps it.
  r = applyChanges(team, { upserts: [], removed: [cookieKey(ck("SID", ""))] });
  assert.equal(r.changed, false);
  assert.equal(team.cookies[cookieKey(ck("SID", ""))]?.value, "v1");
  // Expired cookies are still pruned.
  team.cookies.old = ck("OLD", "x", { expires: 100 });
  applyChanges(team, { upserts: [], removed: [] });
  assert.equal("old" in team.cookies, false);
});

test("host-only cookies (__Host-) are set by URL, domain cookies by domain", () => {
  const host = toCookieParam(ck("__Host-sid", "v", { domain: "app.example.com" }));
  assert.equal(host.url, "https://app.example.com/");
  assert.equal("domain" in host, false);
  const dom = toCookieParam(ck("SID", "v"));
  assert.equal(dom.domain, ".example.com");
  assert.equal("url" in dom, false);
});

test("DevTools params keep what setCookies accepts and drop read-only fields", () => {
  const p = toCookieParam(ck("SID", "v", { sameSite: "Lax", priority: "High", sourceScheme: "Secure", sourcePort: 443 }));
  assert.deepEqual(Object.keys(p).sort(), ["domain", "expires", "httpOnly", "name", "path", "priority", "sameSite", "secure", "sourcePort", "sourceScheme", "value"]);
  // (a domain cookie: host-only ones carry url instead of domain)
  assert.equal("size" in p, false);
  assert.equal("expires" in toCookieParam(ck("S", "v", { session: true, expires: -1 })), false);
});

test("Google refuses copied sessions: its cookies never travel, nor stay in the store", () => {
  for (const d of [".google.com", "accounts.google.com", ".google.com.co", "mail.google.com", ".youtube.com", "lh3.googleusercontent.com"]) {
    assert.equal(isShareable({ domain: d }), false, d);
  }
  for (const d of [".explee.com", "app.canva.com", ".facebook.com", "notgoogle.com", "google-analytics.example"]) {
    assert.equal(isShareable({ domain: d }), true, d);
  }
  const g = ck("SID", "v", { domain: ".google.com" });
  assert.deepEqual(diffCookies({}, [g, ck("s", "x")]).upserts.map((c) => c.domain), [".example.com"]);
  const team: TeamStore = { cookies: { [cookieKey(g)]: g } };
  applyChanges(team, { upserts: [], removed: [] });
  assert.deepEqual(team.cookies, {});
});
