const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { initUpdater } = require('./updater');

// ---- native Wayland -----------------------------------------------------
// Run as a native Wayland client on Wayland sessions (no-op on X11 / Windows /
// macOS). A frameless window under XWayland doesn't hand its title-bar drag
// (-webkit-app-region: drag) to the compositor as an interactive move, so
// GNOME/KDE never offer edge-tiling; as a native Wayland client the move is
// compositor-managed, restoring drag-to-edge half-tiling and drag-to-top
// maximize. Must run before app ready. (Pattern from res/projector-app.)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

// ---- dev isolation ------------------------------------------------------
// Running unpackaged (`npm start`) gets a separate identity + userData dir from
// any installed build, so a dev run keeps its own config.json and single-
// instance lock and never clobbers the real workspace list.
if (!app.isPackaged) {
  app.setName('notation-app-dev');
  app.setPath('userData', path.join(app.getPath('appData'), 'notation-app-dev'));
}

// Window / taskbar icon (packaged as assets/icon.png; the Linux desktop entry
// icon is generated separately from build/icons by electron-builder).
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

// ---- config -------------------------------------------------------------
// Workspaces are the folders the user has linked into the side panel, stored as
// absolute paths. stickyNotes maps a file path -> the post-it note text the
// user typed while that file was stickied.
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2));
  } catch {}
}

function workspaces() {
  const cfg = readConfig();
  return Array.isArray(cfg.workspaces) ? cfg.workspaces : [];
}

function setWorkspaces(list) {
  const cfg = readConfig();
  cfg.workspaces = list;
  writeConfig(cfg);
}

// ---- filesystem sandbox -------------------------------------------------
// The renderer can only touch paths that live inside (or are) a linked
// workspace. Every fs IPC handler resolves its argument through this guard so
// a compromised/buggy renderer can't read or write arbitrary disk. Returns the
// resolved absolute path, or null if it escapes every workspace root.
function withinWorkspace(target) {
  if (typeof target !== 'string' || !target) return null;
  const resolved = path.resolve(target);
  for (const ws of workspaces()) {
    const root = path.resolve(ws);
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  return null;
}

// Files the user explicitly opened from outside any workspace (OS "Open with" /
// file-association launches, pinned notes whose workspace was unlinked). The
// tab-level fs handlers (read/write/watch/trash/reveal) accept these too; tree
// and directory operations stay workspace-only, so the renderer still can't
// roam the disk — only the exact files the user opened.
const externalPaths = new Set();

function allowExternal(p) {
  if (typeof p !== 'string' || !p) return null;
  const resolved = path.resolve(p);
  if (!withinWorkspace(resolved)) externalPaths.add(resolved);
  return resolved;
}

function withinWorkspaceOrExternal(target) {
  const ws = withinWorkspace(target);
  if (ws) return ws;
  if (typeof target !== 'string' || !target) return null;
  const resolved = path.resolve(target);
  return externalPaths.has(resolved) ? resolved : null;
}

// ---- OS-opened files ------------------------------------------------------
// macOS delivers a Finder/file-association open as an 'open-file' event, which
// can fire before app ready — queue those and drain once the session is
// restored. Windows/Linux pass the path on argv (first launch) or through the
// 'second-instance' handler.
const pendingOpenPaths = [];
let appReadyAndRestored = false;
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (appReadyAndRestored) openPathInApp(p);
  else pendingOpenPaths.push(p);
});

