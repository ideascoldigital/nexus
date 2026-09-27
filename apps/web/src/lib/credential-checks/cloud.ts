/**
 * Test the credentials sandboxes are provisioned with (spec 28 phase 3):
 * Civo, AWS and Tailscale.
 */

import { daysUntil, failed, probe } from "./http";
import { shapeProblems } from "./shape";
import { signAwsForm } from "./sigv4";
import type { CheckLine, CredentialCheck, Fetch } from "./types";

type Deps = { fetch?: Fetch; now?: () => Date };

// --- Civo -------------------------------------------------------------------

/**
 * Civo: `GET /v2/quota` — valid key, and whether the account has room for
 * another instance (sandboxes and hosts both create one).
 */
export async function checkCivo(token: string, deps: Deps = {}): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const shape = shapeProblems("civo", token);
  const shapeLines: CheckLine[] = shape.map((p) => ({ label: "looks like a key", ok: false, detail: p.message }));
  if (shape.some((p) => p.fatal)) return failed(checkedAt, shapeLines);

  const res = await probe(fetchFn, "https://api.civo.com/v2/quota", { Authorization: `bearer ${token.trim()}` });
  if (!res.reached) return failed(checkedAt, [...shapeLines, { label: "Civo answered", ok: false, detail: res.error }]);
  if (res.status === 401 || res.status === 403) {
    return failed(checkedAt, [...shapeLines, { label: "Civo accepts it", ok: false, detail: "Civo rejected it — revoked, or not an API key." }]);
  }
  if (res.status >= 400) return failed(checkedAt, [...shapeLines, { label: "Civo accepts it", ok: false, detail: `Civo answered ${res.status}.` }]);

  const q = res.body as Record<string, number | undefined>;
  const lines: CheckLine[] = [...shapeLines, { label: "Civo accepts it", ok: true }];
  let status: CredentialCheck["status"] = shape.length ? "warn" : "ok";
  const room = (limit?: number, usage?: number) => (limit != null && usage != null ? limit - usage : null);
  const instances = room(q.instance_count_limit, q.instance_count_usage);
  const cpus = room(q.cpu_core_limit, q.cpu_core_usage);
  if (instances !== null) {
    lines.push({ label: "room for another instance", ok: instances > 0, detail: `${instances} of ${q.instance_count_limit} instances free` });
    if (instances <= 0) status = "warn";
  }
  if (cpus !== null) {
    lines.push({ label: "CPU quota for a sandbox", ok: cpus >= 2, detail: `${cpus} of ${q.cpu_core_limit} cores free` });
    if (cpus < 2) status = "warn";
  }
  return { status, identity: null, expiresAt: null, scopes: null, checks: lines, checkedAt };
}

// --- AWS --------------------------------------------------------------------

const xmlTag = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;

/**
 * AWS: STS GetCallerIdentity says whose keys these are; an EC2
 * DescribeInstances with DryRun says whether they may use EC2 in the region
 * sandboxes launch in — AWS answers DryRunOperation (allowed) or
 * UnauthorizedOperation without doing anything.
 */
