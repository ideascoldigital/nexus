/**
 * Pure state rules for the sandbox setup wizard.
 *
 * The drawer restores itself from the URL (`?sandboxSetup=1&sandboxStep=…`),
 * so what a step *shows* has to survive a reload as faithfully as which step
 * is open. That is the part that was wrong: the step key round-tripped, but
 * the Type step's answer — local vs a cloud provider — did not, because
 * `SandboxConfig.provider` only stores `civo | aws`. A user who picked Local,
 * walked to Code and refreshed came back to Code with the destination quietly
 * flipped to a cloud instance.
 *
 * Lives here, outside the component, so these rules can be unit-tested without
 * a DOM (this app's tests run under `tsx --test`).
 */

/** Where the sandbox runs — the Type step's answer. */
export type SandboxDestination = "local" | "civo" | "aws";

export type WizardStepKey =
  | "type"
  | "machine"
  | "code"
  | "tooling"
  | "agent"
  | "launch";

/** Every step in wizard order, including the cloud-only Machine step. */
export const SANDBOX_STEP_KEYS: readonly WizardStepKey[] = [
  "type",
  "machine",
  "code",
  "tooling",
  "agent",
  "launch",
];

export const SANDBOX_STEP_PARAM = "sandboxStep";
export const SANDBOX_OPEN_PARAM = "sandboxSetup";
/** Mirrors the Type step so a reload restores the destination, not just the step. */
export const SANDBOX_DESTINATION_PARAM = "sandboxTarget";

const STEP_LABELS: Record<WizardStepKey, string> = {
  type: "Type",
  machine: "Machine",
  code: "Code",
  tooling: "Tooling",
  agent: "Agent",
  launch: "Launch",
};

const DESTINATIONS: readonly SandboxDestination[] = ["local", "civo", "aws"];

export function isSandboxDestination(
  value: string | null | undefined,
): value is SandboxDestination {
  return DESTINATIONS.includes(value as SandboxDestination);
}

export function isWizardStepKey(
  value: string | null | undefined,
): value is WizardStepKey {
  return SANDBOX_STEP_KEYS.includes(value as WizardStepKey);
}

/**
 * The steps actually shown for a destination. A local container has no
 * region/size to choose, so Machine is dropped rather than shown empty.
 */
export function stepsFor(
  destination: SandboxDestination,
): Array<{ key: WizardStepKey; label: string }> {
  return SANDBOX_STEP_KEYS.filter(
    (key) => key !== "machine" || destination !== "local",
  ).map((key) => ({ key, label: STEP_LABELS[key] }));
}

/**
 * Resolve the step to display.
 *
 * A key can be absent from the visible list two ways, and they deserve
 * different answers:
 *
 * - Garbage (`?sandboxStep=banana`) carries no intent — start at `type`.
 * - `machine` on a local target is a *real* position the user reached before
 *   switching destination. Falling back to `type` throws away the progress
 *   they can see in the stepper, so resolve to the next step that still
 *   exists (`code`) — the same place "Next" would have taken them.
 */
export function resolveStep(
  requested: string | null | undefined,
  destination: SandboxDestination,
): WizardStepKey {
  const steps = stepsFor(destination);
  if (!isWizardStepKey(requested)) return steps[0].key;
  if (steps.some((s) => s.key === requested)) return requested;
  // Hidden but valid: take the nearest later step that survives.
  const orderIndex = SANDBOX_STEP_KEYS.indexOf(requested);
  const next = SANDBOX_STEP_KEYS.slice(orderIndex + 1).find((key) =>
    steps.some((s) => s.key === key),
  );
  return next ?? steps[steps.length - 1].key;
}

/**
 * The destination to open with.
 *
 * The URL wins when it names one, because it records what the user last chose
 * in this drawer. Without it, fall back to the saved provider — "local"
 * included: the config stores it now, so coercing it to Civo would reopen the
 * drawer on a destination the project did not pick. Civo remains the fallback
 * for a config that predates the field.
 */
export function resolveDestination(
  fromUrl: string | null | undefined,
  savedProvider: string | null | undefined,
): SandboxDestination {
  if (isSandboxDestination(fromUrl)) return fromUrl;
  return isSandboxDestination(savedProvider) ? savedProvider : "civo";
}

/**
 * Both restored values at once, resolved in the right order: the destination
 * decides which steps exist, so it has to settle before the step does.
 */
export function restoreWizardState(
  search: string,
  savedProvider: string | null | undefined,
): { destination: SandboxDestination; step: WizardStepKey } {
  const params = new URLSearchParams(search);
  const destination = resolveDestination(
    params.get(SANDBOX_DESTINATION_PARAM),
    savedProvider,
  );
  return {
    destination,
    step: resolveStep(params.get(SANDBOX_STEP_PARAM), destination),
  };
}

/**
 * Write the wizard's position back into a URL.
 *
 * `open === false` keeps the step and destination params: the editor stays
 * mounted behind the drawer's close animation, so dropping them would leave
 * the URL disagreeing with the wizard, and reopening would look like a reset.
 */
export function applyWizardParams(
  href: string,
  {
    open,
    step,
    destination,
  }: { open: boolean; step: WizardStepKey; destination: SandboxDestination },
): string {
  const url = new URL(href);
  if (open) url.searchParams.set(SANDBOX_OPEN_PARAM, "1");
  else url.searchParams.delete(SANDBOX_OPEN_PARAM);
  url.searchParams.set(SANDBOX_STEP_PARAM, step);
  url.searchParams.set(SANDBOX_DESTINATION_PARAM, destination);
  return url.toString();
}