// A real file named on a launch / second-instance command line, or null. Skips
// the executable (plus the app-dir argument of an unpackaged run) and switches.
function extractFileArg(argv, cwd) {
  const args = Array.isArray(argv) ? argv.slice(app.isPackaged ? 1 : 2) : [];
  for (const a of args) {
    if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// Open an OS-provided file path as a tab in an existing normal window, or in a
// fresh window when only stickies (or nothing) are open.
function openPathInApp(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return;
  let p = path.resolve(rawPath);
  try { p = fs.realpathSync(p); } catch {}
  try { if (!fs.statSync(p).isFile()) return; } catch { return; }
  allowExternal(p);
  const win = getTargetNormalWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // A first-launch file arg lands right after restoreSessionOrCreate, while
    // the restored window is still loading — sending then would drop the
    // message before the renderer has subscribed.
    const send = () => { if (!win.isDestroyed()) win.webContents.send('tab:openPath', { path: p }); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  } else {
    createWindow(p);
  }
}

// True if `child` is `parent` itself or lives inside its subtree. Used by the
// move/copy handlers to refuse dropping a folder into itself or a descendant.
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Next free "<stem> copy<ext>" (then " copy 2", " copy 3"…) beside `src`, for
// the Duplicate action. Folders get no extension split so "a.b" stays whole.
function uniqueCopyName(src) {
  const dir = path.dirname(src);
  const base = path.basename(src);
  const ext = fs.statSync(src).isDirectory() ? '' : path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let cand = path.join(dir, `${stem} copy${ext}`);
  for (let n = 2; fs.existsSync(cand); n++) cand = path.join(dir, `${stem} copy ${n}${ext}`);
  return cand;
}

// ---- window -------------------------------------------------------------
// `initialFile` (optional) opens that file as the window's first tab — used by
// the tab "detach to new window" / "open in new window" flows. `opts.x/y`
// position the new window (detach drops it near the cursor). `opts.restore` is a
// saved session descriptor (see "session persistence") that recreates a window
// with its previous geometry, tabs and — for a post-it — its sticky state. The
// window is `transparent` so sticky-mode rounded corners show through (style.css).
function createWindow(initialFile, opts = {}) {
  const file = initialFile ? withinWorkspaceOrExternal(initialFile) : null;
  const restore = opts.restore || null;
  const stickyRestore = restore && restore.sticky ? restore.sticky : null;

  // Geometry: a restored window uses its saved bounds (the sticky size for a
  // post-it); a detach drop uses opts.x/y; otherwise the default 1100x740.
  let bounds = { width: 1100, height: 740 };
  let { x, y } = opts;
  const savedBounds = stickyRestore ? stickyRestore.stickyBounds : (restore ? restore.bounds : null);
  if (savedBounds && Number.isFinite(savedBounds.width) && Number.isFinite(savedBounds.height)) {
    bounds = clampToDisplay({
      x: Math.round(savedBounds.x), y: Math.round(savedBounds.y),
      width: Math.round(savedBounds.width), height: Math.round(savedBounds.height),
    });
    x = bounds.x; y = bounds.y;
  } else if (x !== undefined && y !== undefined) {
    const b = clampToDisplay({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height });
    x = b.x; y = b.y;
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    icon: APP_ICON,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    // A restored post-it must start below the normal 640x480 floor.
    minWidth: stickyRestore ? STICKY_MIN_W : 640,
    minHeight: stickyRestore ? STICKY_MIN_H : 480,
    frame: false,
    transparent: true,
    // The OS window can be transparent (sticky rounded corners show through),
    // but only a born-sticky starts that way: a normal editor window paints
    // white so loading / resizing never flashes the transparent base (which
    // renders as black garbage on Wayland). Stickify/restore toggle this.
    backgroundColor: stickyRestore ? '#00000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (restore) win._restore = restore;

  // Re-establish sticky state for a restored post-it (lazy: no shrink animation —
  // the window is already sticky-sized; the renderer just adds .sticky-mode).
  if (stickyRestore) {
    win._sticky = {
      originalBounds: stickyRestore.originalBounds || null,
      stickyBounds: bounds,
      wasMaximized: !!stickyRestore.wasMaximized,
    };
    relaxStickySize(win);
    pinStickyOnTop(win);
  } else if (restore && restore.maximized) {
    win.maximize();
  }

  const baseUrl = 'file://' + path.join(__dirname, 'renderer', 'index.html');
  const hash = file ? '#file=' + encodeURIComponent(file) : '';
  win.loadURL(baseUrl + hash);
  installContextMenu(win);

  // A sticky may be maximized by the WM's title-bar dblclick gesture — let it
  // happen (fighting it with unmaximize/setBounds crashed the compositor round
  // trip). Keep the float asserted and tell the renderer so it can square the
  // post-it's rounded corners while maximized. Dblclick again unmaximizes and
  // the WM restores the pre-maximize (post-it) bounds itself.
  const sendStickyMaxState = (on) => {
    pinStickyOnTop(win);
    if (!win.isDestroyed()) win.webContents.send('sticky-max-state', on);
  };
  win.on('maximize', () => {
    if (!win._sticky) return;
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // On mac/win the system swallows a dblclick on the drag-region title strip
      // and zooms/maximizes the window itself (the DOM never sees the dblclick).
      // Treat that gesture as "restore to a normal window": the renderer runs
      // the shared grow-then-fade exit (wm-sticky-restore unmaximizes first).
      if (!win.isDestroyed()) win.webContents.send('sticky:restore-request');
      return;
    }
    sendStickyMaxState(true); // Linux: tolerate the WM maximize as before
  });
  win.on('unmaximize', () => { if (win._sticky) sendStickyMaxState(false); });

  // Keep the persisted session current as the window moves/resizes, and update a
  // sticky's remembered post-it size when the user drags it. The _animating flag
  // skips the programmatic shrink/restore ticks.
  const onGeometryChange = () => {
    if (win.isDestroyed() || win._animating) return;
    // Skip while maximized: a dblclick-maximized sticky fires 'resize' with
    // full-screen bounds, which must not overwrite the remembered post-it size
    // (unmaximize relies on it to bring the post-it footprint back).
    if (win._sticky && !win.isMaximized()) win._sticky.stickyBounds = win.getBounds();
    persistSessionSoon();
  };
  win.on('move', onGeometryChange);
  win.on('resize', onGeometryChange);
  win.on('focus', () => { if (!win._sticky) lastFocusedNormalId = win.id; });
  win.on('close', () => onWindowClose(win));
  win.on('closed', () => broadcastWindowCount());
  broadcastWindowCount(); // a new window appeared: existing windows can now "Gather"
  return win;
}

// A right-click clipboard menu. Electron ships no default context menu, and the
// frameless window has no menu bar, so without this there's no mouse-driven
// copy/paste in the editor. Built from the click context. (From res/projector-app.)
function installContextMenu(win) {
  win.webContents.on('context-menu', (_e, params) => {
    const { isEditable, editFlags } = params;
    const hasSelection = !!(params.selectionText && params.selectionText.trim());
    const template = [];
    if (isEditable) {
      template.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
      );
    }
    if (isEditable || hasSelection) {
      template.push({ role: 'copy', enabled: editFlags.canCopy || hasSelection });
    }
    if (isEditable) {
      template.push({ role: 'paste', enabled: editFlags.canPaste });
    }
    if (isEditable || hasSelection) {
      template.push({ type: 'separator' }, { role: 'selectAll' });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

// ---- sticky-note window control -----------------------------------------
// The third window button (the folded-corner "stickify" icon) shrinks the whole
// BrowserWindow into a small always-on-top desktop post-it. The renderer keeps
// the editor content alive (just display:none'd) so restoring is a pure OS
// resize, not a reload. Mechanics mirror res/tabless-browser's sticky-note flow,
// simplified: no cross-restart persistence, no lazy restore, no per-window hue.
const STICKY_W = 320;
const STICKY_H = 240;
// A sticky stays resizable (by request), so instead of locking its size we just
// give it a small floor so it can't be shrunk into nothing.
const STICKY_MIN_W = 180;
const STICKY_MIN_H = 130;
const STICKY_ANIM_MS = 240;
const ANIM_TICK_MS = 30;

// Animated bounds change. JS-driven setBounds ticks at ~33fps with easeOutCubic.
// 30ms (not 16ms) because each setBounds triggers a full Wayland configure →
// repaint, and tighter ticks queue faster than the compositor can drain → chop.
// Resolves when the animation completes so the renderer can sequence post-shrink
// work (focusing the note). The _animating flag lets move-tracking ignore the
// programmatic ticks.
function animateBounds(win, target, ms, startOverride) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve();
    win._animating = true;
    // Normally the live bounds are the start. A dblclick-triggered sticky restore
    // arrives mid-maximize (the WM briefly grows the window full-screen before we
    // unmaximize), so reading getBounds() there would animate full-screen → target
    // and visibly shrink down (#3). Snap to the known post-it size first instead —
    // inside the _animating guard so the geometry handler ignores the snap.
    let start = win.getBounds();
    if (startOverride) { start = startOverride; win.setBounds(startOverride); }
    const t0 = Date.now();
    const done = () => {
      resolve();
      setTimeout(() => { if (!win.isDestroyed()) win._animating = false; }, 200);
    };
    const tick = () => {
      if (win.isDestroyed()) return done();
      const t = Math.min(1, (Date.now() - t0) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      win.setBounds({
        x:      Math.round(start.x      + (target.x      - start.x)      * eased),
        y:      Math.round(start.y      + (target.y      - start.y)      * eased),
        width:  Math.round(start.width  + (target.width  - start.width)  * eased),
        height: Math.round(start.height + (target.height - start.height) * eased),
      });
      if (t < 1) setTimeout(tick, ANIM_TICK_MS);
      else done();
    };
    tick();
  });
}

// Float above other windows, on the current workspace only (a desktop post-it
// lives where you left it, not on every virtual desktop).
function pinStickyOnTop(win) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'floating');
  try { win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true }); } catch {}
}

function unpinStickyOnTop(win) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  try { win.setVisibleOnAllWorkspaces(false); } catch {}
}

