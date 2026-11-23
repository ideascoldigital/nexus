"use client";

// In the desktop app a right-click falls through to the WebView's own menu,
// whose entire contents are Back and Reload — two things that make no sense
// here: there is nothing to go back to, and a reload throws away the page's
// state. So the shell gets no native menu, except where it is the only way to
// do something the page does not offer: editing text, and copying a selection.
//
// In a browser the native menu is left alone — "inspect" and "open in new tab"
// are the browser's to give, and taking them away would only annoy.

import { useEffect } from "react";

const EDITABLE = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

function inDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function NativeMenuGuard() {
  useEffect(() => {
    if (!inDesktopShell()) return;
    const onContextMenu = (event: MouseEvent) => {
      // A menu of ours already claimed this click.
      if (event.defaultPrevented) return;
      const target = event.target as Element | null;
      if (target?.closest?.(EDITABLE)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
  return null;
}
