# Building Notation v1.2.0 on macOS + releasing on GitHub

Instructions for Claude Code running on the Mac. Goal: build the macOS and
Windows installers for **v1.2.0**, then publish a GitHub release containing
**all four** artifacts — the two you build here plus the two Linux packages that
were already built on the Linux machine.

Repo: `lhdharris/notation-app` (https://github.com/lhdharris/notation-app).
This folder syncs between machines via Syncthing, so the v1.2.0 commit and the
Linux build artifacts should already be present locally — verify rather than
assume (step 1).

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
git log --oneline -1       # must be the "Notation v1.2.0" commit
grep '"version"' electron-app/package.json   # must say 1.2.0
git status --short         # should be clean (untracked dist/ files are fine)
```

If the v1.2.0 commit isn't here yet, Syncthing hasn't caught up — `git pull`
from GitHub instead (the commit is pushed to `main`).

The Linux packages should already exist (built on the Linux box):

```bash
ls -la electron-app/dist/notation-app-1.2.0.x86_64.rpm \
       electron-app/dist/notation-app_1.2.0_amd64.deb
```

If they're missing (e.g. Syncthing ignores `dist/`), the `.deb` can be rebuilt
right here with `npm run dist:deb`; the `.rpm` needs `brew install rpm` first,
then `npm run dist`. Otherwise ask the user to copy them over — don't release
without them.

## 2. Install dependencies (per-platform, not synced)

`node_modules/` is gitignored and Linux-built natives don't run on macOS, so:

```bash
cd electron-app
rm -rf node_modules
npm install
```

## 3. Build macOS (both architectures) and Windows

```bash
npx electron-builder --mac dmg --x64 --arm64   # → dist/Notation-1.2.0.dmg (intel) + Notation-1.2.0-arm64.dmg
npm run dist:win                               # → dist/Notation Setup 1.2.0.exe (NSIS, x64)
```

Notes:
- Exact dmg/exe filenames may differ slightly (electron-builder derives them
  from `productName: "Notation"`); read them from the build output or
  `ls dist/`.
- The Windows cross-build needs no Wine with electron-builder 26 — if it
  nevertheless complains about missing wine, `brew install --cask wine-stable`
  and rerun.
- Smoke-test the mac build before releasing: `open "dist/Notation-1.2.0-arm64.dmg"`
  (or the x64 one on an Intel Mac), drag-launch the app, open a `.md` file,
  confirm the editor + formatting toolbar render. Gatekeeper will warn because
  it's unsigned — right-click → Open.

## 4. Create the GitHub release

Release body = the **v1.2.0 section only** of `RELEASE_NOTES.md` (everything
above the first `---` separator):

```bash
cd <repo root>
sed -n '1,/^---$/p' RELEASE_NOTES.md | sed '$d' > /tmp/notation-1.2.0-notes.md
```

Then create the release (this also creates the `v1.2.0` tag on `main`) with all
four artifacts — substitute the actual dmg/exe filenames from step 3:

```bash
gh release create v1.2.0 \
  --repo lhdharris/notation-app \
  --target main \
  --title "Notation v1.2.0" \
  --notes-file /tmp/notation-1.2.0-notes.md \
  "electron-app/dist/Notation-1.2.0.dmg" \
  "electron-app/dist/Notation-1.2.0-arm64.dmg" \
  "electron-app/dist/Notation Setup 1.2.0.exe" \
  "electron-app/dist/notation-app-1.2.0.x86_64.rpm" \
  "electron-app/dist/notation-app_1.2.0_amd64.deb"
```

(Don't upload `.blockmap`/`.yml` update-metadata files — the app has no
auto-updater; the v1.1.1 release shipped bare packages only.)

## 5. Verify

```bash
gh release view v1.2.0 --repo lhdharris/notation-app
```

Confirm: tag `v1.2.0`, five assets (2 dmg, 1 exe, 1 rpm, 1 deb), and the notes
render correctly. Done.
