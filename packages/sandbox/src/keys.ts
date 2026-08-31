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
  const dir = sandboxKeyDir(dataDir);
  const privateKeyPath = sandboxPrivateKeyPath(dataDir);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!fs.existsSync(privateKeyPath)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const res = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "nexux-sandbox", "-f", privateKeyPath],
      { stdio: "ignore" },
    );
    if (res.status !== 0 || !fs.existsSync(privateKeyPath)) {
      throw new Error(
        "Failed to generate the sandbox SSH keypair (is ssh-keygen installed?)",
      );
    }
  }

  if (!fs.existsSync(publicKeyPath)) {
    // Private key exists but the public half is missing — derive it.
    const res = spawnSync("ssh-keygen", ["-y", "-f", privateKeyPath], {
      encoding: "utf8",
    });
    if (res.status !== 0 || !res.stdout.trim()) {
      throw new Error("Failed to derive the sandbox SSH public key");
    }
    fs.writeFileSync(publicKeyPath, res.stdout.trim() + "\n", { mode: 0o644 });
  }

  return {
    privateKeyPath,
    publicKey: fs.readFileSync(publicKeyPath, "utf8").trim(),
  };
}