// A sticky's resting size constraints: a small floor so it can't be shrunk into
// nothing, no ceiling — so the WM's title-bar dblclick-maximize gesture works
// like on any normal window. We never toggle setResizable (avoids Electron's
// Linux save/restore-min/max trap), so programmatic setSize/setBounds still works.
function relaxStickySize(win) {
  if (win.isDestroyed()) return;
  win.setMinimumSize(STICKY_MIN_W, STICKY_MIN_H);
  win.setMaximumSize(0, 0);
}

function unlockStickySize(win) {
  if (win.isDestroyed()) return;
  win.setResizable(true);
  win.setMinimumSize(0, 0);
  win.setMaximumSize(0, 0);
}

// Pull a rect into the nearest display's work area so the sticky is always
// fully on-screen and clickable.
function clampToDisplay(bounds) {
  const work = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, work.width);
  const height = Math.min(bounds.height, work.height);
  return {
    x: Math.max(work.x, Math.min(work.x + work.width - width, bounds.x)),
    y: Math.max(work.y, Math.min(work.y + work.height - height, bounds.y)),
    width,
    height,
  };
}

// ---- window-control IPC -------------------------------------------------
ipcMain.on('wm-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

ipcMain.on('wm-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win._sticky) return; // a stickied window can't be maximized
  win.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.handle('wm-sticky-shrink', async (e, size) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win._sticky) return;
  const wasMaximized = win.isMaximized();
  if (wasMaximized) win.unmaximize();
  const cur = win.getBounds();
  win._sticky = { originalBounds: cur, stickyBounds: null, wasMaximized };
  broadcastWindowCount(); // normal-window count changed (this one is a sticky now)
  // Use the note's remembered post-it size when the renderer passed one (#7), else default.
  const w = size && Number.isFinite(size.w) ? size.w : STICKY_W;
  const h = size && Number.isFinite(size.h) ? size.h : STICKY_H;
  const target = clampToDisplay({ x: cur.x, y: cur.y, width: w, height: h });
  // Drop the window's normal 640x480 minimum BEFORE animating. That floor (set
  // at creation) otherwise clamps the very first shrink partway — the minimum
  // only got lowered after the first restore (via unlockStickySize), which is
  // why the first stickify used to stall on the way down.
  win.setResizable(true); win.setMinimumSize(0, 0); win.setMaximumSize(0, 0);
  // Go transparent for the post-it: the renderer is already in sticky-mode, so
  // the rounded corners must show through (the normal editor paints white).
  win.setBackgroundColor('#00000000');
  pinStickyOnTop(win);
  await animateBounds(win, target, STICKY_ANIM_MS);
  const sb = win.getBounds();
  relaxStickySize(win); // sticky floor, no ceiling — dblclick-maximize stays available
  win._sticky.stickyBounds = sb;
  persistSessionSoon();
  pinStickyOnTop(win); // re-assert: some Wayland compositors drop the level on resize
});

// Resize a post-it from the renderer's corner grip. `w`/`h` are an absolute
// target the grip accumulated from relative pointer deltas (movementX/Y — the
// only reliable signal on Wayland). Clamp to the sticky floor; top-left stays
// anchored so the note grows toward the grip. The existing 'resize' handler
// (onGeometryChange) then updates stickyBounds + persists.
ipcMain.on('wm-sticky-resize', (e, { w, h } = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !win._sticky) return;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  win.setSize(
    Math.max(STICKY_MIN_W, Math.round(w)),
    Math.max(STICKY_MIN_H, Math.round(h)),
  );
});

// Grip resize start/end. On start we paint the window the note colour so the
// area the post-it grows into shows cream, not the transparent-black base flashing
// through before the renderer reflows. On end we restore full transparency so the
// resting note keeps clean rounded corners, and remember the new footprint.
// The renderer's chosen post-it colour, stored so the grip-resize fill below paints
// the newly-exposed area in it instead of the default cream (#6).
ipcMain.on('wm-sticky-color', (e, { hex } = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(hex)) win._stickyColor = hex;
});

ipcMain.on('wm-sticky-resize-begin', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !win._sticky) return;
  win.setBackgroundColor(win._stickyColor || '#FFFDEB');
});

ipcMain.on('wm-sticky-resize-end', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !win._sticky) return;
  const sb = win.getBounds();
  win.setBackgroundColor('#00000000');
  win._sticky.stickyBounds = sb;
  persistSessionSoon();
});

ipcMain.handle('wm-sticky-restore', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !win._sticky) return;
  const { originalBounds, wasMaximized, stickyBounds } = win._sticky;
  win._sticky = null;
  broadcastWindowCount(); // normal-window count changed (sticky became an editor again)
  unlockStickySize(win);
  unpinStickyOnTop(win);
  // Back to the opaque editor: paint white BEFORE the grow so the area the
  // window expands into shows white, not the transparent base flashing black
  // on every animation tick (the renderer reflows a beat behind setBounds).
  win.setBackgroundColor('#ffffff');
  if (wasMaximized) {
    win.maximize();
  } else if (originalBounds) {
    // The sticky itself may be dblclick-maximized right now — leave that state
    // first (setBounds on a maximized Wayland window misbehaves), then grow from
    // the post-it footprint, not the live (maybe full-screen) bounds (#3).
    if (win.isMaximized()) win.unmaximize();
    await animateBounds(win, originalBounds, STICKY_ANIM_MS, stickyBounds);
  }
  persistSessionSoon();
});

// ---- external links -----------------------------------------------------
// Rendered markdown links round-trip through here so http(s)/mailto opens in
// the OS default app instead of navigating the renderer away from the editor.
ipcMain.handle('shell:openExternal', (_e, link) => {
  if (typeof link === 'string' && /^(https?:|mailto:)/i.test(link)) shell.openExternal(link);
  return { ok: true };
});

// Write plain text to the system clipboard — backs the editor's cut/copy-line
// shortcuts (Ctrl+X / Ctrl+C with no selection) so they don't depend on the
// renderer's async Clipboard API permission.
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text == null ? '' : text)));

// Cheap binary sniff (a NUL byte in the first 8 KB), matching fs:readFile's
// rule, but reading only the head so a clicked link to a huge file is fast.
function looksBinary(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  }
}

