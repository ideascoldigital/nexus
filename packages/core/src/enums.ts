export const FEATURE_STATUSES = [
  "backlog",
  "todo",
  "queued",
  "in_progress",
  "in_review",
  "done",
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const FEATURE_PRIORITIES = [
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

/**
 * Whether a feature's sandbox run opens a pull request. The stored column is
 * nullable (`Feature.createPr`) so "inherit" is a real, distinct state: the
 * feature follows `SandboxConfig.createPr` and moves with it, while `always`
 * and `never` pin the feature regardless of the project default.
 */
export const FEATURE_PR_MODES = ["inherit", "always", "never"] as const;
export type FeaturePrMode = (typeof FEATURE_PR_MODES)[number];

/** Tri-state selector value → the nullable boolean stored on the feature. */
export function prModeToCreatePr(mode: FeaturePrMode): boolean | null {
  return mode === "inherit" ? null : mode === "always";
}

/** Stored nullable boolean → the tri-state selector value. */
export function createPrToPrMode(createPr: boolean | null | undefined): FeaturePrMode {
  return createPr == null ? "inherit" : createPr ? "always" : "never";
}

export const CONVERSATION_STATUSES = [
  "idle",
  "running",
  "paused",
  "completed",
  "error",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CLONE_STATUSES = [
  "pending",
  "cloning",
  "ready",
  "error",
] as const;
export type CloneStatus = (typeof CLONE_STATUSES)[number];

export const PLAN_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
