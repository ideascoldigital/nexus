import fs from "fs";
import path from "path";
import { gzipSync } from "zlib";
import { renderCloudInit, renderMainTf, renderTfVars } from "./template";
import { runTerraform } from "./terraform";
import type { LogSink, ProvisionOutputs, SandboxSpec } from "./types";

// The workDir holds everything Terraform needs (module, tfvars, cloud-init,
// state). It must be kept until the sandbox is destroyed — the state file is
// the only record of what to tear down. Provider credentials are passed via
// env vars of the terraform process (CIVO_TOKEN, or AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY) and never written to disk.

export type ProviderCredentials = Record<string, string>;

// EC2 rejects user_data above 16 KB; Civo has no such limit. The plain
// bootstrap does not fit that budget on its own (the embedded nexus CLI alone
// is ~15 KB), so AWS ships it gzipped — cloud-init sniffs the magic bytes and
// decompresses transparently, and shell compresses ~4:1. The guard stays, on
// the compressed size, so a truly enormous config still fails fast with a
// clear message instead of a cryptic terraform apply error.
const AWS_USER_DATA_LIMIT = 16 * 1024;

/**
 * @param cloudInitOverride bootstrap to write instead of the sandbox one. A
 * Nexus host (spec 19) provisions through the same Terraform module but turns
 * the instance into something else entirely, so it supplies its own script
 * rather than threading host concepts through `SandboxSpec`.
 */
export function prepareWorkDir(
  workDir: string,
  spec: SandboxSpec,
  cloudInitOverride?: string,
): void {
  const cloudInit = cloudInitOverride ?? renderCloudInit(spec);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workDir, "main.tf"), renderMainTf(spec.provider), {
    mode: 0o600,
  });
  // cloud-init.sh may embed env var values — keep it private. Written for
  // both providers: on AWS it is not what terraform sends, but it is what a
  // human debugging the workDir wants to read.
  fs.writeFileSync(path.join(workDir, "cloud-init.sh"), cloudInit, {
    mode: 0o600,
  });
  if (spec.provider === "aws") {
    const gz = gzipSync(Buffer.from(cloudInit, "utf8"), { level: 9 });
    if (gz.byteLength > AWS_USER_DATA_LIMIT) {
      throw new Error(
        `Bootstrap script is ${gz.byteLength} bytes gzipped (${Buffer.byteLength(cloudInit, "utf8")} raw) — EC2 user_data is limited to 16 KB. Trim the setup script, stack services or env vars.`,
      );
    }
    fs.writeFileSync(path.join(workDir, "cloud-init.sh.gz"), gz, {
      mode: 0o600,
    });
  }
  fs.writeFileSync(
    path.join(workDir, "terraform.tfvars.json"),
    renderTfVars(spec),
    { mode: 0o600 },
  );
}

async function tf(
  args: string[],
  workDir: string,
  credentials: ProviderCredentials,
  onLog?: LogSink,
): Promise<void> {
  const res = await runTerraform(args, {
    cwd: workDir,
    env: credentials,
    onLog,
  });
  if (res.code !== 0) {
    throw new Error(
      `terraform ${args[0]} exited with code ${res.code}: ${lastLines(res.stderr || res.stdout)}`,
    );
  }
}

function lastLines(text: string, n = 5): string {
  return text.trim().split("\n").slice(-n).join("\n");
}

export async function readOutputs(
  workDir: string,
  credentials: ProviderCredentials,
): Promise<ProvisionOutputs> {
  const res = await runTerraform(["output", "-json"], {
    cwd: workDir,
    env: credentials,
  });
  if (res.code !== 0) return {};
  try {
    const parsed = JSON.parse(res.stdout) as Record<string, { value?: unknown }>;
    return {
      instanceId:
        typeof parsed.instance_id?.value === "string"
          ? parsed.instance_id.value
          : undefined,
      publicIp:
        typeof parsed.public_ip?.value === "string"
          ? parsed.public_ip.value
          : undefined,
    };
  } catch {
    return {};
  }
}

export async function applySandbox(opts: {
  workDir: string;
  spec: SandboxSpec;
  credentials: ProviderCredentials;
  onLog?: LogSink;
  /** Bootstrap to use instead of the sandbox one — see `prepareWorkDir`. */
  cloudInit?: string;
}): Promise<ProvisionOutputs> {
  const { workDir, spec, credentials, onLog } = opts;
  prepareWorkDir(workDir, spec, opts.cloudInit);
  await tf(["init", "-no-color"], workDir, credentials, onLog);
  await tf(["apply", "-auto-approve", "-no-color"], workDir, credentials, onLog);
  return readOutputs(workDir, credentials);
}

// Civo generates a root password for every instance; it lives in the local
// terraform state. Read it on demand instead of persisting it anywhere else.
// AWS instances have no equivalent — access is SSH-key only.
export function readInitialPassword(workDir: string): string | null {
  const statePath = path.join(workDir, "terraform.tfstate");
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      resources?: Array<{
        type?: string;
        instances?: Array<{ attributes?: { initial_password?: unknown } }>;
      }>;
    };
    for (const res of state.resources ?? []) {
      if (res.type !== "civo_instance") continue;
      const value = res.instances?.[0]?.attributes?.initial_password;
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // corrupt/partial state — treat as unavailable
  }
  return null;
}

export async function destroySandbox(opts: {
  workDir: string;
  credentials: ProviderCredentials;
  onLog?: LogSink;
}): Promise<void> {
  const { workDir, credentials, onLog } = opts;
  if (!fs.existsSync(path.join(workDir, "main.tf"))) {
    throw new Error(`Sandbox workDir missing terraform module: ${workDir}`);
  }
  await tf(["destroy", "-auto-approve", "-no-color"], workDir, credentials, onLog);
}
