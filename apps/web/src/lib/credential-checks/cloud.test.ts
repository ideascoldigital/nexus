import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import { checkAws, checkCivo, checkTailscale } from "./cloud";
import { signAwsForm } from "./sigv4";

const NOW = new Date("2026-09-27T12:00:00Z");

function stub(route: (url: string, init?: RequestInit) => { status: number; body?: string | object }) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const r = route(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const line = (r: { checks: Array<{ label: string; ok: boolean | null; detail?: string }> }, prefix: string) =>
  r.checks.find((c) => c.label.startsWith(prefix));

// --- SigV4 ------------------------------------------------------------------

test("sigv4: the signature is AWS's documented construction", () => {
  // AWS's documentation example credentials — not a real key.
  const keys = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const body = "Action=GetCallerIdentity&Version=2011-06-15";
  const h = signAwsForm({ service: "sts", region: "us-east-1", host: "sts.amazonaws.com", body, now: NOW, ...keys });
  assert.equal(h["X-Amz-Date"], "20260927T120000Z");
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260927\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);

  // Recompute independently from the spec, step by step.
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const mac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
  const canonical = `POST\n/\n\ncontent-type:application/x-www-form-urlencoded; charset=utf-8\nhost:sts.amazonaws.com\nx-amz-date:20260927T120000Z\n\ncontent-type;host;x-amz-date\n${sha(body)}`;
  const toSign = `AWS4-HMAC-SHA256\n20260927T120000Z\n20260927/us-east-1/sts/aws4_request\n${sha(canonical)}`;
  const key = mac(mac(mac(mac(`AWS4${keys.secretAccessKey}`, "20260927"), "us-east-1"), "sts"), "aws4_request");
  assert.ok(h.Authorization.endsWith(createHmac("sha256", key).update(toSign).digest("hex")));
  // The secret itself never appears in a header.
  assert.ok(!JSON.stringify(h).includes(keys.secretAccessKey));
});

// --- AWS --------------------------------------------------------------------

const STS_OK = "<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/nexux</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>";

test("aws: identity from STS, and EC2 allowed in the sandbox region", async () => {
  const s = stub((url) =>
    url.startsWith("https://sts.")
      ? { status: 200, body: STS_OK }
      : { status: 412, body: "<Response><Errors><Error><Code>DryRunOperation</Code></Error></Errors></Response>" },
  );
  const r = await checkAws({ accessKeyId: "AKIAX", secretAccessKey: "s" }, { region: "eu-west-1" }, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.identity, "arn:aws:iam::123456789012:user/nexux");
  assert.equal(line(r, "use EC2 in eu-west-1")?.ok, true);
  assert.equal(s.seen[1].url, "https://ec2.eu-west-1.amazonaws.com/");
  // DryRun: the check never does anything to the account.
  assert.match(String(s.seen[1].init?.body), /DryRun=true/);
});

test("aws: valid keys without EC2 warn; bad keys fail with the reason", async () => {
  const noEc2 = stub((url) =>
    url.startsWith("https://sts.")
      ? { status: 200, body: STS_OK }
      : { status: 403, body: "<Response><Errors><Error><Code>UnauthorizedOperation</Code></Error></Errors></Response>" },
  );
  const r = await checkAws({ accessKeyId: "AKIAX", secretAccessKey: "s" }, {}, { fetch: noEc2.fetchFn, now: () => NOW });
  assert.equal(r.status, "warn");
  assert.equal(line(r, "use EC2 in us-east-1")?.ok, false);

  const bad = stub(() => ({ status: 403, body: "<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>" }));
  const f = await checkAws({ accessKeyId: "AKIAX", secretAccessKey: "s" }, {}, { fetch: bad.fetchFn, now: () => NOW });
  assert.equal(f.status, "fail");
  assert.match(f.checks[0].detail ?? "", /key id or the secret is wrong/);
});

// --- Civo -------------------------------------------------------------------

test("civo: accepted, with quota headroom — and warns when there is none", async () => {
  const quota = (used: number) =>
    stub(() => ({ status: 200, body: { instance_count_limit: 16, instance_count_usage: used, cpu_core_limit: 32, cpu_core_usage: used * 2 } })).fetchFn;
  const ok = await checkCivo("civo-token", { fetch: quota(3), now: () => NOW });
  assert.equal(ok.status, "ok");
  assert.match(line(ok, "room for another instance")?.detail ?? "", /13 of 16/);
  const full = await checkCivo("civo-token", { fetch: quota(16), now: () => NOW });
  assert.equal(full.status, "warn");
  const rejected = await checkCivo("civo-token", { fetch: stub(() => ({ status: 401 })).fetchFn, now: () => NOW });
  assert.equal(rejected.status, "fail");
});

// --- Tailscale ------------------------------------------------------------------

test("tailscale: what can be checked is, and what cannot is said", async () => {
  const s = stub(() => ({ status: 200, body: { legacyPublicKey: "x" } }));
  const r = await checkTailscale({ authKey: "tskey-auth-abc-def" }, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(r.status, "ok");
  assert.equal(line(r, "reusable, ephemeral")?.ok, null);
  assert.equal(s.seen[0].url, "https://controlplane.tailscale.com/key?v=71");
  // The key is never sent anywhere.
  assert.ok(!JSON.stringify(s.seen).includes("tskey-auth-abc-def"));
});

test("tailscale: an API key saved as an auth key is named; a keyless one warns", async () => {
  const s = stub(() => ({ status: 200 }));
  const api = await checkTailscale({ authKey: "tskey-api-xyz" }, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(api.status, "fail");
  assert.match(api.checks[0].detail ?? "", /API key/);
  const none = await checkTailscale({ loginServer: "https://vpn.example.com/" }, { fetch: s.fetchFn, now: () => NOW });
  assert.equal(none.status, "warn");
  assert.equal(s.seen.at(-1)?.url, "https://vpn.example.com/key?v=71");
});

test("tailscale: a key saved as `token` (older credentials) is found", async () => {
  const r = await checkTailscale({ token: "tskey-auth-legacy-1" }, { fetch: stub(() => ({ status: 200 })).fetchFn, now: () => NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.checks[0].label, "looks like a Tailscale auth key");
});