// A clicked markdown link. Classify it so the renderer knows what to do:
//   http(s)/mailto      → open in the OS default app           → {kind:'external'}
//   in-workspace text   → renderer opens it as a notation tab  → {kind:'open', path}
//   other file / dir    → reveal/open in the OS file manager   → {kind:'revealed'}
//   unresolvable/missing → renderer flashes a note             → {kind:'missing'}
// Relative paths resolve against the folder of the note that was clicked from.
ipcMain.handle('link:open', (_e, { href, fromPath } = {}) => {
  if (typeof href !== 'string' || !href) return { kind: 'missing' };
  if (/^(https?:|mailto:)/i.test(href)) { shell.openExternal(href); return { kind: 'external' }; }

  // Resolve to an absolute filesystem path.
  let target;
  if (/^file:\/\//i.test(href)) {
    try { target = url.fileURLToPath(href); } catch { return { kind: 'missing' }; }
  } else {
    target = href.replace(/[?#].*$/, '');           // drop any query/fragment
    try { target = decodeURIComponent(target); } catch {}
    if (!path.isAbsolute(target)) {
      const base = typeof fromPath === 'string' && fromPath ? path.dirname(fromPath) : null;
      if (!base) return { kind: 'missing' };
      target = path.resolve(base, target);
    }
  }

  let stat;
  try { stat = fs.statSync(target); } catch { return { kind: 'missing' }; }
  if (stat.isDirectory()) { shell.openPath(target); return { kind: 'revealed' }; }

  // A file Notation can handle = inside a linked workspace and not binary;
  // everything else (out-of-workspace, binary) goes to the file manager.
  const inWs = withinWorkspace(target);
  if (inWs && !looksBinary(inWs)) return { kind: 'open', path: inWs };
  shell.showItemInFolder(target);
  return { kind: 'revealed' };
});

// ---- tab reorder + cross-window drag (HTML5 drag-and-drop) --------------
// Reordering happens in-renderer. Moving a tab to another window relies on the
// browser auto-promoting an HTML5 drag to an OS drag once it leaves the source
// window, so the compositor delivers drag/drop DOM events to whatever window is
// under the pointer — the only cross-window scheme that works on Wayland, where
// global cursor/window coords aren't exposed to the app. We don't transfer the
// payload through the drag itself: main just broadcasts which path is in flight
// so every window's drop targets accept it and know what to adopt; the source
// decides the outcome from which window (if any) reported adopting it.
const liveWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

// The window an OS-level open/activation should land in: the focused normal
// (non-sticky) window, else the last-focused normal one, else any normal one.
let lastFocusedNormalId = null;
function getTargetNormalWindow() {
  const normals = liveWindows().filter((w) => !w._sticky);
  return normals.find((w) => w.isFocused())
      || normals.find((w) => w.id === lastFocusedNormalId)
      || normals[0] || null;
}

// Second launches / dock clicks land here: surface a normal editor window. With
// only stickies open (they're already on top and shouldn't be hijacked), open a
// fresh editor instead.
function focusOrCreateNormalWindow() {
  const win = getTargetNormalWindow();
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

// Tell every window how many windows are open now: total, and how many are
// normal (non-sticky) editor windows. The renderer greys out the tab menu's
// gather items when there is nothing to gather — "Gather all windows" needs a
// second normal window, "…and stickies" any second window. Fired on every
// open/close; a fresh window also fetches the counts itself on boot.
function windowCounts() {
  const wins = liveWindows();
  return { total: wins.length, normal: wins.filter((w) => !w._sticky).length };
}
function broadcastWindowCount() {
  const counts = windowCounts();
  for (const w of liveWindows()) {
    if (w.webContents && !w.webContents.isDestroyed()) w.webContents.send('wm-window-count', counts);
  }
}
ipcMain.handle('wm-window-count', () => windowCounts());

let osTabDrag = null; // { sourceId, path }

const broadcastDrag = (active, p) => {
  for (const w of liveWindows()) w.webContents.send('tab-drag-active', { active, path: p || null });
};

function stopTabDrag() {
  if (!osTabDrag) return;
  osTabDrag = null;
  broadcastDrag(false, null);
}

// Open a path in a brand-new window (context menu + drag-to-empty-space).
ipcMain.on('tab-open-new-window', (_e, p) => { createWindow(p); });

// Open a path directly as a desktop post-it ("Move to sticky note"). Reuses the
// session-restore sticky path: a restore descriptor with .sticky makes
// createWindow build the window already small/pinned, and the renderer's boot()
// adds the sticky-mode chrome (colour/size prefs come from the shared
// localStorage, keyed by file path).
ipcMain.on('tab-open-sticky', (e, payload) => {
  const { path: p, size } = payload || {};
  const file = withinWorkspaceOrExternal(p);
  if (!file) return;
  const src = BrowserWindow.fromWebContents(e.sender);
  const sb = src && !src.isDestroyed() ? src.getBounds() : null;
  // Where a later "restore" un-shrinks to: the source window's footprint —
  // unless the source is maximized (its bounds fill the screen), then a
  // default-size window offset on the same display.
  const originalBounds = sb
    ? (src.isMaximized()
        ? clampToDisplay({ x: sb.x + 60, y: sb.y + 60, width: 1100, height: 740 })
        : sb)
    : null;
  const w = size && Number.isFinite(size.width) ? Math.round(size.width) : STICKY_W;
  const h = size && Number.isFinite(size.height) ? Math.round(size.height) : STICKY_H;
  const stickyBounds = clampToDisplay({
    x: (sb ? sb.x : 80) + 60, y: (sb ? sb.y : 80) + 60, width: w, height: h,
  });
  createWindow(null, { restore: {
    tabs: [file], activeIndex: 0,
    sticky: { originalBounds, stickyBounds, wasMaximized: false },
  } });
});

// A tab drag started: tell every window a drag is live so their drop targets
// accept it and know which file would be adopted.
ipcMain.on('tab-os-drag-start', (e, { path: p }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  osTabDrag = { sourceId: win.id, path: p };
  broadcastDrag(true, p);
});

ipcMain.on('tab-os-drag-end', () => stopTabDrag());

// Another window adopted the dragged file: tell the source window so it removes
// its now-moved tab, then end the drag session.
ipcMain.on('tab-drag-adopted', () => {
  if (!osTabDrag) return;
  const src = BrowserWindow.fromId(osTabDrag.sourceId);
  if (src && !src.isDestroyed()) src.webContents.send('tab-drag-consumed', {});
  stopTabDrag();
});

// ---- gather windows (with or without stickies) -----------------------------
// "Bring everything back into one window": every OTHER window — sticky notes
// included unless the renderer asked to spare them — saves its dirty tabs and
// hands main its ordered file paths; main returns the merged list to the
// requesting window (which opens them) and closes the now-drained sources.
let collectSeq = 0;
function collectTabsFromWindow(win) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve([]);
    const token = ++collectSeq;
    const reply = (_e, payload) => {
      if (!payload || payload.token !== token) return;
      ipcMain.removeListener('tabs:collected', reply);
      clearTimeout(timer);
      resolve(Array.isArray(payload.paths) ? payload.paths : []);
    };
    // If the window never answers (rare), fall back to its last reported session
    // so the gather still pulls its tabs in rather than silently dropping them.
    const timer = setTimeout(() => {
      ipcMain.removeListener('tabs:collected', reply);
      const st = sessionState.get(win.id);
      resolve(st && Array.isArray(st.tabs) ? st.tabs.filter(Boolean) : []);
    }, 4000);
    ipcMain.on('tabs:collected', reply);
    win.webContents.send('tabs:collect', { token });
  });
}

