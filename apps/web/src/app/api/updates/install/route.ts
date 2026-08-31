/**
 * One-click update for the native app: download the platform asset of the
 * newest release and install it (see lib/self-update.ts for the per-OS
 * mechanics). Native only — on a browser install "update" means pulling a new
 * image (Settings → Nexus hosts), and on a dev checkout it means git pull;
 * both answer 404 here so the statusbar falls back to linking the release.
 */

import { NextResponse } from "next/server";

import {
  downloadAsset,
  installAsset,
  latestReleaseAssets,
  pickAsset,
} from "@/lib/self-update";

export const dynamic = "force-dynamic";

export type InstallResult = {
  ok: boolean;
  message: string;
  tag: string;
};

export async function POST() {
  if (process.env.NEXUX_NATIVE !== "1") {
    return NextResponse.json(
      { error: "self-install is only available in the native app" },
      { status: 404 },
    );
  }
  try {
    const { tag, assets } = await latestReleaseAssets();
    const name = pickAsset(
      assets.map((a) => a.name),
      process.platform,
      process.arch,
    );
    const asset = assets.find((a) => a.name === name);
    if (!asset) {
      return NextResponse.json(
        { error: `release ${tag} has no asset for ${process.platform}/${process.arch}` },
        { status: 502 },
      );
    }
    const file = await downloadAsset(asset);
    const message = await installAsset(file);
    const body: InstallResult = { ok: true, message, tag };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
