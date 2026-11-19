export * from "./types";
export { createHarness } from "./harness";
export { docker, run, dockerAvailable } from "./docker";
export {
  generateCompose,
  slugifyServiceName,
  type ComposeInput,
  type ComposeOutput,
  type StackNodeSpec,
  type StackPort,
  type StackEnvVar,
  type StackVolume,
} from "./compose";
// Spec 24 piece 2 — readiness probes, so the bootstrap's `--wait` means ready.
export { healthcheckFor, type ComposeHealthcheck } from "./healthcheck";
