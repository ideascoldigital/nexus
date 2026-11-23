/**
 * One-click update for the native app: download the platform asset of the
 * newest release and install it (see lib/self-update.ts for the per-OS
 * mechanics). Native only — on a browser install "update" means pulling a new
 * image (Settings → Nexus hosts), and on a dev checkout it means git pull;
 * both answer 404 here so the statusbar falls back to linking the release.
 *
 * Runs through the same entry point as the background auto-updater
 * (lib/auto-update.ts), so a click during a background download joins it
 * instead of starting a second one over the same /Applications bundle.
 */

import { NextResponse } from "next/server";

import { installLatest } from "@/lib/auto-update";
import { localRequestRejection } from "@/lib/local-request";

export const dynamic = "force-dynamic";

export type InstallResult = {
  ok: boolean;
  message: string;
  tag: string;
};

export async function POST(req: Request) {
  if (process.env.NEXUX_NATIVE !== "1") {
    return NextResponse.json(
      { error: "self-install is only available in the native app" },
      { status: 404 },
    );
  }
  // No auth here (D-34): without this any website could make the app
  // download and replace itself.
  const refused = localRequestRejection(req);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  // force: the user asked, so the release-build gate does not apply.
  const state = await installLatest({ force: true });
  if (state.phase === "error") {
    return NextResponse.json({ error: state.message ?? "update failed" }, { status: 502 });
  }
  const body: InstallResult =
    state.phase === "installed"
      ? { ok: true, message: state.message ?? "Installed — restart Nexus to finish.", tag: state.tag ?? "" }
      : { ok: true, message: `Nexus ${state.current ?? ""} is already up to date.`, tag: state.tag ?? "" };
  return NextResponse.json(body);
}
