import * as React from "react";

/**
 * Whether the viewport is below a Tailwind breakpoint, in JavaScript.
 *
 * For layout that CSS cannot reach. The case this exists for is
 * `react-resizable-panels`: it writes pixel widths inline, so a `lg:flex-col`
 * class cannot make its panels stack — the inline style wins and the rail ends
 * up 108px wide on a phone, with its content shredded. The component has to
 * *not render as a split* below the breakpoint, which is a JS decision.
 *
 * Returns false during SSR and the first client render, so the server and the
 * client agree on the wide layout and narrow screens correct themselves on
 * mount. The alternative — guessing narrow — would flash the stacked layout on
 * every desktop load.
 */
export function useBelowBreakpoint(px: number): boolean {
  const [below, setBelow] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${px - 1}px)`);
    const onChange = () => setBelow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [px]);

  return below;
}

/** Tailwind's `lg`, the width this app switches to side-by-side layouts at. */
export const LG_BREAKPOINT = 1024;
