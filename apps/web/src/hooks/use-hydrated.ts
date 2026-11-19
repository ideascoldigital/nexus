import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * False on the server and while React hydrates, true afterwards.
 *
 * For UI whose first client render could differ from the server's for reasons
 * that are not state — a react-query cache another component already filled
 * before this subtree hydrated (a Suspense boundary hydrates late), say.
 * Rendering the server's output until hydration is done keeps the two equal;
 * the real content follows in the same tick.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
