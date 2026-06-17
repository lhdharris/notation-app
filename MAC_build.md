# Cutting a Notation release on macOS (build all platforms + publish to GitHub)

Instructions for Claude Code running on the Mac. This Mac is the release machine:
it bumps the version, builds the macOS, Windows and Linux packages, and creates a
new GitHub release with all of them attached.

Repo: `lhdharris/notation-app` (https://github.com/lhdharris/notation-app).
This folder syncs between machines via Syncthing, so `main` should already be
up to date locally — verify rather than assume (step 1).

Throughout, set `VERSION` once and reuse it (example bumps a patch release):

```bash
VERSION=1.2.5          # the NEW version you're cutting (last release is 1.2.3)
```

> **For v1.2.5 the Linux box already did the first half.** The version bump
> (`package.json` → 1.2.5), the new `RELEASE_NOTES.md` section, the Linux `.rpm`
> (`electron-app/dist/notation-app-1.2.5.x86_64.rpm`), and the release commit
> (`Notation v1.2.5: …`) are all done and synced here via Syncthing — but **not
> pushed**. So on the Mac you **skip the bump/notes/commit in step 2**: just
> confirm the synced commit, `git push origin main` and tag, then build the
> remaining platforms (step 4 — you can reuse the synced `.rpm` instead of
> building rpm on macOS) and publish (step 5). The generic step 2 below is for a
> normal release where the Mac does the whole thing.

## 0. Prerequisites

- Node.js + npm (any recent LTS). The app pins its own Electron and
  electron-builder versions in `electron-app/package.json` (currently Electron
  42 / electron-builder 26) — npm install brings them in; nothing to install
  globally.
- `gh` CLI authenticated as `lhdharris`: `gh auth status` must succeed.
  If not: `gh auth login`.
- No signing identities needed: the mac build is intentionally unsigned
  (`mac.identity: null` in package.json) and the Windows NSIS installer is
  unsigned too. Gatekeeper/SmartScreen will warn; that's expected.

## 1. Verify the synced repo state

```bash
cd <this folder>          # the synced notation-app repo root
git switch main && git pull   # make sure you're cutting from the latest main
git log --oneline -3
grep '"version"' electron-app/package.json   # the CURRENT (pre-bump) version
gh release list --repo lhdharris/notation-app   # confirm the last release tag
```

The new `$VERSION` must be greater than every existing tag (the in-app updater
compares semver and only offers strictly-newer releases — see step 6).

## 2. Bump the version + write the release notes

1. Bump `electron-app/package.json` (and its lockfile) to `$VERSION`:

   ```bash
   ( cd electron-app && npm version "$VERSION" --no-git-tag-version )
   grep '"version"' electron-app/package.json   # confirm it now says $VERSION
   ```

2. Prepend a new `# Notation v$VERSION` section to `RELEASE_NOTES.md`
   (keep older sections below it). This text becomes the GitHub release body in
   step 5 and is what the in-app update banner shows, so write it for users.

3. Commit and tag:

   ```bash
   git add electron-app/package.json electron-app/package-lock.json RELEASE_NOTES.md
   git commit -m "Notation v$VERSION"
   git tag "v$VERSION"
   git push origin main "v$VERSION"
   ```

## 3. Install dependencies (per-platform, not synced)

`node_modules/` is gitignored and the natives differ per OS, so install fresh on
the Mac:

```bash
cd electron-app
rm -rf node_modules
npm install
```

## 4. Build every platform

Run from `electron-app/`. macOS builds both architectures; Windows and Linux are
cross-built by electron-builder (no Wine needed with electron-builder 26):

```bash
npx electron-builder --mac dmg --x64 --arm64   # → dist/Notation-$VERSION.dmg (intel) + Notation-$VERSION-arm64.dmg
npm run dist:win                               # → dist/Notation Setup $VERSION.exe (NSIS, x64)
npx electron-builder --linux deb rpm           # → notation-app_${VERSION}_amd64.deb + notation-app-$VERSION.x86_64.rpm
ls -la dist/                                   # read the EXACT filenames from here
```

Notes:
- Exact dmg/exe filenames may differ slightly (electron-builder derives them from
  `productName: "Notation"`); always read them from `ls dist/` before uploading.
- **rpm on macOS is the one fragile target.** If `--linux rpm` fails, try
  `brew install rpm` and rerun just `npx electron-builder --linux rpm`. If it
  still won't build, build the `.rpm` on the Linux box (`npm run dist`) and add
  it to the release in step 5 with `gh release upload v$VERSION <file.rpm>`.
  The rpm matters: the updater serves it to Fedora/RHEL/openSUSE users.
- If the Windows cross-build complains about wine despite electron-builder 26:
  `brew install --cask wine-stable` and rerun.

## 5. Smoke-test, then create the GitHub release

Smoke-test the mac build before publishing:
`open "dist/Notation-$VERSION-arm64.dmg"` (or the x64 one on an Intel Mac),
drag-launch, open a `.md` file, confirm the editor renders and the Dock shows the
**pastel sticky-notes icon on a pale sticky-note yellow gradient** (not grey, and
not a dark background — dark/grey means you built a stale commit before the icon
refresh). Gatekeeper will warn because it's unsigned — right-click → Open.

Create the release and attach all five assets in one shot (substitute the real
filenames from `ls dist/`):

```bash
cd <repo root>
gh release create "v$VERSION" \
  --repo lhdharris/notation-app \
  --title "Notation v$VERSION" \
  --notes-file <(sed -n '1,/^---$/p' RELEASE_NOTES.md)   # the top (new) section only
  # ^ or pass --notes "..." directly; --latest is the default for the newest tag.
```

Then upload the built packages (do this as a second command so a wrong filename
doesn't block the release creation):

```bash
gh release upload "v$VERSION" \
  --repo lhdharris/notation-app \
  "electron-app/dist/Notation-$VERSION.dmg" \
  "electron-app/dist/Notation-$VERSION-arm64.dmg" \
  "electron-app/dist/Notation Setup $VERSION.exe" \
  "electron-app/dist/notation-app_${VERSION}_amd64.deb" \
  "electron-app/dist/notation-app-$VERSION.x86_64.rpm"
```

**Updater contract (important).** The in-app updater (`electron-app/updater.js`)
polls the GitHub *latest* release and downloads the asset whose **name** matches
this machine's platform/arch — `*-arm64.dmg` / `*.dmg` / `* Setup *.exe` /
`*_amd64.deb` / `*.x86_64.rpm`. So:
- The new release must be flagged **Latest** (it is by default for the newest
  semver tag) and must carry a correctly-named asset for **every** platform/arch,
  or some users get no update.
- It does **not** consume electron-builder's auto-update metadata, so do **not**
  upload the `latest*.yml` / `*.blockmap` files — only the bare installers above.

## 6. Verify

```bash
gh release view "v$VERSION" --repo lhdharris/notation-app
```

Confirm: tag `v$VERSION`, marked **Latest**, five assets (2 dmg, 1 exe, 1 deb,
1 rpm), and the notes render correctly. Existing installs on every platform will
see the update banner within ~4 hours (or on their next launch). Done.