export async function checkAws(
  keys: { accessKeyId: string; secretAccessKey: string },
  opts: { region?: string | null },
  deps: Deps = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const region = opts.region || "us-east-1";
  if (!keys.accessKeyId || !keys.secretAccessKey) {
    return failed(checkedAt, [{ label: "has both keys", ok: false, detail: "an access key id and a secret are both needed" }]);
  }
  const post = async (service: string, host: string, signRegion: string, body: string) => {
    try {
      const res = await fetchFn(`https://${host}/`, {
        method: "POST",
        headers: signAwsForm({ service, region: signRegion, host, body, now, ...keys }),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: err instanceof Error ? err.message : String(err) };
    }
  };

  const sts = await post("sts", "sts.amazonaws.com", "us-east-1", "Action=GetCallerIdentity&Version=2011-06-15");
  if (sts.status === 0) return failed(checkedAt, [{ label: "AWS answered", ok: false, detail: sts.text }]);
  if (sts.status !== 200) {
    const code = xmlTag(sts.text, "Code") ?? `HTTP ${sts.status}`;
    return failed(checkedAt, [
      {
        label: "AWS accepts them",
        ok: false,
        detail:
          code === "InvalidClientTokenId" || code === "SignatureDoesNotMatch"
            ? `AWS rejected them (${code}) — the key id or the secret is wrong, or the key was deleted.`
            : `AWS answered ${code}.`,
      },
    ]);
  }
  const arn = xmlTag(sts.text, "Arn");
  const lines: CheckLine[] = [{ label: "AWS accepts them", ok: true }];

  const ec2 = await post("ec2", `ec2.${region}.amazonaws.com`, region, "Action=DescribeInstances&DryRun=true&Version=2016-11-15");
  const ec2Code = xmlTag(ec2.text, "Code");
  let status: CredentialCheck["status"] = "ok";
  if (ec2Code === "DryRunOperation") {
    lines.push({ label: `use EC2 in ${region}`, ok: true });
  } else if (ec2Code === "UnauthorizedOperation") {
    lines.push({ label: `use EC2 in ${region}`, ok: false, detail: "the keys are valid but not allowed to use EC2 — sandboxes on AWS would fail" });
    status = "warn";
  } else {
    lines.push({ label: `use EC2 in ${region}`, ok: null, detail: `AWS answered ${ec2Code ?? ec2.status}` });
  }
  return { status, identity: arn, expiresAt: null, scopes: null, checks: lines, checkedAt };
}

// --- Tailscale ----------------------------------------------------------------

/**
 * Tailscale: an auth key cannot be introspected without using it (registering
 * a device) or an admin API token Nexux does not hold. So this checks what
 * can be checked — the key's form, and that a self-hosted control server
 * answers — and says plainly which properties it cannot verify.
 */
export async function checkTailscale(
  // `token` is where older credentials keep the key; resolveTailscaleKey
  // reads either, so this must too.
  data: { authKey?: string | null; token?: string | null; loginServer?: string | null },
  deps: Deps = {},
): Promise<CredentialCheck> {
  const fetchFn = deps.fetch ?? fetch;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const lines: CheckLine[] = [];
  let status: CredentialCheck["status"] = "ok";
  const key = (data.authKey ?? data.token)?.trim() ?? "";
  const server = data.loginServer?.trim().replace(/\/+$/, "") || null;

  if (!key) {
    lines.push({
      label: "has an auth key",
      ok: false,
      detail: "no key — sandboxes can still register in the browser, but a Nexus host starts unattended and needs one",
    });
    status = "warn";
  } else if (server) {
    // Headscale pre-auth keys are opaque; nothing to check but presence.
    lines.push({ label: "has an auth key", ok: true });
  } else if (/^tskey-(auth|client)-/.test(key)) {
    lines.push({ label: "looks like a Tailscale auth key", ok: true });
  } else if (key.startsWith("tskey-api-")) {
    lines.push({ label: "looks like a Tailscale auth key", ok: false, detail: "this is an API key (tskey-api-…), not an auth key — devices cannot join with it" });
    status = "fail";
  } else {
    lines.push({ label: "looks like a Tailscale auth key", ok: false, detail: "Tailscale auth keys start with tskey-auth-" });
    status = "fail";
  }

  // The control server's public key endpoint answers any client that asks.
  const target = server ?? "https://controlplane.tailscale.com";
  const res = await probe(fetchFn, `${target}/key?v=71`, {});
  lines.push(
    res.reached && res.status === 200
      ? { label: `control server answers (${new URL(target).host})`, ok: true }
      : {
          label: `control server answers (${new URL(target).host})`,
          ok: false,
          detail: res.reached ? `answered ${res.status}` : res.error,
        },
  );
  if (!(res.reached && res.status === 200) && status === "ok") status = "warn";

  lines.push({
    label: "reusable, ephemeral and pre-authorized",
    ok: null,
    detail: "cannot be verified without using the key — check it where you created it",
  });
  return { status, identity: server ? new URL(server).host : "tailscale.com", expiresAt: null, scopes: null, checks: lines, checkedAt };
}

export { daysUntil };
