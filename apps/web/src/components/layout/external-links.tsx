"use client";

// Outward links inside the desktop app: there is no tab for them, so the page
// hands them to the system browser. See lib/external-links.

import { useEffect } from "react";

import { installExternalLinkBridge } from "@/lib/external-links";

export function ExternalLinks() {
  useEffect(() => installExternalLinkBridge(), []);
  return null;
}
