/**
 * A minimal AWS Signature V4 signer — enough for the two read-only calls the
 * AWS check makes (STS GetCallerIdentity, EC2 DescribeInstances with DryRun),
 * both form-encoded POSTs to `/`. Written rather than pulling in the AWS SDK:
 * two requests do not justify megabytes of dependency in the web bundle.
 */

import { createHash, createHmac } from "crypto";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

export function signAwsForm(opts: {
  service: string;
  region: string;
  host: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20260927T120000Z
  const date = amzDate.slice(0, 8);
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";

  const signedHeaders = "content-type;host;x-amz-date";
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:${contentType}\nhost:${opts.host}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    sha256(opts.body),
  ].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");

  const kDate = hmac(`AWS4${opts.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");

  return {
    "Content-Type": contentType,
    "X-Amz-Date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
