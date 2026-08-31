// Nexus Point — the brand mark: agents (satellite nodes) converging on a
// core. From the "Nexus Identity" design doc, direction 1a.

const SIGNAL = "oklch(0.74 0.15 300)";
const CORE = "oklch(0.8 0.15 300)";

/** Full 5-node mark. Use at 24px and up. */
export function NexusMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden
    >
      <line x1="50" y1="50" x2="14" y2="24" stroke={SIGNAL} strokeWidth="3" opacity="0.55" />
      <line x1="50" y1="50" x2="86" y2="24" stroke={SIGNAL} strokeWidth="3" opacity="0.55" />
      <line x1="50" y1="50" x2="12" y2="62" stroke={SIGNAL} strokeWidth="3" opacity="0.55" />
      <line x1="50" y1="50" x2="88" y2="62" stroke={SIGNAL} strokeWidth="3" opacity="0.55" />
      <line x1="50" y1="50" x2="50" y2="90" stroke={SIGNAL} strokeWidth="3" opacity="0.55" />
      <circle cx="14" cy="24" r="6" fill={SIGNAL} />
      <circle cx="86" cy="24" r="6" fill={SIGNAL} />
      <circle cx="12" cy="62" r="6" fill={SIGNAL} />
      <circle cx="88" cy="62" r="6" fill={SIGNAL} />
      <circle cx="50" cy="90" r="6" fill={SIGNAL} />
      <circle cx="50" cy="50" r="13" fill={CORE} />
    </svg>
  );
}

/** Simplified 3-node mark for tiny sizes (< 24px). */
export function NexusMarkSmall({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden
    >
      <line x1="50" y1="50" x2="20" y2="30" stroke={SIGNAL} strokeWidth="7" />
      <line x1="50" y1="50" x2="80" y2="30" stroke={SIGNAL} strokeWidth="7" />
      <line x1="50" y1="50" x2="50" y2="84" stroke={SIGNAL} strokeWidth="7" />
      <circle cx="20" cy="30" r="10" fill={SIGNAL} />
      <circle cx="80" cy="30" r="10" fill={SIGNAL} />
      <circle cx="50" cy="84" r="10" fill={SIGNAL} />
      <circle cx="50" cy="50" r="16" fill={CORE} />
    </svg>
  );
}

/** The mark in its rounded-square app-icon container. */
export function NexusLogoTile({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.23),
        background:
          "radial-gradient(circle at 50% 40%, oklch(0.27 0.06 300), oklch(0.15 0.012 255))",
        border: "1px solid oklch(0.36 0.05 300)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <NexusMark size={Math.round(size * 0.6)} />
    </div>
  );
}
