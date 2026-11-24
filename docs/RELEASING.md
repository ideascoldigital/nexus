# Nexux — Cutting a release

One tag drives everything. You never bump a version by hand: CI runs
[`scripts/set-version.sh`](../scripts/set-version.sh) from the tag before
building, so the tag is the single source of truth and a forgotten local bump
cannot ship a build whose baked-in version disagrees with its release.

There are **two moments that matter**, and only the second one ships:

1. **Pushing the tag** builds everything and leaves the desktop bundles on a
   *draft* release. Nothing reaches a user yet (the container image is the
   exception — see below).
2. **Publishing that draft** is the switch. GitHub's `/releases/latest` starts
   answering with it, and that single fact is what Homebrew and the in-app
   auto-updater both key off.

## The pipeline

```
          git tag v0.3.6 && git push origin main v0.3.6
                              │
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
 release-native.yml                        release-image.yml
 ─────────────────────                     ────────────────────
 verify: parity tests                      build linux/amd64
 set-version.sh "$TAG"                     push ghcr.io/ideascoldigital/nexus
 build: macOS arm64 │ Linux │ Windows         :0.3.6  :0.3  :latest
 (~30 min, one job per OS)                           │
         │                                           ▼
         ▼                                  a Nexus host pulls :latest
 ┌ DRAFT release ──────────────┐            → docs/DEPLOYMENT.md
 │ Nexus_0.3.6_aarch64.dmg     │            (ships at tag push, no
 │ Nexus_aarch64.app.tar.gz    │             publish step involved)
 │ _amd64.AppImage .deb .rpm   │
 │ _x64-setup.exe  _x64.msi    │
 └─────────────────────────────┘
         │
         │   ◀── you press "Publish release"   ← the only manual step
         ▼
 ┌ PUBLISHED release — this is what /releases/latest answers ─────────┐
 └────────┬──────────────────────┬───────────────────────┬────────────┘
          ▼                      ▼                       ▼
   bump-homebrew.yml      installed apps          manual downloads
   (this repo)            lib/auto-update.ts      (the release page)
   repository_dispatch     boot + every 6h
          │                      │
          ▼                      ▼
   ideascoldigital/        downloads, installs,
   homebrew-tap            shows "Restart" (D-93)
   bump workflow:
   sha256 + commit
          │
          ▼
   brew upgrade --cask ideascoldigital/tap/nexus
```

## Doing it

```bash
git checkout main && git pull

# Optional but tidy: bump the manifests locally so dev builds report the
# right number. CI does this from the tag anyway, so skipping it is safe.
scripts/set-version.sh 0.3.6
pnpm --filter @nexux/native test        # native ↔ web parity
git commit -am "release: v0.3.6"

git tag v0.3.6
git push origin main v0.3.6
```

Then:

1. Watch **Release native app** in
   [Actions](https://github.com/ideascoldigital/nexus/actions). Three build
   jobs, ~30 minutes. `fail-fast` is off, so one OS failing still produces the
   others — the draft is created by whichever job finishes first and the rest
   attach to it.
2. Open [Releases](https://github.com/ideascoldigital/nexus/releases), check
   the draft has all seven assets, write the notes, and press **Publish
   release**. Leave "set as a pre-release" unchecked.
3. **Bump Homebrew tap** fires on publish and dispatches to the tap, which
   downloads the new dmg, recomputes its sha256, runs `brew style` +
   `brew audit --online` and commits to the tap's main. A couple of minutes.
4. `brew upgrade --cask ideascoldigital/tap/nexus` now has it; running apps
   pick it up within six hours, or at their next boot.

### Why publishing is a separate, manual step

A draft release is invisible to anonymous HTTP and to `releases/latest`. So a
Homebrew bump fired at the end of the build would fail when it tried to
download the dmg to hash it, and the auto-updater would never see the version.
Publishing is also the human gate: it is the moment someone has actually
looked at the bundles.

## Pre-releases

Publishing a draft **as a pre-release** keeps the desktop channels quiet:
`bump-homebrew.yml` skips on `if: !github.event.release.prerelease`, and
`releases/latest` ignores pre-releases, so the auto-updater does too. That is
deliberate — `brew install --cask nexus` should not hand anyone a beta.

**But the container image does not have that nuance.** In
`release-image.yml`, `:latest` is set by a `type=raw` line whose only
condition is "the ref is a `v*` tag", and raw tags are not subject to
metadata-action's prerelease filtering. So pushing `v0.3.6-rc1` *moves GHCR's
`:latest`* onto the release candidate, and the next Nexus host to provision
pulls it. If you need to exercise the tag pipeline without touching what hosts
pull, run **Release server image** manually with `push: false`, or accept the
image move knowingly.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| No draft appeared | **Release native app** → the `verify` job. Parity tests gate the builds. |
| Draft is missing the dmg | The macOS job. The sidecar embeds the build host's own `node`, so there is no cross-compilation and no second macOS arch — arm64 only, by design. |
| Release published, cask still old | **Bump Homebrew tap** in this repo. A 401 there means `HOMEBREW_TAP_TOKEN` expired (see below). |
| Bump ran green, cask still old | The tap's **bump** run. The guard logs `already at <version>; nothing to bump` when the dmg's version already matches. |
| Cask points at a version that 404s | The dmg name must match `Nexus_<version>_aarch64.dmg`. A renamed bundle breaks the cask's url template. |
| Apps do not self-update | Only CI tag builds do (`build-info.json` carries `release: true` only when `NEXUX_VERSION` came from a tag). `NEXUX_AUTO_UPDATE=0` also turns it off. See D-93. |
| Host pulled an old image | `:latest` only moves on a `v*` tag; pushes to main publish `edge`, never `latest`. |

### The Homebrew hop depends on a token

`bump-homebrew.yml` authenticates its `repository_dispatch` with
`HOMEBREW_TAP_TOKEN`, a fine-grained PAT scoped to `ideascoldigital/homebrew-tap`
with `Contents: Read and write`. It belongs to a person and **expires**, and
when it does the release publishes normally while only the dispatch fails with
a 401 — nothing in the release itself looks wrong.

The fallback needs no token: run the tap's **bump** workflow by hand from its
Actions tab with the app name (`nexus`) and the version (`0.3.6`). It does
exactly what the dispatch would have done.
