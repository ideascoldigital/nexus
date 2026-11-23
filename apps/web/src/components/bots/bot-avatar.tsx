// A bot's face: one of the generated shapes in the bot's color, with two eyes.
// `sleeping` closes the eyes (the computer is off).
//
// At rest a bot leans a little and glances up to one side; when you point at
// it (hovering the avatar or any `.group` around it, or `looking`) it turns to
// face you with a small spring. The motion is CSS (`.bot-face` in
// globals.css) on plain HTML boxes — body and eyes are two stacked SVGs —
// because WebKit (the desktop app's webview) does not reliably animate CSS
// transforms on SVG <g> elements.

import { BOT_SHAPE_PATHS, BOT_SHAPE_TILT, isBotShape, type BotShape } from "@/lib/bot-shapes";
import { cn } from "@/lib/utils";

const EYE = "#18181b";

export function BotAvatar({
  shape,
  color,
  size = 36,
  sleeping = false,
  looking = false,
  className,
}: {
  shape: BotShape | string;
  color: string;
  size?: number;
  sleeping?: boolean;
  /** Face forward regardless of hover (e.g. the selected bot). */
  looking?: boolean;
  className?: string;
}) {
  const s: BotShape = isBotShape(shape) ? shape : "blob";
  const tilt = BOT_SHAPE_TILT[s] ?? 0;
  return (
    <span
      className={cn("bot-face relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-looking={looking ? "" : undefined}
      aria-hidden
    >
      <span className="bot-body absolute inset-0 block">
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible">
          <g transform={tilt ? `rotate(${tilt} 50 50)` : undefined}>
            <path d={BOT_SHAPE_PATHS[s]} fill={color} />
          </g>
        </svg>
        <svg viewBox="0 0 100 100" className="bot-eyes absolute inset-0 h-full w-full overflow-visible">
          {sleeping ? (
            <g stroke={EYE} strokeWidth={4} strokeLinecap="round" fill="none">
              <path d="M36 50 q5 4 10 0" />
              <path d="M54 50 q5 4 10 0" />
            </g>
          ) : (
            <g fill={EYE}>
              <rect x={38.5} y={38} width={7} height={15} rx={3.5} />
              <rect x={54.5} y={38} width={7} height={15} rx={3.5} />
              <circle cx={42} cy={41.5} r={1.6} fill="#fff" opacity={0.85} />
              <circle cx={58} cy={41.5} r={1.6} fill="#fff" opacity={0.85} />
            </g>
          )}
        </svg>
      </span>
    </span>
  );
}
