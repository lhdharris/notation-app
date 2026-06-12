# Building Notation v1.2.1 on macOS + uploading to the GitHub release

Instructions for Claude Code running on the Mac. Goal: build the macOS and
Windows installers for **v1.2.1** and upload them to the **already-published**
GitHub release `v1.2.1`, which was created from the Linux machine and already
contains the `.rpm` and `.deb`.

Repo: `lhdharris/notation-app` (https://github.com/lhdharris/notation-app).
This folder syncs between machines via Syncthing, so the v1.2.1 commit should
already be present locally — verify rather than assume (step 1).

## 0. Prerequisites

- Node.js + npm (any recent LTS works; the app pins Electron 33 itself).
- `gh` CLI authenticated as `lhdharris`: `gh auth status` must succeed.
  If not: `gh auth login`.
- No signing identities needed: the mac build is intentionally unsigned
  (`mac.identity: null` in package.json) and the Windows NSIS installer is
  unsigned too.

## 1. Verify the synced repo state

```bash
cd <this folder>           # the synced notation-app repo root
git log --oneline -1       # must be the greyscale-icon commit ("Greyscale
                           # gradient icon background…"), AFTER "Notation v1.2.1"
grep '"version"' electron-app/package.json   # must say 1.2.1
git status --short         # should be clean (untracked dist/ files are fine)
```

If the v1.2.1 commit isn't here yet, Syncthing hasn't caught up — `git pull`
from GitHub instead (the commit is pushed to `main`).

The release should already exist with the two Linux assets:

```bash
gh release view v1.2.1 --repo lhdharris/notation-app
```

## 2. Install dependencies (per-platform, not synced)

`node_modules/` is gitignored and Linux-built natives don't run on macOS, so:

```bash
cd electron-app
rm -rf node_modules
npm install
```

## 3. Build macOS (both architectures) and Windows

```bash
npx electron-builder --mac dmg --x64 --arm64   # → dist/Notation-1.2.1.dmg (intel) + Notation-1.2.1-arm64.dmg
npm run dist:win                               # → dist/Notation Setup 1.2.1.exe (NSIS, x64)
```

Notes:
- Exact dmg/exe filenames may differ slightly (electron-builder derives them
  from `productName: "Notation"`); read them from the build output or
  `ls dist/`.
- The Windows cross-build needs no Wine with electron-builder 26 — if it
  nevertheless complains about missing wine, `brew install --cask wine-stable`
  and rerun.
- Smoke-test the mac build before uploading: `open "dist/Notation-1.2.1-arm64.dmg"`
  (or the x64 one on an Intel Mac), drag-launch the app, open a `.md` file,
  confirm the editor renders and the Dock shows the **pastel sticky-notes icon
  on a light grey-to-white gradient** (not the old grey document, and not a
  dark background — dark means you built a stale commit). Gatekeeper will warn
  because it's unsigned — right-click → Open.

## 4. Upload to the existing GitHub release

The `v1.2.1` release and tag already exist (created from the Linux box with the
`.rpm` and `.deb`), so just upload — substitute the actual dmg/exe filenames
from step 3:

```bash
cd <repo root>
gh release upload v1.2.1 \
  --repo lhdharris/notation-app \
  "electron-app/dist/Notation-1.2.1.dmg" \
  "electron-app/dist/Notation-1.2.1-arm64.dmg" \
  "electron-app/dist/Notation Setup 1.2.1.exe"
```

(Don't upload `.blockmap`/`.yml` update-metadata files — the app has no
auto-updater; releases ship bare packages only.)

## 5. Verify

```bash
gh release view v1.2.1 --repo lhdharris/notation-app
```

Confirm: tag `v1.2.1`, five assets (2 dmg, 1 exe, 1 rpm, 1 deb), and the notes
render correctly. Done.
