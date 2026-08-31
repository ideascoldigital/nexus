import { ToolInputError } from "./types";

/**
 * Argument narrowing for tool inputs. Hand-written rather than schema-derived:
 * the package deliberately carries no dependencies (that is what keeps it
 * publishable and keeps a tool from reaching past its context), and the checks
 * tools actually need are few.
 *
 * Every failure is a `ToolInputError`, which the transport answers as a tool
 * error rather than a crash — a client sending the wrong shape is an ordinary
 * event, not an exception.
 */

export function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolInputError("Arguments must be an object");
  }
  return raw as Record<string, unknown>;
}

export function requiredString(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`\`${key}\` is required and must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError(`\`${key}\` must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A bounded positive integer. Out-of-range values are clamped rather than
 * refused: a client asking for more log lines than we serve wants the most it
 * can get, not an error.
 */
export function optionalInt(
  raw: Record<string, unknown>,
  key: string,
  opts: { min: number; max: number },
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`\`${key}\` must be a number`);
  }
  const int = Math.floor(value);
  return Math.min(opts.max, Math.max(opts.min, int));
}

export function optionalEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(
      `\`${key}\` must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

export function requiredEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = requiredString(raw, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(
      `\`${key}\` must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}