// Every file path currently open in a floating post-it (a sticky may hold more
// than one tab). Used so "Gather all windows" never pulls a stickied file in.
function stickyOpenPaths() {
  const set = new Set();
  for (const w of liveWindows()) {
    if (!w._sticky) continue;
    const st = sessionState.get(w.id);
    const t = st && Array.isArray(st.tabs) ? st.tabs
      : (w._restore && Array.isArray(w._restore.tabs) ? w._restore.tabs : []);
    for (const p of t) if (p) set.add(path.resolve(p));
  }
  return set;
}

ipcMain.handle('tabs:gather', async (e, opts) => {
  const target = BrowserWindow.fromWebContents(e.sender);
  if (!target) return [];
  // "Gather all windows" (includeStickies false) leaves post-its floating.
  const includeStickies = !opts || opts.includeStickies !== false;
  // A file that is currently a floating sticky belongs to that note: when sparing
  // post-its, never pull it in as a tab — even if a gathered window also had it
  // open. Absorbing stickied files is reserved for "gather windows and stickies".
  const spared = includeStickies ? null : stickyOpenPaths();
  const sources = liveWindows().filter((w) => w.id !== target.id && (includeStickies || !w._sticky));
  const gathered = [];
  for (const w of sources) {
    const paths = await collectTabsFromWindow(w);
    for (const p of paths) if (p && !(spared && spared.has(path.resolve(p)))) gathered.push(p);
  }
  for (const w of sources) {
    if (w.isDestroyed()) continue;
    sessionState.delete(w.id);
    w.destroy();
  }
  broadcastWindowCount();
  persistSessionSoon();
  return gathered;
});

// ---- session persistence ------------------------------------------------
// "Reopen as if I never left": every window's geometry + tabs are saved to
// config.json and rebuilt on next launch. Main owns window geometry + sticky
// state; the renderer reports its tab list + chrome via `session:update`. The
// two are merged into a descriptor per window. (Model from res/tabless-browser,
// simplified for tabs.)
const sessionState = new Map(); // win.id -> { tabs:[paths], activeIndex, sidebarCollapsed }
let persistTimer = null;
let quitting = false;

function persistSessionSoon(delay = 500) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistSession(); }, delay);
}

// Build the saved shape for one window, or null if it has nothing worth
// restoring (no tabs). A post-it stores both its expanded `bounds` (where it
// returns on restore) and its `stickyBounds` (the post-it size).
function windowDescriptor(win) {
  if (win.isDestroyed()) return null;
  const reported = sessionState.get(win.id);
  const allTabs = reported && Array.isArray(reported.tabs) ? reported.tabs : [];
  const allPinned = reported && Array.isArray(reported.pinned) ? reported.pinned : [];
  // Filter empties while keeping each tab's pin flag aligned with its path.
  const tabs = [], pinned = [];
  allTabs.forEach((p, i) => { if (p) { tabs.push(p); pinned.push(!!allPinned[i]); } });
  if (!tabs.length) return null;
  const sticky = win._sticky
    ? {
        originalBounds: win._sticky.originalBounds || null,
        stickyBounds: win._sticky.stickyBounds || win.getBounds(),
        wasMaximized: !!win._sticky.wasMaximized,
      }
    : null;
  return {
    bounds: win._sticky ? (win._sticky.originalBounds || win.getBounds()) : win.getBounds(),
    maximized: win.isMaximized(),
    sticky,
    sidebarCollapsed: !!(reported && reported.sidebarCollapsed),
    tabs,
    pinned,
    activeIndex: reported && Number.isInteger(reported.activeIndex) ? reported.activeIndex : 0,
  };
}

// Snapshot every live window. The empty-guard is the key invariant: we NEVER
// overwrite a good session with nothing, so closing the last window (which
// quits the app on Linux) leaves the previously-saved layout intact to restore.
function persistSession() {
  const windows = [];
  for (const win of liveWindows()) {
    const d = windowDescriptor(win);
    if (d) windows.push(d);
  }
  if (!windows.length) return;
  const cfg = readConfig();
  cfg.session = { windows };
  writeConfig(cfg);
}

// A window is closing (event fires while it's still alive, so getBounds works).
// If others remain, drop this one and re-save the rest. If it's the last window,
// keep it in the snapshot so its final layout is what relaunch restores.
function onWindowClose(win) {
  if (quitting) return; // before-quit already snapshotted the full live set
  const others = liveWindows().filter((w) => w.id !== win.id && !w.isDestroyed());
  if (others.length) {
    sessionState.delete(win.id);
    persistSession();
  } else {
    persistSession(); // still includes win (not yet destroyed) → captured
  }
}

// Renderer → main: this window's current tabs + chrome state.
ipcMain.on('session:update', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  sessionState.set(win.id, {
    tabs: Array.isArray(payload && payload.tabs) ? payload.tabs : [],
    pinned: Array.isArray(payload && payload.pinned) ? payload.pinned.map(Boolean) : [],
    activeIndex: payload && Number.isInteger(payload.activeIndex) ? payload.activeIndex : 0,
    sidebarCollapsed: !!(payload && payload.sidebarCollapsed),
  });
  persistSessionSoon();
});

// Renderer ← main, on boot: the descriptor this window should rebuild from.
ipcMain.handle('session:getRestore', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && win._restore ? win._restore : null;
});

// ---- workspaces IPC -----------------------------------------------------
ipcMain.handle('workspaces:list', () =>
  workspaces().map((p) => ({ name: path.basename(p), path: path.resolve(p) }))
);

// Link an existing folder on disk as a workspace via the native folder picker.
ipcMain.handle('workspaces:add', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a workspace folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const chosen = path.resolve(res.filePaths[0]);
  const list = workspaces().slice();
  if (!list.some((p) => path.resolve(p) === chosen)) {
    list.push(chosen);
    setWorkspaces(list);
    syncWorkspaceWatchers();
  }
  return { name: path.basename(chosen), path: chosen };
});

// Remove a workspace from the panel — leaves the files on disk untouched.
ipcMain.handle('workspaces:remove', (_e, dirPath) => {
  const target = path.resolve(dirPath);
  setWorkspaces(workspaces().filter((p) => path.resolve(p) !== target));
  syncWorkspaceWatchers();
  return true;
});

// ---- filesystem IPC (all sandboxed to workspace roots) ------------------

