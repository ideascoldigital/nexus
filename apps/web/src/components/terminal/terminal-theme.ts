import type { ITheme } from "@xterm/xterm";

// Nexus Identity terminal theme. xterm can't parse oklch, so these are the
// sRGB conversions of the brand palette: bg oklch(0.12 0.01 255), Ivory text,
// Signal violet cursor/magenta, Amber yellow.
export const NEXUS_TERMINAL_THEME: ITheme = {
  background: "#040609",
  foreground: "#f0f2f4",
  cursor: "#ba93fb",
  cursorAccent: "#040609",
  selectionBackground: "#ba93fb40",
  black: "#10141a",
  red: "#d15c56",
  green: "#63d18f",
  yellow: "#f9bb51",
  blue: "#58a5e4",
  magenta: "#ba93fb",
  cyan: "#66cfe1",
  white: "#f0f2f4",
  brightBlack: "#50565e",
  brightRed: "#f97770",
  brightGreen: "#6cefa2",
  brightYellow: "#ffd164",
  brightBlue: "#78bff9",
  brightMagenta: "#d1b0ff",
  brightCyan: "#8ae5f5",
  brightWhite: "#ffffff",
};

export const NEXUS_TERMINAL_FONT =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", "MesloLGS NF", "Fira Code", "SF Mono", Menlo, Consolas, monospace';
