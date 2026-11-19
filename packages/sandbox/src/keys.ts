import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export interface SandboxKeypair {
  privateKeyPath: string;
  publicKey: string;
}

export function sandboxKeyDir(dataDir: string): string {
  return path.join(dataDir, "ssh");
}

export function sandboxPrivateKeyPath(dataDir: string): string {
  return path.join(sandboxKeyDir(dataDir), "id_ed25519");
}

// Nexus keeps one keypair per install (<dataDir>/ssh/id_ed25519). The public
// key is registered on every sandbox instance so the in-app terminal can
// connect without a password; the private key never leaves this machine.
export function ensureSandboxKeypair(dataDir: string): SandboxKeypair {
  return ensureKeypair(sandboxPrivateKeyPath(dataDir), "nexux-sandbox");
}

/**
 * The key a Nexus host uses to reach Docker endpoints over SSH (spec 27
 * phase 6). Its own, not the sandbox keypair: authorizing it on a machine
 * must not hand that machine a key every cloud sandbox holds, and removing it
 * must not lock out a sandbox.
 */
export function endpointPrivateKeyPath(dataDir: string): string {
  return path.join(sandboxKeyDir(dataDir), "endpoint_ed25519");
}

/** `comment` ends up in the target's authorized_keys — name the host. */
export function ensureEndpointKeypair(dataDir: string, comment: string): SandboxKeypair {
  return ensureKeypair(endpointPrivateKeyPath(dataDir), comment);
}

function ensureKeypair(privateKeyPath: string, comment: string): SandboxKeypair {
  const dir = path.dirname(privateKeyPath);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!fs.existsSync(privateKeyPath)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const res = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", comment, "-f", privateKeyPath],
      { stdio: "ignore" },
    );
    if (res.status !== 0 || !fs.existsSync(privateKeyPath)) {
      throw new Error(
        `Failed to generate the SSH keypair ${path.basename(privateKeyPath)} (is ssh-keygen installed?)`,
      );
    }
  }

  if (!fs.existsSync(publicKeyPath)) {
    // Private key exists but the public half is missing — derive it.
    const res = spawnSync("ssh-keygen", ["-y", "-f", privateKeyPath], {
      encoding: "utf8",
    });
    if (res.status !== 0 || !res.stdout.trim()) {
      throw new Error(`Failed to derive the public half of ${path.basename(privateKeyPath)}`);
    }
    fs.writeFileSync(publicKeyPath, res.stdout.trim() + "\n", { mode: 0o644 });
  }

  return {
    privateKeyPath,
    publicKey: fs.readFileSync(publicKeyPath, "utf8").trim(),
  };
}
