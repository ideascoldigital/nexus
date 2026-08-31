// Single-series sparkline: pure SVG, server-renderable, strokes in
// currentColor so the parent's text token picks the hue. Per the dataviz
// method: 2px line, area at low opacity, a single end-point marker, no axes
// or grid — the tile's number is the readable value, the line is its shape.

export function Sparkline({
  points,
  width = 120,
  height = 32,
  className,
  label,
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Accessible summary, e.g. "Daily spend, last 14 days". */
  label?: string;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1e-9);
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const x = (i: number) => pad + (i / (points.length - 1)) * w;
  const y = (v: number) => pad + h - (v / max) * h;
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `M ${x(0)},${pad + h} L ${line.split(" ").join(" L ")} L ${x(points.length - 1)},${pad + h} Z`;
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={label}
    >
      {label && <title>{label}</title>}
      <path d={area} fill="currentColor" opacity={0.12} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={x(points.length - 1)} cy={y(last)} r={3} fill="currentColor" />
    </svg>
  );
}
