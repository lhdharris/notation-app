const { contextBridge, ipcRenderer } = require('electron');

// Window-management bridge — the only window-control surface the renderer gets.
// Mirrors res/tabless-browser's `window.wm`: HTML buttons in the toolbar
// round-trip through here to the ipcMain handlers in main.js.
contextBridge.exposeInMainWorld('wm', {
  platform:       process.platform,
  close:          () => ipcRenderer.send('wm-close'),
  toggleMaximize: () => ipcRenderer.send('wm-maximize'),
  // Sticky-note shrink/restore resolve once main has finished animating the
  // bounds, so the renderer can sequence work after the shrink/grow.
  shrinkToSticky:    (size) => ipcRenderer.invoke('wm-sticky-shrink', size),
  restoreFromSticky: () => ipcRenderer.invoke('wm-sticky-restore'),
  // Resize a post-it from the renderer's corner grip. Frameless Wayland windows
  // have no compositor resize edges, so the grip sends an absolute target size
  // (accumulated from relative pointer deltas) and main applies it, clamped.
  setStickySize: (w, h) => ipcRenderer.send('wm-sticky-resize', { w, h }),
  // Tell main the post-it's chosen colour so a grip-resize paints the newly-exposed
  // area in that colour (not the default cream) before the renderer reflows.
  setStickyColor: (hex) => ipcRenderer.send('wm-sticky-color', { hex }),
  // Bracket a grip-driven resize. While dragging, main paints the window the note
  // colour (so newly-exposed area isn't black) and lifts the fixed-size pin so the
  // setSize ticks aren't clamped; on release it re-pins and restores transparency.
  stickyResizeBegin: () => ipcRenderer.send('wm-sticky-resize-begin'),
  stickyResizeEnd:   () => ipcRenderer.send('wm-sticky-resize-end'),
  // Main reports a sticky's maximize state (the WM's title-bar dblclick gesture
  // maximizes a post-it like any window) so the renderer can square the rounded
  // corners and hide the resize grip while maximized.
  onStickyMaxState: (handler) => ipcRenderer.on('sticky-max-state', (_e, on) => handler(!!on)),
  // main → renderer (mac/win): the system title-bar dblclick zoomed the post-it;
  // run the grow-then-fade restore to a normal window instead.
  onStickyRestoreRequest: (handler) => ipcRenderer.on('sticky:restore-request', () => handler()),
  // main → renderer: a file the OS asked us to open (file association, second
  // launch with a path) — open it as a tab in this window.
  onOpenPath: (handler) => ipcRenderer.on('tab:openPath', (_e, payload) => handler(payload)),

  // ---- tabs: reorder + cross-window drag (OS drag-and-drop) ----
  // Open a path in a brand-new window (context menu + drag-to-empty-space).
  openInNewWindow: (path) => ipcRenderer.send('tab-open-new-window', path),
  // Open a path in a brand-new window born as a sticky note ("Move to sticky
  // note"). `size` is the file's remembered post-it {width,height}, if any.
  openInSticky: (path, size) => ipcRenderer.send('tab-open-sticky', { path, size }),

  // ---- gather windows & stickies ----
  // How many app windows are open, as { total, normal } (normal = non-sticky;
  // initial state for the two "Gather…" items) + a subscription that keeps it
  // current as windows open/close or stickify/restore.
  windowCount:        () => ipcRenderer.invoke('wm-window-count'),
  onWindowCount:      (handler) => ipcRenderer.on('wm-window-count', (_e, n) => handler(n)),
  // Pull every other window's tabs into this one; resolves to the merged paths
  // to open here (the source windows are saved + closed by main). Pass
  // { includeStickies: false } to leave post-its alone.
  gatherTabs:         (opts) => ipcRenderer.invoke('tabs:gather', opts),
  // main → this window during a gather: save dirty tabs and report your paths.
  onCollectTabs:      (handler) => ipcRenderer.on('tabs:collect', (_e, payload) => handler(payload)),
  replyCollectTabs:   (payload) => ipcRenderer.send('tabs:collected', payload),
  // A tab drag started here: main promotes it to an OS drag (so it can cross
  // BrowserWindows) and broadcasts that a drag is active; tabOSDragEnd clears it.
  tabOSDragStart: (path) => ipcRenderer.send('tab-os-drag-start', { path }),
  tabOSDragEnd:   () => ipcRenderer.send('tab-os-drag-end'),
  // This window adopted the dragged file (the drop landed here): main relays to
  // the source window so it can drop its copy of the tab.
  tabDragAdopted: (path) => ipcRenderer.send('tab-drag-adopted', { path }),
  // main → renderer: a tab drag is/isn't active anywhere ({active, path}).
  onTabDragActive:   (handler) => ipcRenderer.on('tab-drag-active', (_e, payload) => handler(payload)),
  // main → renderer (source window): another window adopted our dragged tab.
  onTabDragConsumed: (handler) => ipcRenderer.on('tab-drag-consumed', (_e, payload) => handler(payload)),

  // ---- session restore ----
  // The renderer reports its tab list + chrome state so main can persist the
  // whole workspace; on boot it asks main what this window should rebuild from.
  session: {
    update:     (payload) => ipcRenderer.send('session:update', payload),
    getRestore: () => ipcRenderer.invoke('session:getRestore'),
  },
});

