// ---- update checker -------------------------------------------------------
// Checks the GitHub "latest release" every 4 hours (and once on launch) and, if
// it's newer than the running version, tells every normal window so it can show
// the update banner. The builds are unsigned, so there is no silent in-place
// install: "Update" downloads the right installer for this platform/arch to the
// temp dir and opens it — finishing the install is the user's one click.
// Every network failure (offline, rate-limited, bad JSON) is silently dropped;
// the next cycle simply tries again. Dev runs (`npm start`) skip the checker.

const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const RELEASES_API = 'https://api.github.com/repos/lhdharris/notation-app/releases/latest';
const CHECK_INTERVAL_MS = 4 * 3600 * 1000;

let deps = null;           // { readConfig, writeConfig } from main.js
let pendingUpdate = null;  // { version, notes, asset, htmlUrl } when one is known
let downloading = null;    // in-flight download promise (single-flight)

const normalWindows = () => BrowserWindow.getAllWindows()
  .filter((w) => !w.isDestroyed() && !w._sticky && w.webContents && !w.webContents.isDestroyed());

// Numeric per-segment semver compare; returns >0 when a is newer than b.
function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// The release asset this machine should install, matched against the published
// names ("Notation-1.2.1-arm64.dmg", "Notation Setup 1.2.1.exe",
// "notation-app_1.2.1_amd64.deb", "notation-app-1.2.1.x86_64.rpm").
function pickAsset(assets) {
  const find = (re) => assets.find((a) => a && typeof a.name === 'string' && re.test(a.name));
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? find(/arm64\.dmg$/i)
      : assets.find((a) => a && /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
  }
  if (process.platform === 'win32') return find(/setup.*\.exe$/i) || find(/\.exe$/i);
  // Linux: prefer the package format the distro actually uses.
  let osRelease = '';
  try { osRelease = fs.readFileSync('/etc/os-release', 'utf8'); } catch {}
  const preferRpm = /(^|=|\s|")(rhel|fedora|centos|suse|opensuse)/i.test(osRelease);
  return preferRpm
    ? (find(/\.rpm$/i) || find(/\.deb$/i))
    : (find(/\.deb$/i) || find(/\.rpm$/i));
}

async function checkForUpdates() {
  let json;
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'notation-app' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    json = await res.json();
  } catch { return; }

  const version = String(json && json.tag_name || '').replace(/^v/i, '');
  if (!version || cmpSemver(version, app.getVersion()) <= 0) return;

  const cfg = deps.readConfig();
  cfg.update = { ...(cfg.update || {}), lastCheck: new Date().toISOString() };
  deps.writeConfig(cfg);
  if (cfg.update.skippedVersion === version) return;

  const assets = Array.isArray(json.assets) ? json.assets : [];
  pendingUpdate = {
    version,
    notes: String(json.body || '').slice(0, 2000),
    asset: pickAsset(assets) || null,
    htmlUrl: String(json.html_url || 'https://github.com/lhdharris/notation-app/releases'),
  };
  for (const w of normalWindows()) {
    w.webContents.send('update:available', {
      version,
      notes: pendingUpdate.notes,
      assetName: pendingUpdate.asset ? pendingUpdate.asset.name : null,
      htmlUrl: pendingUpdate.htmlUrl,
    });
  }
}

// Stream the installer to the temp dir, reporting progress to the requesting
// window, then open it. On Windows the NSIS installer needs the app closed, so
// quit shortly after handing off (before-quit persists the session); macOS and
// Linux installs proceed beside the running app — the renderer tells the user
// to quit Notation to finish.
async function downloadAndOpen(wc) {
  const { asset } = pendingUpdate;
  const dest = path.join(app.getPath('temp'), asset.name);
  const part = dest + '.part';
  const res = await net.fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'notation-app' },
  });
  if (!res.ok || !res.body) throw new Error('download failed (' + res.status + ')');
  const total = Number(asset.size) || 0;
  let received = 0;
  let lastSent = 0;
  const out = fs.createWriteStream(part);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise((resolve, reject) => out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())));
      const now = Date.now();
      if (total && now - lastSent > 200 && !wc.isDestroyed()) {
        lastSent = now;
        wc.send('update:progress', { percent: Math.round((received / total) * 100) });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(part, dest);
  } catch (err) {
    out.destroy();
    fs.rm(part, { force: true }, () => {});
    throw err;
  }
  if (!wc.isDestroyed()) wc.send('update:progress', { percent: 100 });
  const openErr = await shell.openPath(dest);
  if (openErr) throw new Error(openErr);
  if (process.platform === 'win32') setTimeout(() => app.quit(), 800);
  return { ok: true, action: 'opened' };
}

function initUpdater(mainDeps) {
  deps = mainDeps;
  if (!app.isPackaged) return; // no update nagging during development

  ipcMain.handle('update:download', async (e) => {
    if (!pendingUpdate) return { error: 'no-update' };
    if (!pendingUpdate.asset) return { error: 'no-asset' };
    if (!downloading) {
      downloading = downloadAndOpen(e.sender)
        .catch((err) => ({ error: (err && err.message) || String(err) }))
        .finally(() => { downloading = null; });
    }
    return downloading;
  });

  ipcMain.on('update:skip', (_e, version) => {
    if (typeof version !== 'string' || !version) return;
    const cfg = deps.readConfig();
    cfg.update = { ...(cfg.update || {}), skippedVersion: version };
    deps.writeConfig(cfg);
    pendingUpdate = null;
    for (const w of normalWindows()) w.webContents.send('update:dismissed');
  });

  checkForUpdates();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

module.exports = { initUpdater };
