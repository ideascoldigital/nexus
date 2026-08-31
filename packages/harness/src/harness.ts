// Harness factory. P0: ephemeral only. Warm pool lands in P1.

import { dockerAvailable } from "./docker";
import { DockerSandbox } from "./sandbox";
import type { Harness, HarnessConfig, Sandbox } from "./types";

const DEFAULTS: HarnessConfig = {
  image: "node:20-bookworm",
  lifecycle: "ephemeral",
  network: "none",
  memoryMb: 2048,
  cpus: 2,
  poolSize: 2,
  workdir: "/work",
};

// Counter for unique container names. Date.now()/random avoided to stay
// deterministic-friendly; collisions impossible within a process.
let seq = 0;

export function createHarness(cfg: Partial<HarnessConfig> = {}): Harness {
  const config: HarnessConfig = { ...DEFAULTS, ...cfg };

  if (config.lifecycle === "warm") {
    throw new Error("harness: warm lifecycle not implemented yet (P1)");
  }

  const live = new Set<DockerSandbox>();

  return {
    async sandbox(): Promise<Sandbox> {
      if (!(await dockerAvailable())) {
        throw new Error(
          "harness: docker not available — is Docker Desktop running?",
        );
      }
      const id = `nexux-hs-${process.pid}-${seq++}`;
      const sb = new DockerSandbox(id, config);
      await sb.start();
      live.add(sb);
      const origDestroy = sb.destroy.bind(sb);
      sb.destroy = async () => {
        await origDestroy();
        live.delete(sb);
      };
      return sb;
    },

    async shutdown(): Promise<void> {
      await Promise.all([...live].map((sb) => sb.destroy()));
      live.clear();
    },
  };
}