// Update banner bridge: main announces a newer GitHub release; "Update"
// downloads + opens the installer (with progress), "Skip" mutes that version.
contextBridge.exposeInMainWorld('updates', {
  onAvailable: (handler) => ipcRenderer.on('update:available', (_e, payload) => handler(payload)),
  onProgress:  (handler) => ipcRenderer.on('update:progress', (_e, payload) => handler(payload)),
  onDismissed: (handler) => ipcRenderer.on('update:dismissed', () => handler()),
  download:    () => ipcRenderer.invoke('update:download'),
  skip:        (version) => ipcRenderer.send('update:skip', version),
});

// Workspace + filesystem bridge. The renderer never touches `fs` directly;
// every call is sandboxed in main.js to the linked workspace roots.
contextBridge.exposeInMainWorld('api', {
  listWorkspaces:  () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace:    () => ipcRenderer.invoke('workspaces:add'),
  removeWorkspace: (dirPath) => ipcRenderer.invoke('workspaces:remove', dirPath),

  readDir:      (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile:     (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile:    (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  // Watch an open note for external edits (main watches its parent dir). The
  // renderer registers on open, unregisters on close, and reloads the tab when
  // onExternalChange fires with the new disk content.
  watchFile:    (filePath) => ipcRenderer.send('fs:watch', filePath),
  unwatchFile:  (filePath) => ipcRenderer.send('fs:unwatch', filePath),
  onExternalChange: (handler) => ipcRenderer.on('fs:externalChange', (_e, payload) => handler(payload)),
  // main → renderer: directories whose entries changed on disk (recursive
  // workspace watch); the side-panel tree re-reads the matching nodes.
  onTreeChanged: (handler) => ipcRenderer.on('fs:treeChanged', (_e, payload) => handler(payload)),
  createFile:   (dirPath, name) => ipcRenderer.invoke('fs:createFile', dirPath, name),
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:createFolder', dirPath, name),
  rename:       (oldPath, newName) => ipcRenderer.invoke('fs:rename', oldPath, newName),
  // Relocate / copy a file or folder into another directory (drag-and-drop and
  // the "Move to…" / "Copy to…" menu items); duplicate copies it in place.
  move:         (srcPath, destDir) => ipcRenderer.invoke('fs:move', srcPath, destDir),
  copy:         (srcPath, destDir) => ipcRenderer.invoke('fs:copy', srcPath, destDir),
  duplicate:    (srcPath) => ipcRenderer.invoke('fs:duplicate', srcPath),
  trash:        (targetPath) => ipcRenderer.invoke('fs:trash', targetPath),
  reveal:       (targetPath) => ipcRenderer.invoke('fs:reveal', targetPath),
  // Open an http(s)/mailto link from rendered markdown in the OS default app.
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // Put text on the system clipboard (editor cut/copy-line shortcuts).
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  // Resolve + act on a clicked markdown link (relative to the active file):
  // returns {kind:'open', path} for an in-workspace text file (open as a tab),
  // or {kind:'external'|'revealed'|'missing'} once main has handled it.
  openLink: (href, fromPath) => ipcRenderer.invoke('link:open', { href, fromPath }),
  // "Export to PDF": the renderer builds a self-contained HTML document; main
  // renders it to a PDF the user saves to disk.
  exportPdf: (payload) => ipcRenderer.invoke('pdf:export', payload),
});