// List a directory's children — directories first, then files, each alphabetical
// (case-insensitive). Powers the side-panel tree's lazy expansion. Hidden entries
// (dotfiles/folders like .git, .obsidian) are filtered out to match the filesystem.
ipcMain.handle('fs:readDir', (_e, dirPath) => {
  const dir = withinWorkspace(dirPath);
  if (!dir) return { error: 'outside-workspace' };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { error: err.code || 'read-failed' };
  }
  const items = entries
    .filter((ent) => !ent.name.startsWith('.')) // hide hidden dotfiles/folders
    .map((ent) => {
      // Resolve symlinks to learn whether they point at a directory.
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try { isDir = fs.statSync(path.join(dir, ent.name)).isDirectory(); } catch { isDir = false; }
      }
      return { name: ent.name, path: path.join(dir, ent.name), isDir };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  return { items };
});

ipcMain.handle('fs:readFile', (_e, filePath) => {
  const file = withinWorkspaceOrExternal(filePath);
  if (!file) return { error: 'outside-workspace' };
  try {
    const buf = fs.readFileSync(file);
    // Reject obviously-binary files (a NUL byte in the first 8KB) so the editor
    // doesn't load garbage. Everything else is treated as UTF-8 text.
    const slice = buf.subarray(0, 8192);
    if (slice.includes(0)) return { error: 'binary' };
    return { content: buf.toString('utf8') };
  } catch (err) {
    return { error: err.code || 'read-failed' };
  }
});

ipcMain.handle('fs:writeFile', (_e, filePath, content) => {
  const file = withinWorkspaceOrExternal(filePath);
  if (!file) return { error: 'outside-workspace' };
  try {
    const text = typeof content === 'string' ? content : '';
    fs.writeFileSync(file, text, 'utf8');
    // Remember what we just wrote so the watcher recognises the resulting change
    // event as ours and doesn't bounce it back as an "external" edit (#external-watch).
    if (openFiles.has(file)) appWrites.set(file, text);
    return { ok: true };
  } catch (err) {
    return { error: err.code || 'write-failed' };
  }
});

