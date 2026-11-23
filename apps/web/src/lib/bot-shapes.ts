// Bot avatars (spec 31): a shape + a color, with a face. The shapes are
// plain geometry generated here (polar curves and superformulas), so there are
// no image assets. Pure and client-safe: the API validates against the ids,
// the UI draws the paths.

export const BOT_SHAPES = [
  "blob",
  "circle",
  "squircle",
  "tilted",
  "flower",
  "cloud",
  "star",
  "gear",
  "egg",
  "pill",
  "triangle",
  "hexagon",
  "diamond",
] as const;

export type BotShape = (typeof BOT_SHAPES)[number];

export const BOT_COLORS = [
  "#f4f4f5", // white
  "#a16a3e", // brown
  "#ef4444", // red
  "#f2602a", // vermilion
  "#f59e0b", // orange
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#71717a", // gray
] as const;

export function isBotShape(v: unknown): v is BotShape {
  return typeof v === "string" && (BOT_SHAPES as readonly string[]).includes(v);
}

/** A closed path through r(θ) around (50, 50), sampled finely enough to look smooth. */
function polar(r: (t: number) => number, steps = 144): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const rad = r(t);
    pts.push(`${(50 + rad * Math.cos(t)).toFixed(2)},${(50 + rad * Math.sin(t)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** Gielis superformula, scaled so its widest point is `size`. */
function superformula(m: number, n1: number, n2: number, n3: number, size: number, turn = 0) {
  const raw = (t: number) => {
    const a = Math.abs(Math.cos((m * t) / 4)) ** n2;
    const b = Math.abs(Math.sin((m * t) / 4)) ** n3;
    return (a + b) ** (-1 / n1);
  };
  let max = 0;
  for (let i = 0; i < 360; i++) max = Math.max(max, raw((i / 360) * Math.PI * 2));
  return (t: number) => (raw(t + turn) / max) * size;
}

const rounded = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;

export const BOT_SHAPE_PATHS: Record<BotShape, string> = {
  blob: polar((t) => 38 + 4 * Math.cos(2 * t + 0.6) + 3 * Math.sin(3 * t)),
  circle: polar(() => 38),
  squircle: rounded(14, 14, 72, 72, 26),
  tilted: rounded(16, 16, 68, 68, 18),
  flower: polar((t) => 36 + 6 * Math.cos(6 * t)),
  cloud: polar((t) => 36 + 5 * Math.abs(Math.cos(2.5 * t)) - 1),
  star: polar((t) => 32 + 10 * Math.cos(4 * t)),
  gear: polar((t) => 37 + 3.5 * Math.cos(10 * t)),
  egg: polar((t) => 36 - 5 * Math.sin(t) + 2 * Math.cos(2 * t)),
  pill: rounded(8, 24, 84, 52, 26),
  triangle: polar(superformula(3, 4.5, 10, 10, 42, Math.PI / 2)),
  hexagon: polar(superformula(6, 8, 6, 6, 40)),
  diamond: polar(superformula(4, 3, 7, 7, 42)),
};

/** Shapes drawn rotated a little, for character. */
export const BOT_SHAPE_TILT: Partial<Record<BotShape, number>> = { tilted: -12, pill: -8 };

/**
 * Text color that reads on a bot-colored surface (your messages use the bot's
 * color): dark on the light ones (white, amber, green), white on the rest.
 * WCAG relative luminance with a threshold above the strict 0.18 crossover,
 * so saturated mid-tones (blue, pink, red) keep white text, as chat apps do.
 */
export function textOn(hex: string): "#ffffff" | "#18181b" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return lum > 0.4 ? "#18181b" : "#ffffff";
}
