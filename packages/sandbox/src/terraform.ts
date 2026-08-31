import { spawn } from "child_process";
import type { LogSink, TerraformResult } from "./types";

const TERRAFORM_BIN = process.env.NEXUX_TERRAFORM_BIN ?? "terraform";

export async function terraformAvailable(): Promise<boolean> {
  try {
    const res = await runTerraform(["version"], { cwd: process.cwd() });
    return res.code === 0;
  } catch {
    return false;
  }
}

export function runTerraform(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; onLog?: LogSink },
): Promise<TerraformResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TERRAFORM_BIN, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        TF_IN_AUTOMATION: "1",
        TF_INPUT: "0",
        NO_COLOR: "1",
        ...opts.env,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onLog?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onLog?.(text);
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