ipcMain.handle('fs:createFile', (_e, dirPath, name) => {
  const dir = withinWorkspace(dirPath);
  if (!dir) return { error: 'outside-workspace' };
  const target = withinWorkspace(path.join(dir, name));
  if (!target) return { error: 'invalid-name' };
  try {
    if (fs.existsSync(target)) return { error: 'exists' };
    fs.writeFileSync(target, '', 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { error: err.code || 'create-failed' };
  }
});

ipcMain.handle('fs:createFolder', (_e, dirPath, name) => {
  const dir = withinWorkspace(dirPath);
  if (!dir) return { error: 'outside-workspace' };
  const target = withinWorkspace(path.join(dir, name));
  if (!target) return { error: 'invalid-name' };
  try {
    if (fs.existsSync(target)) return { error: 'exists' };
    fs.mkdirSync(target);
    return { ok: true, path: target };
  } catch (err) {
    return { error: err.code || 'create-failed' };
  }
});

ipcMain.handle('fs:rename', (_e, oldPath, newName) => {
  const src = withinWorkspace(oldPath);
  if (!src) return { error: 'outside-workspace' };
  if (typeof newName !== 'string' || !newName || newName.includes('/') || newName.includes('\\')) {
    return { error: 'invalid-name' };
  }
  const dest = withinWorkspace(path.join(path.dirname(src), newName));
  if (!dest) return { error: 'invalid-name' };
  try {
    if (fs.existsSync(dest)) return { error: 'exists' };
    fs.renameSync(src, dest);
    return { ok: true, path: dest };
  } catch (err) {
    return { error: err.code || 'rename-failed' };
  }
});

// Move a file/folder INTO another directory, keeping its basename (drag-and-drop
// and "Move to…"). Refuses a no-op (already there) and folder-into-itself.
ipcMain.handle('fs:move', (_e, srcPath, destDir) => {
  const src = withinWorkspace(srcPath);
  const dir = withinWorkspace(destDir);
  if (!src || !dir) return { error: 'outside-workspace' };
  if (isInside(dir, src)) return { error: 'into-self' };           // into itself/descendant
  if (path.resolve(path.dirname(src)) === path.resolve(dir)) return { error: 'same-dir' };
  const dest = withinWorkspace(path.join(dir, path.basename(src)));
  if (!dest) return { error: 'invalid-name' };
  try {
    if (fs.existsSync(dest)) return { error: 'exists' };
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // Different mounts (e.g. two workspaces on separate drives): copy then drop.
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    return { ok: true, path: dest };
  } catch (err) {
    return { error: err.code || 'move-failed' };
  }
});

// Copy a file/folder INTO another directory, keeping its basename ("Copy to…").
ipcMain.handle('fs:copy', (_e, srcPath, destDir) => {
  const src = withinWorkspace(srcPath);
  const dir = withinWorkspace(destDir);
  if (!src || !dir) return { error: 'outside-workspace' };
  const dest = withinWorkspace(path.join(dir, path.basename(src)));
  if (!dest) return { error: 'invalid-name' };
  if (isInside(dest, src)) return { error: 'into-self' };          // don't recurse into self
  try {
    if (fs.existsSync(dest)) return { error: 'exists' };
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
    return { ok: true, path: dest };
  } catch (err) {
    return { error: err.code || 'copy-failed' };
  }
});

// Duplicate a file/folder beside itself with a " copy" suffix ("Duplicate").
ipcMain.handle('fs:duplicate', (_e, srcPath) => {
  const src = withinWorkspace(srcPath);
  if (!src) return { error: 'outside-workspace' };
  let dest;
  try {
    dest = withinWorkspace(uniqueCopyName(src));
  } catch (err) {
    return { error: err.code || 'copy-failed' };
  }
  if (!dest) return { error: 'invalid-name' };
  try {
    fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
    return { ok: true, path: dest };
  } catch (err) {
    return { error: err.code || 'copy-failed' };
  }
});

ipcMain.handle('fs:trash', async (_e, targetPath) => {
  const target = withinWorkspaceOrExternal(targetPath);
  if (!target) return { error: 'outside-workspace' };
  try {
    await shell.trashItem(target);
    return { ok: true };
  } catch (err) {
    return { error: err.message || 'trash-failed' };
  }
});

ipcMain.handle('fs:reveal', (_e, targetPath) => {
  const target = withinWorkspaceOrExternal(targetPath);
  if (!target) return { error: 'outside-workspace' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ---- external file-change watching --------------------------------------
// A note open in the app is watched so an edit made in another program shows up
// automatically (the renderer reloads the tab). We watch each open file's PARENT
// DIRECTORY, not the file itself: many editors save atomically (write a temp file
// then rename it over the original), which swaps the inode and silently kills a
// file-level fs.watch — a directory watch survives that. The renderer registers a
// file on open and drops it on close (fs:watch / fs:unwatch).
const openFiles = new Map();    // abs file path -> Set<WebContents> showing it
const dirWatchers = new Map();  // dir path -> fs.FSWatcher
const appWrites = new Map();    // abs path -> last content WE wrote (self-write dedup)
const changeTimers = new Map(); // abs path -> debounce timer (saves emit event bursts)

function ensureDirWatcher(dir) {
  if (dirWatchers.has(dir)) return;
  let watcher;
  try {
    watcher = fs.watch(dir, (_evt, name) => { if (name) onDirEvent(dir, name); });
  } catch { return; } // dir unreadable / gone — nothing to watch
  watcher.on('error', () => {}); // swallow (e.g. dir later removed); torn down on unwatch
  dirWatchers.set(dir, watcher);
}

function dropDirWatcherIfUnused(dir) {
  for (const p of openFiles.keys()) if (path.dirname(p) === dir) return;
  const w = dirWatchers.get(dir);
  if (w) { w.close(); dirWatchers.delete(dir); }
}

function onDirEvent(dir, name) {
  const full = path.join(dir, name);
  if (!openFiles.has(full)) return; // some other file in the directory
  if (changeTimers.has(full)) clearTimeout(changeTimers.get(full));
  changeTimers.set(full, setTimeout(() => {
    changeTimers.delete(full);
    let content;
    try { content = fs.readFileSync(full, 'utf8'); }
    catch { return; } // unreadable / deleted — leave the open tab as it is
    if (appWrites.get(full) === content) return; // this is the app's own save
    const targets = openFiles.get(full);
    if (!targets) return;
    for (const wc of targets) {
      if (!wc.isDestroyed()) wc.send('fs:externalChange', { path: full, content });
    }
  }, 120));
}

// A renderer's WebContents went away (window closed): drop it from every watch.
function forgetWebContents(wc) {
  for (const [p, set] of openFiles) {
    if (set.delete(wc) && set.size === 0) {
      openFiles.delete(p);
      appWrites.delete(p);
      dropDirWatcherIfUnused(path.dirname(p));
    }
  }
}

ipcMain.on('fs:watch', (e, filePath) => {
  const file = withinWorkspaceOrExternal(filePath);
  if (!file) return;
  let set = openFiles.get(file);
  if (!set) { set = new Set(); openFiles.set(file, set); }
  if (!set.has(e.sender)) {
    set.add(e.sender);
    e.sender.once('destroyed', () => forgetWebContents(e.sender));
  }
  ensureDirWatcher(path.dirname(file));
});

ipcMain.on('fs:unwatch', (e, filePath) => {
  const file = withinWorkspaceOrExternal(filePath);
  if (!file) return;
  const set = openFiles.get(file);
  if (!set) return;
  set.delete(e.sender);
  if (set.size === 0) {
    openFiles.delete(file);
    appWrites.delete(file);
    dropDirWatcherIfUnused(path.dirname(file));
  }
});

// ---- workspace tree watching ---------------------------------------------
// One recursive watcher per workspace root keeps the side-panel tree honest
// about changes made outside the app (file manager deletes, terminal touches…).
// Events are coalesced for 250ms, then every window gets 'fs:treeChanged' with
// the affected PARENT directories (where an entry appeared/vanished/renamed) —
// the renderer re-reads just those tree nodes. The app's own writes also land
// here; that costs one redundant readdir of an already-correct dir, nothing
// visible. If a recursive watch can't start (inotify limits, unreadable root),
// the tree simply falls back to today's manual-refresh behaviour.
const workspaceWatchers = new Map(); // resolved root -> fs.FSWatcher
const pendingTreeDirs = new Set();
let treeChangeTimer = null;

function queueTreeChange(dir) {
  pendingTreeDirs.add(dir);
  if (treeChangeTimer) return;
  treeChangeTimer = setTimeout(() => {
    treeChangeTimer = null;
    const dirs = [...pendingTreeDirs];
    pendingTreeDirs.clear();
    for (const w of liveWindows()) {
      if (w.webContents && !w.webContents.isDestroyed()) w.webContents.send('fs:treeChanged', { dirs });
    }
  }, 250);
}

function syncWorkspaceWatchers() {
  const roots = new Set(workspaces().map((p) => path.resolve(p)));
  for (const [root, w] of workspaceWatchers) {
    if (!roots.has(root)) { try { w.close(); } catch {} workspaceWatchers.delete(root); }
  }
  for (const root of roots) {
    if (workspaceWatchers.has(root)) continue;
    try {
      const w = fs.watch(root, { recursive: true }, (_evt, name) => {
        queueTreeChange(name ? path.dirname(path.join(root, String(name))) : root);
      });
      w.on('error', () => { try { w.close(); } catch {} workspaceWatchers.delete(root); });
      workspaceWatchers.set(root, w);
    } catch { /* degrade to manual refresh */ }
  }
}

function closeWorkspaceWatchers() {
  for (const w of workspaceWatchers.values()) { try { w.close(); } catch {} }
  workspaceWatchers.clear();
  if (treeChangeTimer) { clearTimeout(treeChangeTimer); treeChangeTimer = null; }
}

// ---- export to PDF ------------------------------------------------------
// The renderer (renderer/pdf-export.js) assembles one self-contained HTML
// document — inline CSS, no scripts, no external assets — from the active
// note. We render it to a PDF the user saves to disk. (Mechanism ported from
// res/projector-app; the timeline-specific layout is not — notes are prose.)

// A safe PDF basename: drop any path parts, strip filename-illegal characters,
// and guarantee a .pdf extension.
function safePdfName(name) {
  let base = path.basename(String(name || '')).replace(/[\\/:*?"<>|]+/g, ' ').trim();
  if (!base) base = 'Notation export';
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  return base;
}

// Render a complete, self-contained HTML document to a PDF Buffer in a hidden,
// script-disabled window loaded from a temp file (more robust than a huge data:
// URL). preferCSSPageSize lets the document's @page rule drive paper size.
// displayHeaderFooter + the footer template stamps the note title (left) and
// "Page X of Y" (right) in every page's bottom margin; an empty header template
// suppresses Chromium's default date/title header. No attribution is added.
async function htmlToPdfBuffer(html, title, footerLabel) {
  const tmp = path.join(app.getPath('temp'),
    `notation-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  let win = null;
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, contextIsolation: true, nodeIntegration: false },
    });
    // Drive the load via events rather than awaiting loadFile(): a failed/slow
    // SUBRESOURCE (e.g. a remote image) makes loadFile() reject or hang, which
    // would sink the whole export. Resolve on the document's load (did-finish-
    // load), only fail on a MAIN-FRAME error, and cap the wait so a stalled
    // remote asset still produces a PDF of whatever rendered. (Local note images
    // are inlined upstream, so this mainly guards http/https references.)
    const wc = win.webContents;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 8000);
      wc.once('did-finish-load', finish);
      wc.once('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) finish(); });
      win.loadFile(tmp).catch(() => {});
    });
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#9aa0a6;padding:0 14mm;'
        + 'display:flex;justify-content:space-between;align-items:baseline;'
        + "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;"
        + '-webkit-print-color-adjust:exact;print-color-adjust:exact;">'
        + `<span>${esc(footerLabel || title || '')}</span>`
        + '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
}

// Minimal HTML escape for text interpolated into the footer template.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Reverse of attribute escaping, so a captured src maps back to a real path.
function htmlUnescape(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]
  ));
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
// 1×1 transparent PNG — stands in for a local image we couldn't read, so a
// missing/typo'd path can never stall the loader or fail the export.
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Inline the note's local images into the document as base64 data URIs. Relative
// `src`s resolve against the note's own directory (`noteDir`); a `file://` src is
// converted to a path; http(s)/data:/protocol-relative `src`s are left as-is for
// the (capped, fault-tolerant) loader. A local file we can't read becomes a 1×1
// transparent pixel. Result: a self-contained PDF that shows the note's images
// regardless of where the temp HTML is rendered.
function inlineNoteImages(html, noteDir) {
  return String(html).replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (m, pre, rawSrc, post) => {
    const src = htmlUnescape(rawSrc);
    if (!src || /^(?:https?:|data:|\/\/)/i.test(src)) return m; // remote / already inline
    let file;
    try { file = src.startsWith('file:') ? url.fileURLToPath(src) : path.resolve(noteDir || '', src); }
    catch { return pre + TRANSPARENT_PNG + post; }
    try {
      const buf = fs.readFileSync(file);
      const mime = IMG_MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
      return pre + `data:${mime};base64,${buf.toString('base64')}` + post;
    } catch { return pre + TRANSPARENT_PNG + post; }
  });
}

// The renderer hands us a complete, self-contained HTML document; we inline the
// note's local images, render it to a PDF, save it via a native Save dialog, and
// reveal it in the file manager. basePath (the note's file path) anchors the
// relative image lookups.
ipcMain.handle('pdf:export', async (e, payload) => {
  const { html, defaultName, title, footerLabel, basePath } = payload || {};
  if (!html) return { canceled: true };
  const parent = BrowserWindow.fromWebContents(e.sender);
  const name = safePdfName(defaultName);

  const res = await dialog.showSaveDialog(parent, {
    title: 'Export to PDF',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };

  try {
    const doc = inlineNoteImages(html, basePath ? path.dirname(basePath) : '');
    fs.writeFileSync(res.filePath, await htmlToPdfBuffer(doc, title, footerLabel));
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
  shell.showItemInFolder(res.filePath);
  return { path: res.filePath };
});

// ---- lifecycle ----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (desktop shortcut, `open` command, file association) lands
  // here: open any file it named, otherwise surface a normal editor window.
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const file = extractFileArg(argv, workingDirectory);
    if (file) openPathInApp(file);
    else focusOrCreateNormalWindow();
  });

  // An explicit quit (Cmd-Q / app.quit) fires before windows close, so snapshot
  // the full live set here. The flag then makes each window's close handler defer
  // to this snapshot instead of dropping itself.
  app.on('before-quit', () => { quitting = true; persistSession(); closeWorkspaceWatchers(); });

  app.whenReady().then(() => {
    restoreSessionOrCreate();
    syncWorkspaceWatchers();
    initUpdater({ readConfig, writeConfig });
    // Drain files queued before ready (macOS 'open-file') plus any named on the
    // first launch's own command line (Windows/Linux file associations).
    appReadyAndRestored = true;
    const f = extractFileArg(process.argv);
    if (f) pendingOpenPaths.push(f);
    for (const p of pendingOpenPaths.splice(0)) openPathInApp(p);
    // macOS dock click / Finder re-launch: focus a normal window, or create one
    // when only stickies are open (they float on top and shouldn't be hijacked).
    app.on('activate', () => focusOrCreateNormalWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// On launch, rebuild every window from the saved session; if there's none (first
// run / cleared), open one fresh window as before.
// On a fresh launch, EVERYTHING converges into a single window. Pinned tabs (no
// longer mirrored across windows during a session) and any floating sticky notes
// are gathered to the left as pinned tabs, in their saved order; every other tab
// follows. Stickies are "recognised as pins" here — they reopen as ordinary
// pinned tabs in this one window, not as floating post-its.
function restoreSessionOrCreate() {
  const cfg = readConfig();
  const windows = cfg.session && Array.isArray(cfg.session.windows) ? cfg.session.windows : [];
  const valid = windows.filter((d) => d && Array.isArray(d.tabs) && d.tabs.length);
  // Re-allowlist previously OS-opened (out-of-workspace) tabs so they stay
  // readable across restarts.
  for (const d of valid) for (const p of d.tabs) allowExternal(p);
  if (!valid.length) { createWindow(); return; }

  // Collect three ordered, de-duplicated path groups across every saved window:
  //   pinned  → tabs flagged pinned         sticky → the note of any sticky window
  //   other   → everything else             (pinned + sticky both become pins here)
  // Pinned/sticky are claimed first so a note open in several windows keeps its
  // pin even if another window had it as a plain tab.
  const seen = new Set();
  const pinnedPaths = [], stickyPaths = [], otherPaths = [];
  const take = (bucket, p) => { if (p && !seen.has(p)) { seen.add(p); bucket.push(p); } };
  const normals = valid.filter((d) => !d.sticky);
  for (const d of normals) d.tabs.forEach((p, i) => { if (Array.isArray(d.pinned) && d.pinned[i]) take(pinnedPaths, p); });
  for (const d of valid) if (d.sticky) d.tabs.forEach((p) => take(stickyPaths, p));
  for (const d of normals) d.tabs.forEach((p) => take(otherPaths, p));
  const pinHead = [...pinnedPaths, ...stickyPaths]; // pins + stickies, all pinned
  const tabs = [...pinHead, ...otherPaths];
  const pinnedFlags = tabs.map((_, i) => i < pinHead.length);

  // Geometry/chrome come from the first non-sticky window; the consolidated
  // window is always a normal editor (never born sticky). Land on the first
  // non-pinned tab so the user opens on working content, not a pinned reference.
  const primary = valid.find((d) => !d.sticky) || valid[0];
  const firstOther = pinHead.length < tabs.length ? pinHead.length : 0;
  createWindow(null, { restore: {
    tabs,
    pinned: pinnedFlags,
    activeIndex: firstOther,
    sticky: null,
    bounds: primary && !primary.sticky ? primary.bounds : undefined,
    maximized: !!(primary && primary.maximized),
    sidebarCollapsed: !!(primary && primary.sidebarCollapsed),
  } });
}
