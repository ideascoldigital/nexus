export type Mode = "local" | "server";

export const MODE: Mode =
  process.env.NEXUX_MODE === "server" ? "server" : "local";

export const isLocal = MODE === "local";
export const isServer = MODE === "server";
