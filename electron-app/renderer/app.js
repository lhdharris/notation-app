'use strict';

// ---- DOM refs -----------------------------------------------------------
const tree         = document.getElementById('tree');
const liveEl       = document.getElementById('live');
const emptyState   = document.getElementById('empty-state');
const tabBar       = document.getElementById('tab-bar');
const tabBarWrap   = document.getElementById('tab-bar-wrap');
const ctxMenu      = document.getElementById('context-menu');
const stickyTitle  = document.getElementById('sticky-title');
const tabDropHint  = document.getElementById('tab-drop-hint');

// ---- state --------------------------------------------------------------
// Each open file is a tab carrying its own editor snapshot. The live editor
// instance always reflects the active tab; switching commits the outgoing
// tab's doc + cursor state and loads the incoming one.
let tabs = [];            // { id, path, name, dirty, doc, state, _row }
let activeTabId = null;
let tabSeq = 0;
let activeRow = null;
let saveTimer = null;
let windowCounts = { total: 1, normal: 1 }; // open app windows (normal = non-sticky), for the "Gather…" items

const nextId = () => ++tabSeq;
const activeTab = () => tabs.find((t) => t.id === activeTabId) || null;

// ---- live editor --------------------------------------------------------
const editor = window.createLiveEditor(liveEl, {
  onChange: () => { const t = activeTab(); if (t) { setTabDirty(t, true); scheduleSave(); } },
  onOpenLink: (href) => openLink(href),
  // table cell right-click: the editor builds the row/column items, we show them
  onContextMenu: (x, y, items) => showContextMenu(x, y, items),
});

// A clicked link in the rendered markdown. Main classifies it (resolving any
// relative path against the active note's folder): an in-workspace text file
// opens as a tab here; web/mailto opens externally; anything else is revealed
// in the OS file manager.
async function openLink(href) {
  let res;
  try { res = await api.openLink(href, activeTab()?.path || null); } catch { return; }
  if (res && res.kind === 'open') openFile(res.path, findRowByPath(res.path));
  else if (res && res.kind === 'missing') flash('Link target not found.');
}

// The file backing an open tab was changed by another program. Mirror it into
// the tab. If the tab has unsaved edits we keep them (the user's edits win) and
// just flag the divergence — never clobber. editor.load() doesn't fire onChange,
// so reloading the active tab won't re-mark it dirty or re-trigger a save.
api.onExternalChange(({ path, content }) => {
  const t = tabs.find((x) => x.path === path);
  if (!t || content === t.doc) return; // unknown tab or no real change
  if (t.dirty) { flash('File changed on disk — your unsaved edits are kept.'); return; }
  t.doc = content;
  if (t.id === activeTabId) editor.load(content, editor.getState()); // keep scroll/active line
  // a background tab picks up its new t.doc on the next activateTab()
});

// ---- icons --------------------------------------------------------------
const FOLDER_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 4c0-.55.45-1 1-1h3l1.2 1.4h6.8c.55 0 1 .45 1 1v6.6c0 .55-.45 1-1 1H2.5c-.55 0-1-.45-1-1V4z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const FOLDER_OPEN_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 4c0-.55.45-1 1-1h3l1.2 1.4h6.8c.55 0 1 .45 1 1v1.1H1.5V4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 6.5h13l-1.4 6c-.07.3-.34.5-.65.5H3c-.3 0-.55-.2-.62-.48L1.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const FILE_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v9.5c0 .3-.22.5-.5.5h-7.5c-.28 0-.5-.2-.5-.5V2c0-.3.22-.5.5-.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.6V4.5h2.9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
// A file Notation can't open in-app gets a "jump-out" (↗) arrow on its page icon
// to signal that clicking it opens another program (the file manager) — see #3.
const FILE_EXTERNAL_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v9.5c0 .3-.22.5-.5.5h-7.5c-.28 0-.5-.2-.5-.5V2c0-.3.22-.5.5-.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.6V4.5h2.9" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.1 10.4 L9.8 6.7 M9.8 6.7 H7.5 M9.8 6.7 V9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Extensions Notation treats as "open elsewhere": clicking reveals them in the OS
// file manager rather than loading them as a text tab (#3). The binary sniff in
// openFile() is the safety net for anything mis-predicted here.
const EXTERNAL_EXT = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'exe', 'msi', 'dmg', 'app', 'bin', 'so', 'dll', 'o', 'a',
]);
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const isExternalFile = (entry) => !entry.isDir && EXTERNAL_EXT.has(extOf(entry.name));
// Only markdown-family files render as markdown; everything else (.txt, .log, no
// extension, …) is shown verbatim as plain text in the editor and on PDF export.
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const isMarkdownPath = (p) => MARKDOWN_EXT.has(extOf(p || ''));
const TAB_CLOSE_SVG =
  '<svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
// Small pushpin shown on a pinned tab, before its name.
const TAB_PIN_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 2.2 L13.8 6.8 L12.6 8 L11.9 7.8 L9.4 10.3 L9.2 13 L8 14.2 L5.3 11.5 L2.6 14.2 L1.8 13.4 L4.5 10.7 L1.8 8 L3 6.8 L5.7 6.6 L8.2 4.1 L8 3.4 Z" fill="currentColor"/></svg>';

// ---- workspace tree -----------------------------------------------------
async function loadWorkspaces() {
  const list = await api.listWorkspaces();
  tree.innerHTML = '';
  for (const ws of list) {
    tree.appendChild(makeNode({ name: ws.name, path: ws.path, isDir: true }, 0, true));
  }
  if (emptyState.style.display !== 'none') refreshEmptyMessage();
}

function makeNode(entry, depth, isRoot = false) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node._path = entry.path;
  node._isDir = entry.isDir;
  node._isRoot = isRoot;
  node._depth = depth;
  node._loaded = false;
  node._external = isExternalFile(entry); // opens in the OS file manager, not a tab (#3)

  const row = document.createElement('div');
  row.className = 'node-row' + (isRoot ? ' root' : '') + (node._external ? ' external' : '');
  row.style.paddingLeft = (8 + depth * 17) + 'px';

  const chev = document.createElement('span');
  chev.className = 'chevron' + (entry.isDir ? '' : ' leaf');
  chev.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = 'node-icon';
  icon.innerHTML = entry.isDir ? FOLDER_SVG : (node._external ? FILE_EXTERNAL_SVG : FILE_SVG);

  // .node-label clips; the inner .node-label-text slides on hover to reveal a
  // long name (carousel, #5) and carries the ellipsis when not hovered.
  const label = document.createElement('span');
  label.className = 'node-label';
  const labelText = document.createElement('span');
  labelText.className = 'node-label-text';
  labelText.textContent = entry.name;
  label.append(labelText);

  row.append(chev, icon, label);
  node.append(row);

  const children = document.createElement('div');
  children.className = 'node-children';
  children.hidden = true;
  node.append(children);

  node._row = row; node._chev = chev; node._icon = icon; node._label = label; node._children = children;

  row.addEventListener('click', () => {
    if (entry.isDir) toggleDir(node);
    else if (node._external) api.reveal(entry.path); // open in the OS file manager (#3)
    else openFile(entry.path, row);
  });

  // Drag-to-move: every non-root node can be dragged; every node is a drop target
  // that resolves to a destination folder (dropping on a file lands in its folder).
  if (!isRoot) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => onNodeDragStart(e, node));
    row.addEventListener('dragend', () => onNodeDragEnd(node));
  }
  row.addEventListener('dragover', (e) => onNodeDragOver(e, node));
  row.addEventListener('dragleave', (e) => onNodeDragLeave(e, node));
  row.addEventListener('drop', (e) => onNodeDrop(e, node));
  return node;
}

// ---- tree drag-to-move --------------------------------------------------
// Native HTML5 drag confined to one window (distinct from the cross-window TAB
// drag, which is gated on dragActivePath + a different data type — no conflict,
// and these handlers stopPropagation before the document-level tab handlers see
// the event). treeDragPath is the path being moved; treeDropRow is highlighted.
let treeDragPath = null;
let treeDropRow = null;

function onNodeDragStart(e, node) {
  treeDragPath = node._path;
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-notation-path', node._path);
  } catch {}
  node._row.classList.add('dragging');
  e.stopPropagation();
}
function onNodeDragEnd(node) {
  treeDragPath = null;
  node._row.classList.remove('dragging');
  clearDropHighlight();
}

// The folder a drop on `node` lands in: itself if a directory, else its parent.
function dropFolderFor(node) { return node._isDir ? node : parentNodeOf(node); }

function validDropTarget(destNode) {
  if (!treeDragPath || !destNode) return false;
  const dp = destNode._path;
  if (dp === treeDragPath) return false;               // onto itself
  if (dp.startsWith(treeDragPath + '/')) return false; // into its own subtree
  if (dirName(treeDragPath) === dp) return false;      // already in that folder
  return true;
}
function setDropHighlight(row) {
  if (treeDropRow === row) return;
  clearDropHighlight();
  treeDropRow = row;
  row.classList.add('drop-target');
}
function clearDropHighlight() {
  if (treeDropRow) treeDropRow.classList.remove('drop-target');
  treeDropRow = null;
}
function onNodeDragOver(e, node) {
  if (!treeDragPath) return; // not a tree drag (tab drag / external) — leave it alone
  const dest = dropFolderFor(node);
  if (!validDropTarget(dest)) { clearDropHighlight(); return; }
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  setDropHighlight(dest._row);
}
function onNodeDragLeave(e, node) {
  const dest = dropFolderFor(node);
  if (dest && dest._row === treeDropRow && !dest._row.contains(e.relatedTarget)) clearDropHighlight();
}
function onNodeDrop(e, node) {
  if (!treeDragPath) return;
  const dest = dropFolderFor(node);
  if (!validDropTarget(dest)) return;
  e.preventDefault();
  e.stopPropagation();
  const srcPath = treeDragPath;
  treeDragPath = null;
  clearDropHighlight();
  doMove(srcPath, dest._path);
}

// Carousel reveal (#5): hovering a row whose name is truncated slides the inner
// text span left so the whole name scrolls past, then drifts back. Delegated on
// #tree so it covers lazily-added children; only kicks in once the pointer has
// actually moved over the app (the `no-hover` guard stops it firing on launch).
let revealRow = null;
function startReveal(row) {
  if (row === revealRow) return;
  stopReveal();
  const txt = row.querySelector('.node-label-text');
  if (!txt) return;
  const over = txt.scrollWidth - txt.clientWidth; // px hidden past the right edge
  if (over <= 2) return;
  row.style.setProperty('--reveal', `-${over + 2}px`);
  row.style.setProperty('--reveal-dur', `${Math.max(1200, Math.round(over * 22))}ms`);
  row.classList.add('revealing');
  revealRow = row;
}
function stopReveal() {
  if (!revealRow) return;
  revealRow.classList.remove('revealing');
  revealRow.style.removeProperty('--reveal');
  revealRow.style.removeProperty('--reveal-dur');
  revealRow = null;
}
tree.addEventListener('mouseover', (e) => {
  if (document.body.classList.contains('no-hover')) return;
  const row = e.target.closest('.node-row');
  if (row) startReveal(row); else stopReveal();
});
tree.addEventListener('mouseout', (e) => {
  // Leaving the tree entirely (not just crossing into a child element).
  if (!e.relatedTarget || !tree.contains(e.relatedTarget)) stopReveal();
});

async function toggleDir(node) {
  const isOpen = !node._children.hidden;
  if (isOpen) {
    node._children.hidden = true;
    node._chev.classList.remove('open');
    node._icon.innerHTML = FOLDER_SVG;
    return;
  }
  node._chev.classList.add('open');
  node._icon.innerHTML = FOLDER_OPEN_SVG;
  if (!node._loaded) await loadChildren(node);
  node._children.hidden = false;
}

async function loadChildren(node) {
  const res = await api.readDir(node._path);
  node._children.innerHTML = '';
  if (res.error) {
    const e = document.createElement('div');
    e.className = 'list-empty';
    e.style.cssText = 'padding:4px 10px;color:#bbb;font-size:12px;font-style:italic;';
    e.textContent = res.error === 'EACCES' ? '(permission denied)' : '(cannot read)';
    node._children.append(e);
  } else {
    for (const item of res.items) node._children.append(makeNode(item, node._depth + 1));
  }
  node._loaded = true;
}

// Re-read a directory node's children, keeping it expanded.
async function refreshNode(node) {
  if (!node || !node._isDir) return;
  await loadChildren(node);
  node._children.hidden = false;
  node._chev.classList.add('open');
  node._icon.innerHTML = FOLDER_OPEN_SVG;
}

// The filesystem changed under a workspace (file manager delete, terminal
// touch…): main names the affected parent directories; re-read just those tree
// nodes. Collapsed nodes are only marked stale (re-read lazily on next expand);
// expanded ones rebuild in place, restoring descendant expansion since
// loadChildren replaces their DOM.
api.onTreeChanged(async ({ dirs }) => {
  for (const d of Array.isArray(dirs) ? dirs : []) {
    const node = findNodeByPath(d);
    if (!node || !node._isDir || !node._loaded) continue; // nothing stale on screen
    if (node._children.hidden) { node._loaded = false; continue; }
    const expanded = [...node._children.querySelectorAll('.tree-node')]
      .filter((n) => n._isDir && !n._children.hidden).map((n) => n._path);
    await loadChildren(node);
    for (const p of expanded) { // document order: parents re-expand before children
      const n = findNodeByPath(p);
      if (n && n._children.hidden) await toggleDir(n);
    }
  }
  // Row elements may have been rebuilt — re-point the active-file highlight.
  const t = activeTab();
  if (t) setActiveRow(findRowByPath(t.path));
});

function parentNodeOf(node) {
  const c = node.parentElement;
  return c && c.classList.contains('node-children') ? c.parentElement : null;
}

function findNodeByPath(p) {
  if (!p) return null;
  for (const n of tree.querySelectorAll('.tree-node')) if (n._path === p) return n;
  return null;
}
function findRowByPath(p) { const n = findNodeByPath(p); return n ? n._row : null; }

function setActiveRow(row) {
  if (activeRow) activeRow.classList.remove('active');
  activeRow = row || null;
  if (activeRow) activeRow.classList.add('active');
}

// Expand the tree down to a file's folder and scroll its row into view, so
// opening or switching to a tab always shows where the note lives. Suppressed
// during session restore (booting) so launch doesn't unfold every open tab's
// folder; boot reveals just the final active tab afterwards.
let booting = false;
async function revealInTree(filePath) {
  if (booting || !filePath) return;
  let root = null;
  for (const n of tree.children) {
    const p = n._path;
    if (p && (filePath === p || filePath.startsWith(p + '/'))) { root = p; break; }
  }
  if (!root) return; // not under any linked workspace
  // Ancestor directories, root first; expand each (lazy-loading as needed).
  const dirs = [root];
  const segs = filePath.slice(root.length + 1).split('/');
  segs.pop(); // the filename itself
  let cur = root;
  for (const seg of segs) { cur += '/' + seg; dirs.push(cur); }
  for (const d of dirs) {
    const node = findNodeByPath(d);
    if (!node || !node._isDir) return;
    if (node._children.hidden) await toggleDir(node);
  }
  const row = findRowByPath(filePath);
  if (row) {
    setActiveRow(row);
    row.scrollIntoView({ block: 'nearest' });
  }
}

// ---- tabs ---------------------------------------------------------------
function renderTabs() {
  tabBar.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (tab.dirty ? ' dirty' : '')
      + (tab.pinned ? ' pinned' : '');
    el.dataset.id = String(tab.id);
    el.title = tab.path || tab.name;

    if (tab.pinned) {
      const pin = document.createElement('span');
      pin.className = 'tab-pin';
      pin.innerHTML = TAB_PIN_SVG;
      el.append(pin);
    }

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;

    const dot = document.createElement('span');
    dot.className = 'tab-dirty';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Close';
    close.innerHTML = TAB_CLOSE_SVG;

    el.append(name, dot, close);
    el.draggable = true;
    el.addEventListener('dragstart', (e) => onTabDragStart(e, tab, el));
    el.addEventListener('dragend', () => onTabDragEnd(tab));
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) { e.stopPropagation(); closeTab(tab); return; }
      activateTab(tab);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: tab.pinned ? 'Unpin' : 'Pin', action: () => (tab.pinned ? unpinTab(tab) : pinTab(tab)) },
        { sep: true },
        { label: 'Move to new window', action: () => moveTabToNewWindow(tab) },
        { label: 'Move to sticky note', action: () => moveTabToSticky(tab) },
        { label: 'Gather all windows', disabled: windowCounts.normal < 2, action: () => gatherOpenTabs(false) },
        { label: 'Gather all windows and stickies', disabled: windowCounts.total < 2, action: () => gatherOpenTabs(true) },
        { sep: true },
        { label: 'Close', action: () => closeTab(tab) },
        { label: 'Close others', action: () => closeOtherTabs(tab) },
        { sep: true },
        { label: 'Delete file', danger: true, action: () => deleteTabFile(tab) },
      ]);
    });
    tabBar.append(el);
  }
  updateTabOverflow();
  reportSession();
}

// Show the blue "portal" overflow lines when tabs run off either edge (#4).
function updateTabOverflow() {
  if (!tabBarWrap) return;
  const max = tabBar.scrollWidth - tabBar.clientWidth;
  tabBarWrap.classList.toggle('overflow-left', tabBar.scrollLeft > 1);
  tabBarWrap.classList.toggle('overflow-right', tabBar.scrollLeft < max - 1);
}
tabBar.addEventListener('scroll', updateTabOverflow);
window.addEventListener('resize', updateTabOverflow);

// Pinned tabs live as a contiguous group at the left edge of the bar. Pinning
// moves the tab to the end of that group; unpinning drops it just after the
// group. Drag-reordering can't cross the boundary (see reorderTo).
//
// Pins are LOCAL to their window — pinning here never opens the note in any
// other window. The pin flag rides along in the per-window session snapshot
// (reportSession), and on a fresh launch main gathers every window's pins plus
// any sticky notes into one window as pinned tabs (see restoreSessionOrCreate).
const pinnedCount = () => tabs.filter((t) => t.pinned).length;

function pinTab(tab) {
  if (tab.pinned || !tab.path) return;
  const from = tabs.indexOf(tab);
  if (from < 0) return;
  tabs.splice(from, 1);
  tab.pinned = true;
  // tab itself is out of the array here, so pinnedCount() = the other pinned
  // tabs — exactly the index at the end of the pinned group.
  tabs.splice(pinnedCount(), 0, tab);
  renderTabs();
}

function unpinTab(tab) {
  if (!tab.pinned) return;
  const from = tabs.indexOf(tab);
  if (from < 0) return;
  tabs.splice(from, 1);
  tab.pinned = false;
  tabs.splice(pinnedCount(), 0, tab); // first unpinned slot
  renderTabs();
}

function setTabDirty(tab, v) {
  tab.dirty = v;
  const el = tabBar.querySelector(`.tab[data-id="${tab.id}"]`);
  if (el) el.classList.toggle('dirty', v);
}

function commitActive() {
  const t = activeTab();
  if (!t) return;
  t.doc = editor.getDoc();
  t.state = editor.getState();
}

async function activateTab(tab) {
  if (activeTabId === tab.id) return;
  const cur = activeTab();
  if (cur) { await flushSave(); commitActive(); }
  activeTabId = tab.id;
  liveEl.hidden = false;
  emptyState.style.display = 'none';
  window.setMarkdownImageBase(tab.path ? parentDir(tab.path) : null); // relative images resolve per note
  editor.load(tab.doc, tab.state, { markdown: isMarkdownPath(tab.path) });
  renderTabs();
  setActiveRow(tab._row && tab._row.isConnected ? tab._row : findRowByPath(tab.path));
  revealInTree(tab.path);
  if (document.body.classList.contains('sticky-mode')) { updateStickyTitle(); refreshStickyColor(); }
}

// Open a file as a tab. `opts.activate: false` opens it in the background
// (used by the global-pin merge, which must never steal focus from the note
// being edited): the tab is added and watched but the editor stays put.
// Resolves to the tab, or null when the file couldn't be read.
async function openFile(filePath, row, opts = {}) {
  const activate = opts.activate !== false;
  const existing = tabs.find((t) => t.path === filePath);
  if (existing) { if (row) existing._row = row; if (activate) await activateTab(existing); return existing; }
  const res = await api.readFile(filePath);
  if (res.error) {
    if (!activate) return null; // background open: the caller handles the miss
    // Can't load it as text — reveal a binary file in the OS file manager rather
    // than just failing (#3); other errors (permission, gone) still flash.
    if (res.error === 'binary') api.reveal(filePath);
    else flash('Could not open file.');
    return null;
  }
  const tab = { id: nextId(), path: filePath, name: baseName(filePath), dirty: false, pinned: false, doc: res.content, state: null, _row: row || null };
  if (!activate) {
    tabs.push(tab);
    api.watchFile(filePath);
    renderTabs();
    return tab;
  }
  if (activeTab()) { await flushSave(); commitActive(); }
  tabs.push(tab);
  api.watchFile(filePath); // pick up external edits to this note
  activeTabId = tab.id;
  liveEl.hidden = false;
  emptyState.style.display = 'none';
  window.setMarkdownImageBase(parentDir(filePath)); // relative images resolve per note
  editor.load(tab.doc, null, { markdown: isMarkdownPath(filePath) });
  renderTabs();
  setActiveRow(row || findRowByPath(filePath));
  revealInTree(filePath);
  if (document.body.classList.contains('sticky-mode')) { updateStickyTitle(); refreshStickyColor(); }
  return tab;
}

async function closeTab(tab, skipSave = false) {
  if (!skipSave && tab.path && tab.dirty) {
    if (tab.id === activeTabId) { commitActive(); await flushSave(); }
    else { await api.writeFile(tab.path, tab.doc); }
  }
  const idx = tabs.indexOf(tab);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (tab.path && !tabs.some((x) => x.path === tab.path)) api.unwatchFile(tab.path);
  if (tab.id === activeTabId) {
    activeTabId = null;
    const next = tabs[idx] || tabs[idx - 1];
    if (next) await activateTab(next);
    else showEmpty();
  }
  renderTabs();
}

function closeTabByPath(p, skipSave = false) { const t = tabs.find((x) => x.path === p); if (t) closeTab(t, skipSave); }

// The empty-state sub-line depends on whether any workspace is in the side panel:
// once you have one, the next step is just picking a file; otherwise prompt to add one.
function refreshEmptyMessage() {
  const sub = emptyState.querySelector('.empty-sub');
  if (!sub) return;
  sub.textContent = tree.children.length > 0
    ? 'Select a file to open it in a new tab'
    : 'Add a workspace, then pick a file from the side panel.';
}

function showEmpty() {
  activeTabId = null;
  liveEl.hidden = true;
  emptyState.style.display = '';
  refreshEmptyMessage();
  window.setMarkdownImageBase(null);
  editor.load('');
  setActiveRow(null);
  renderTabs();
  if (document.body.classList.contains('sticky-mode')) { updateStickyTitle(); refreshStickyColor(); }
}

// ---- save ---------------------------------------------------------------
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, 800);
}

async function doSave() {
  const t = activeTab();
  if (!t || !t.dirty || !t.path) return;
  const content = editor.getDoc();
  const res = await api.writeFile(t.path, content);
  if (!res.error) { t.doc = content; setTabDirty(t, false); }
  else flash('Save failed.');
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return doSave();
}

// ---- session restore ----------------------------------------------------
// Report this window's open tabs + chrome state to main (debounced) so the whole
// workspace can be rebuilt on next launch. Main owns window geometry + sticky
// state; we only contribute the tab list, active tab and sidebar state.
let sessionTimer = null;
function reportSession() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    const withPath = tabs.filter((t) => t.path);
    wm.session.update({
      tabs: withPath.map((t) => t.path),
      pinned: withPath.map((t) => !!t.pinned),
      activeIndex: Math.max(0, withPath.findIndex((t) => t.id === activeTabId)),
      sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),
    });
  }, 250);
}

// ---- tab drag (reorder / cross-window via HTML5 drag-and-drop) ----------
// Tabs use native HTML5 drag; the browser auto-promotes it to an OS drag once it
// leaves the window, so it can cross BrowserWindow boundaries — the only scheme
// that works on Wayland, where global cursor/window coords aren't exposed.
//   • drop on this window's bar       → reorder
//   • drop on another notation window → that window adopts the file (tab moves)
//   • drop on empty space / outside   → nothing (tab stays put)
// Detaching a tab into a NEW window is intentional-only: the right-click "Move
// to new window" action. Dragging a tab out no longer spawns a window — that
// misfired on near-edge reorders (drop a hair off the bar → surprise window).
// dragSource is set only in the window that began the drag; dragActivePath is
// set in every window (via a main broadcast) while any tab drag is in flight.
let dragSource = null;     // { tab, el, consumed, reordered, droppedInSource }
let dragActivePath = null; // path being dragged anywhere, or null
let insertMarker = null;

function onTabDragStart(e, tab, el) {
  if (!tab.path) { e.preventDefault(); return; } // unsaved tab: nothing to hand off
  dragSource = { tab, el, consumed: false, reordered: false };
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-notation-tab', tab.path);
    e.dataTransfer.setData('text/plain', tab.path);
  } catch {}
  el.classList.add('dragging');
  // Persist first so whichever window adopts it reads current content from disk.
  saveTabBeforeTransfer(tab);
  wm.tabOSDragStart(tab.path); // main broadcasts tab-drag-active to all windows
}

async function onTabDragEnd(tab) {
  const src = dragSource;
  dragSource = null;
  if (src && src.el) src.el.classList.remove('dragging');
  hideInsertionMarker();
  wm.tabOSDragEnd();
  if (!src) return;
  // Give a cross-window adopt's 'tab-drag-consumed' (relayed via main) a moment.
  await new Promise((r) => setTimeout(r, 60));
  if (src.reordered) return;                              // reordered in this bar
  if (src.consumed) { await closeTab(tab, true); closeWindowIfEmpty(); return; } // adopted elsewhere
  // Released off the tab bar without another window adopting it — leave the tab
  // exactly where it was. We no longer detach into a new window on drag-out;
  // that's right-click "Move to new window" only (see moveTabToNewWindow).
}

// A transfer (detach / move-to-new-window / adopted-elsewhere) just removed a
// tab. If it was this window's last one, close the now-blank window instead of
// leaving an empty shell behind. Manual last-tab close keeps the window open
// (it falls through to showEmpty), per design.
function closeWindowIfEmpty() { if (!tabs.length) wm.close(); }

// ---- drop targets: bar = reorder/adopt; window = detect in-source release ----
function computeInsertIndex(clientX) {
  const els = [...tabBar.querySelectorAll('.tab')];
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return els.length;
}

function showInsertionMarker(index) {
  if (!insertMarker) {
    insertMarker = document.createElement('div');
    insertMarker.className = 'tab-insert-marker';
  }
  // renderTabs() wipes tabBar.innerHTML, which orphans the marker; re-attach it
  // whenever it isn't a live child of the bar (pin/unpin/reorder/activate all
  // re-render, so without this the marker silently stops showing on later drags).
  if (insertMarker.parentNode !== tabBar) tabBar.appendChild(insertMarker);
  const els = [...tabBar.querySelectorAll('.tab')];
  const barRect = tabBar.getBoundingClientRect();
  let x;
  if (!els.length) x = 4;
  else if (index >= els.length) x = els[els.length - 1].getBoundingClientRect().right - barRect.left + tabBar.scrollLeft;
  else x = els[index].getBoundingClientRect().left - barRect.left + tabBar.scrollLeft;
  insertMarker.style.left = (x - 1) + 'px';
  insertMarker.style.display = 'block';
}

function hideInsertionMarker() { if (insertMarker) insertMarker.style.display = 'none'; }

function onTabBarDragOver(e) {
  if (!dragActivePath) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  showInsertionMarker(computeInsertIndex(e.clientX));
}

function onTabBarDrop(e) {
  if (!dragActivePath) return;
  e.preventDefault();
  e.stopPropagation();
  hideInsertionMarker();
  const index = computeInsertIndex(e.clientX);
  if (dragSource) reorderTo(index);            // same window → reorder
  else adoptDraggedTab(dragActivePath, index); // another window → adopt at drop spot
}

function reorderTo(index) {
  const src = dragSource;
  src.reordered = true;
  const from = tabs.indexOf(src.tab);
  if (from < 0) return;
  let to = index > from ? index - 1 : index;   // removing src shifts indices left
  to = Math.max(0, Math.min(to, tabs.length - 1));
  // Keep the pinned group intact: a pinned tab reorders within it, an unpinned
  // tab can't drop into it. (The group size doesn't count src once removed.)
  const pinnedOthers = tabs.filter((t) => t.pinned && t !== src.tab).length;
  to = src.tab.pinned ? Math.min(to, pinnedOthers) : Math.max(to, pinnedOthers);
  if (to === from) return;
  tabs.splice(from, 1);
  tabs.splice(to, 0, src.tab);
  renderTabs();
}

async function adoptDraggedTab(p, index) {
  const tab = await openFile(p, findRowByPath(p));
  // Drop onto the bar carries an insertion index: land the tab where it was
  // dropped (the bar shows an insertion marker there), not at the far right.
  // A drop onto the note body has no index → it just stays where openFile put it.
  if (tab && Number.isInteger(index)) placeAdoptedTab(tab, index);
  wm.tabDragAdopted(p); // main relays 'tab-drag-consumed' back to the source window
}

// Move a freshly-adopted tab to the drop position. openFile appended it, so its
// current slot is the end; an adopted tab is unpinned, so it can't land inside
// the pinned group — clamp it to the first unpinned slot or later (mirrors the
// unpinned branch of reorderTo).
function placeAdoptedTab(tab, index) {
  const from = tabs.indexOf(tab);
  if (from < 0) return;
  let to = index > from ? index - 1 : index;   // removing it shifts indices left
  const pinnedOthers = tabs.filter((t) => t.pinned && t !== tab).length;
  to = Math.max(pinnedOthers, Math.min(to, tabs.length - 1));
  if (to === from) return;
  tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  renderTabs();
}

// A release anywhere in this window that ISN'T the bar: if we're the source the
// tab stays put (handled in onTabDragEnd); if we're another window, adopt it (a
// drop onto the note body moves the tab here).
function onWindowDragOver(e) {
  if (!dragActivePath) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onWindowDrop(e) {
  if (!dragActivePath) return;
  e.preventDefault();
  // A release off the tab bar in the SOURCE window does nothing now (the tab
  // stays where it was — see onTabDragEnd). In ANY OTHER window, adopt the
  // dragged file (a drop onto the note body moves the tab here).
  if (!dragSource) adoptDraggedTab(dragActivePath);
}

tabBar.addEventListener('dragover', onTabBarDragOver);
tabBar.addEventListener('drop', onTabBarDrop);
document.addEventListener('dragover', onWindowDragOver);
document.addEventListener('drop', onWindowDrop);

async function saveTabBeforeTransfer(tab) {
  if (!tab.path) return;
  if (tab.id === activeTabId) { commitActive(); await flushSave(); }
  else if (tab.dirty) { await api.writeFile(tab.path, tab.doc); tab.dirty = false; }
}

// Right-click tab actions: pop the tab into its own window (moving it), or close.
async function moveTabToNewWindow(tab) {
  if (!tab.path) return;
  await saveTabBeforeTransfer(tab);
  wm.openInNewWindow(tab.path);
  await closeTab(tab, true);
  closeWindowIfEmpty();
}

// Pop the tab straight into a desktop post-it: a new window born sticky. The
// note's remembered post-it size (if it was stickified before) rides along;
// the new window reads its own colour from the shared prefs store.
async function moveTabToSticky(tab) {
  if (!tab.path) return;
  await saveTabBeforeTransfer(tab);
  const prefs = getStickyPrefs(tab.path);
  const size = (Number.isFinite(prefs.width) && Number.isFinite(prefs.height))
    ? { width: prefs.width, height: prefs.height } : null;
  wm.openInSticky(tab.path, size);
  await closeTab(tab, true);
  closeWindowIfEmpty();
}

async function closeOtherTabs(keep) {
  for (const t of tabs.slice()) if (t.id !== keep.id) await closeTab(t);
}

// ---- gather open tabs ---------------------------------------------------
// Pull every other window's tabs into this one. Main saves + closes the other
// windows and hands back their file paths in order; we open each here (already-
// open files just re-activate, so duplicates collapse). With includeStickies
// false, post-it notes are left floating where they are.
async function gatherOpenTabs(includeStickies = true) {
  if ((includeStickies ? windowCounts.total : windowCounts.normal) < 2) return;
  if (activeTab()) { await flushSave(); commitActive(); }
  let paths = [];
  try { paths = await wm.gatherTabs({ includeStickies }); } catch { return; }
  for (const p of paths) await openFile(p, findRowByPath(p));
}

// Main asks this window to surrender its tabs to a gather: save anything dirty so
// the gathering window reopens current content, then report our ordered paths.
wm.onCollectTabs(async ({ token }) => {
  commitActive(); // fold the live editor's edits into the active tab's doc
  for (const t of tabs.slice()) {
    if (t.path && t.dirty) { await api.writeFile(t.path, t.doc); t.dirty = false; }
  }
  wm.replyCollectTabs({ token, paths: tabs.map((t) => t.path).filter(Boolean) });
});

// Keep windowCounts current so the gather items enable/grey out as windows
// open, close, stickify or restore.
const setWindowCounts = (n) => { if (n && Number.isInteger(n.total) && Number.isInteger(n.normal)) windowCounts = n; };
wm.onWindowCount(setWindowCounts);
wm.windowCount().then(setWindowCounts).catch(() => {});

// ---- window controls ----------------------------------------------------
document.getElementById('close').addEventListener('click', () => wm.close());
document.getElementById('maximize').addEventListener('click', () => wm.toggleMaximize());
// Double-clicking empty top-bar space (not a tab, not a button) toggles maximize —
// the familiar title-bar gesture a frameless window doesn't provide on its own.
document.getElementById('toolbar').addEventListener('dblclick', (e) => {
  if (document.body.classList.contains('sticky-mode')) return;
  if (e.target.closest('.tab') || e.target.closest('button')) return;
  wm.toggleMaximize();
});
// Right-click the top bar for a stripped-back menu (new file + the gather
// actions). Tabs keep their own fuller menu; the empty bar is an app-region drag
// strip, but right-click still fires contextmenu here (same as the sticky title).
document.getElementById('toolbar').addEventListener('contextmenu', (e) => {
  if (document.body.classList.contains('sticky-mode')) return;
  if (e.target.closest('.tab')) return; // tabs have their own context menu
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: 'New file', action: () => newFile() },
    { sep: true },
    { label: 'Gather all windows', disabled: windowCounts.normal < 2, action: () => gatherOpenTabs(false) },
    { label: 'Gather all windows and stickies', disabled: windowCounts.total < 2, action: () => gatherOpenTabs(true) },
  ]);
});
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
  reportSession();
});

// ---- formatting bar -------------------------------------------------------
// One delegated listener; mousedown is swallowed so the editor's focus and
// selection survive the button press, then click runs the editor command.
const formatBar = document.getElementById('format-bar');
formatBar.addEventListener('mousedown', (e) => e.preventDefault());
formatBar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (!activeTab()) { flash('Open a note to format.'); return; }
  editor.format(btn.dataset.action);
});
document.getElementById('add-workspace').addEventListener('click', addWorkspace);
document.getElementById('new-file').addEventListener('click', newFile);

// ---- share / export -----------------------------------------------------
// The export button renders the active note straight to a PDF (main shows the
// native Save dialog). It used to open a one-item dropdown; clicking now exports
// directly.
document.getElementById('share-btn').addEventListener('click', exportActiveToPdf);

async function exportActiveToPdf() {
  const t = activeTab();
  if (!t) { flash('Open a note to export.'); return; }
  const title = t.name.replace(/\.[^./]+$/, '');            // doc heading + save name (no extension)
  const doc = editor.getDoc();                              // live content, incl. unsaved edits
  // Non-markdown files (.txt etc.) export verbatim — never re-interpret their text
  // as markdown, mirroring how the editor shows them.
  const bodyHtml = isMarkdownPath(t.path)
    ? window.renderMarkdown(doc)
    : '<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0">'
      + doc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      + '</pre>';
  // Math in the note → inline the vendored KaTeX css so the self-contained PDF
  // document can style the markup (best-effort: its woff2 fonts won't resolve
  // there, so KaTeX falls back to system fonts).
  let extraCss = '';
  if (bodyHtml.includes('class="katex')) {
    try { extraCss = await (await fetch('vendor/katex/katex.min.css')).text(); } catch (_) { /* export without it */ }
  }
  const html = window.NotePdf.buildDocument({ title, bodyHtml, dateISO: new Date().toISOString(), extraCss });
  // basePath lets main resolve the note's relative image paths and inline them.
  // footerLabel keeps the extension for the footer's bottom-left, e.g. "todo.md".
  const res = await api.exportPdf({ html, title, footerLabel: t.name, basePath: t.path, defaultName: title + '.pdf' });
  if (res?.error) flash('Export failed: ' + res.error);
  else if (res?.path) flash('Exported to PDF.');
}

// ---- sticky note (now a live editor of the active file) -----------------
// Per-note post-it prefs (colour + last resized size) live in the renderer's
// localStorage keyed by file path, so a stickify reuses them. The renderer owns
// these because it drives both the CSS colour and the grip resize; main just
// animates to the size and paints the resize fill the chosen colour.
const DEFAULT_STICKY_COLOR = '#FFFDEB';
const stickyColorBtn = document.getElementById('sticky-color');
const stickySwatch = stickyColorBtn ? stickyColorBtn.querySelector('.sticky-swatch') : null;

function readStickyPrefs() {
  try { return JSON.parse(localStorage.getItem('stickyPrefs') || '{}') || {}; } catch { return {}; }
}
function getStickyPrefs(path) {
  const all = readStickyPrefs();
  return (path && all[path]) || {};
}
function setStickyPrefs(path, partial) {
  if (!path) return;
  const all = readStickyPrefs();
  all[path] = { ...(all[path] || {}), ...partial };
  try { localStorage.setItem('stickyPrefs', JSON.stringify(all)); } catch {}
}

// Paint the post-it the given colour: CSS vars drive #app / the title strip / the
// outline overlay (style.css); the swatch shows the pick; main repaints the window
// fill so a grip-resize grows in the same colour. `persist` saves it for the note.
function applyStickyColor(hex, persist) {
  const color = hex || DEFAULT_STICKY_COLOR;
  document.body.style.setProperty('--sticky-bg', color);
  const border = (window.Palette && Palette.cardBorder) ? Palette.cardBorder(color) : color;
  document.body.style.setProperty('--sticky-border', border);
  // Deep same-hue "ink" for small marks (task checkboxes) that need real
  // contrast against the pastel — grey/light-blue defaults vanish on it.
  const ink = (window.Palette && Palette.ink) ? Palette.ink(color) : '#6b6347';
  document.body.style.setProperty('--sticky-ink', ink);
  if (stickySwatch) stickySwatch.style.background = color;
  wm.setStickyColor(color);
  if (persist) { const t = activeTab(); if (t && t.path) setStickyPrefs(t.path, { color }); }
}
// Reflect the active note's saved colour (on stickify and on a tab switch in sticky).
function refreshStickyColor() {
  const t = activeTab();
  applyStickyColor(getStickyPrefs(t && t.path).color || DEFAULT_STICKY_COLOR, false);
}

// A small palette popup of the shared pastels (palette.js — same set as
// projector-app), opened from the colour circle in the post-it's action bar.
let stickyPalette = null;
function hideStickyPalette() { if (stickyPalette) { stickyPalette.remove(); stickyPalette = null; } }
function toggleStickyPalette() {
  if (stickyPalette) { hideStickyPalette(); return; }
  if (!stickyColorBtn) return;
  const pop = document.createElement('div');
  pop.id = 'sticky-palette';
  for (const p of ((window.Palette && Palette.PRESETS) || [])) {
    const b = document.createElement('button');
    b.className = 'sticky-palette-swatch';
    b.style.background = p.hex;
    b.title = p.name;
    b.addEventListener('click', () => { applyStickyColor(p.hex, true); hideStickyPalette(); });
    pop.append(b);
  }
  document.body.append(pop);
  const r = stickyColorBtn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pr.width - 4)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  stickyPalette = pop;
}

function updateStickyTitle() {
  const t = activeTab();
  stickyTitle.textContent = t ? t.name : 'Untitled';
}

async function enterSticky() {
  updateStickyTitle();
  refreshStickyColor();
  document.body.classList.add('sticky-mode');
  const t = activeTab();
  const prefs = t && t.path ? getStickyPrefs(t.path) : {};
  const size = (Number.isFinite(prefs.width) && Number.isFinite(prefs.height))
    ? { w: prefs.width, h: prefs.height } : undefined; // remembered size if any, else main's default
  await wm.shrinkToSticky(size);
  reportSession();
}

// Leave sticky mode: grow back to the normal-window footprint first (main
// animates the bounds while the post-it chrome stretches with it), then
// crossfade the chrome — a full-window cover in the note colour drops over the
// window, the normal editor renders beneath it, and the cover fades out.
// Shared by the restore button, the title-bar dblclick (Linux delivers it to
// the DOM) and main's sticky:restore-request (mac/win, where the system
// swallows the dblclick and zooms the window instead).
let stickyExitInFlight = false;
async function exitSticky() {
  if (stickyExitInFlight || !document.body.classList.contains('sticky-mode')) return;
  stickyExitInFlight = true;
  // Clear directly too: main's unmaximize during the restore fires after
  // _sticky is nulled, so no sticky-max-state event will arrive for it.
  document.body.classList.remove('sticky-maximized');
  try {
    await wm.restoreFromSticky();
    const fade = document.createElement('div');
    fade.id = 'sticky-fade';
    fade.style.background =
      getComputedStyle(document.body).getPropertyValue('--sticky-bg').trim() || DEFAULT_STICKY_COLOR;
    document.body.append(fade);
    document.body.classList.remove('sticky-mode');
    // Two frames so the cover paints at full opacity before the fade starts.
    requestAnimationFrame(() => requestAnimationFrame(() => fade.classList.add('out')));
    fade.addEventListener('transitionend', () => fade.remove(), { once: true });
    setTimeout(() => fade.remove(), 600); // safety net if transitionend is dropped
    reportSession();
  } finally {
    stickyExitInFlight = false;
  }
}

document.getElementById('sticky').addEventListener('click', enterSticky);
document.getElementById('sticky-restore').addEventListener('click', exitSticky);
document.getElementById('sticky-x').addEventListener('click', () => wm.close());
// Double-click on the title strip restores to a normal window (Linux path —
// on mac/win the system intercepts the gesture; see onStickyRestoreRequest).
stickyTitle.addEventListener('dblclick', (e) => { e.preventDefault(); exitSticky(); });
wm.onStickyRestoreRequest(() => exitSticky());
// Right-click on the title strip: window actions for a chrome-less post-it.
stickyTitle.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: 'New Window', action: () => wm.openInNewWindow(null) },
  ]);
});
if (stickyColorBtn) stickyColorBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStickyPalette(); });
document.addEventListener('click', (e) => {
  if (stickyPalette && !stickyPalette.contains(e.target) && !(stickyColorBtn && stickyColorBtn.contains(e.target))) hideStickyPalette();
});
window.addEventListener('blur', hideStickyPalette);
// The WM's title-bar dblclick maximizes a post-it like any window; square the
// corners while it fills the screen (style.css .sticky-maximized rules).
wm.onStickyMaxState((on) => document.body.classList.toggle('sticky-maximized', on));

// ---- sticky resize grip -------------------------------------------------
// Frameless Wayland windows expose no resize edges, so the bottom-right grip
// drives the resize from relative pointer deltas (movementX/Y, the only reliable
// signal where absolute coords aren't exposed). We accumulate an absolute target
// size and hand it to main (throttled to one rAF), which clamps + applies it with
// the top-left anchored, so the note grows toward the grip.
const stickyResize = document.getElementById('sticky-resize');
let resizeState = null; // { w, h, raf, pointerId }

stickyResize.addEventListener('pointerdown', (e) => {
  if (!document.body.classList.contains('sticky-mode')) return;
  e.preventDefault();
  try { stickyResize.setPointerCapture(e.pointerId); } catch {}
  resizeState = { w: window.innerWidth, h: window.innerHeight, raf: 0, pointerId: e.pointerId };
  wm.stickyResizeBegin(); // main paints the note colour + lifts the size pin for the drag
});

stickyResize.addEventListener('pointermove', (e) => {
  if (!resizeState) return;
  resizeState.w += e.movementX;
  resizeState.h += e.movementY;
  if (!resizeState.raf) {
    resizeState.raf = requestAnimationFrame(() => {
      if (!resizeState) return;
      resizeState.raf = 0;
      wm.setStickySize(resizeState.w, resizeState.h);
    });
  }
});

function endStickyResize(e) {
  if (!resizeState) return;
  if (resizeState.raf) cancelAnimationFrame(resizeState.raf);
  try { stickyResize.releasePointerCapture(resizeState.pointerId); } catch {}
  // Remember this note's preferred post-it size so a future stickify reuses it (#7).
  const t = activeTab();
  if (t && t.path) setStickyPrefs(t.path, { width: Math.round(resizeState.w), height: Math.round(resizeState.h) });
  resizeState = null;
  wm.stickyResizeEnd(); // main re-pins the size + restores transparency
}
stickyResize.addEventListener('pointerup', endStickyResize);
stickyResize.addEventListener('pointercancel', endStickyResize);

// ---- cross-window tab transfer ------------------------------------------
// main → renderer: a tab drag started/ended somewhere. Track the active path so
// our drop targets accept it, and show the blue drop hint on windows that aren't
// the drag's own source.
wm.onTabDragActive(({ active, path }) => {
  dragActivePath = active ? (path || '') : null;
  tabDropHint.hidden = !(active && !dragSource);
  if (!active) hideInsertionMarker();
});
// main → renderer (source window only): another window adopted our dragged tab.
wm.onTabDragConsumed(() => { if (dragSource) dragSource.consumed = true; });

// ---- keyboard shortcuts -------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = wm.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); flushSave(); }
  if (mod && (e.key === 'w' || e.key === 'W')) { const t = activeTab(); if (t) { e.preventDefault(); closeTab(t); } }
  if (e.key === 'Escape') hideContextMenu();
});

// ---- workspace add ------------------------------------------------------
async function addWorkspace() {
  const ws = await api.addWorkspace();
  if (ws) await loadWorkspaces();
}

// ---- new markdown file (the "+" button) ---------------------------------
function parentDir(p) {
  const s = p.replace(/[\\/]+$/, '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx > 0 ? s.slice(0, idx) : s;
}

async function newFile() {
  const t = activeTab();
  let dir = t && t.path ? parentDir(t.path) : null;
  if (!dir) { const list = await api.listWorkspaces(); if (list[0]) dir = list[0].path; }
  if (!dir) { flash('Add a workspace first.'); return; }
  let name = await promptName('New file name', 'untitled.md');
  if (!name) return;
  if (!/\.[^.\\/]+$/.test(name)) name += '.md';
  const res = await api.createFile(dir, name);
  if (res.error) { flash(res.error === 'exists' ? 'Already exists.' : 'Could not create.'); return; }
  const node = findNodeByPath(dir);
  if (node) await refreshNode(node);
  await openFile(res.path, node ? findRow(node, res.path) : null);
}

// ---- custom context menu ------------------------------------------------
function hideContextMenu() { ctxMenu.hidden = true; ctxMenu.innerHTML = ''; }

function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      ctxMenu.append(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { hideContextMenu(); it.action(); });
    ctxMenu.append(b);
  }
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 6);
  const py = Math.min(y, window.innerHeight - r.height - 6);
  ctxMenu.style.left = Math.max(4, px) + 'px';
  ctxMenu.style.top = Math.max(4, py) + 'px';
}

// Dismiss on any press outside the menu. Capture-phase pointerdown — not
// click: the editor's mousedown handler calls preventDefault() (live-editor.js
// drives selection itself), which suppresses the click event entirely, so a
// click-based dismisser never fired for presses in the note body. A menu
// item's own click still lands (the menu contains the target). A right-click
// outside likewise dismisses (or is immediately replaced by the new menu).
document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideContextMenu();
}, true);
document.addEventListener('contextmenu', (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideContextMenu();
}, true);
window.addEventListener('blur', hideContextMenu);

document.getElementById('sidebar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.node-row');
  const node = row ? row.parentElement : null;
  if (!node) {
    showContextMenu(e.clientX, e.clientY, [{ label: 'Add workspace…', action: addWorkspace }]);
    return;
  }
  showContextMenu(e.clientX, e.clientY, menuForNode(node));
});

function menuForNode(node) {
  const items = [];
  if (node._isDir) {
    items.push(
      { label: 'New file…', action: () => createInDir(node, false) },
      { label: 'New folder…', action: () => createInDir(node, true) },
      { sep: true },
    );
  } else {
    items.push({ label: 'Open in new window', action: () => wm.openInNewWindow(node._path) }, { sep: true });
  }
  if (!node._isRoot) {
    items.push({ label: 'Rename…', action: () => renameNode(node) });
    items.push({ label: 'Duplicate', action: () => duplicateNode(node) });
    items.push({ label: 'Move to…', action: () => moveNodeTo(node) });
    items.push({ label: 'Copy to…', action: () => copyNodeTo(node) });
    items.push({ sep: true });
  }
  items.push({ label: 'Reveal in file manager', action: () => api.reveal(node._path) });
  items.push({ sep: true });
  if (node._isRoot) {
    items.push({ label: 'Remove workspace', danger: true, action: () => removeWorkspace(node) });
  } else {
    items.push({ label: 'Delete', danger: true, action: () => deleteNode(node) });
  }
  return items;
}

async function createInDir(node, isFolder) {
  const name = await promptName(isFolder ? 'New folder name' : 'New file name',
    isFolder ? '' : 'untitled.md');
  if (!name) return;
  const res = isFolder ? await api.createFolder(node._path, name)
                       : await api.createFile(node._path, name);
  if (res.error) { flash(res.error === 'exists' ? 'Already exists.' : 'Could not create.'); return; }
  await refreshNode(node);
  if (!isFolder && res.path) {
    const newRow = findRow(node, res.path);
    openFile(res.path, newRow);
  }
}

async function renameNode(node) {
  const name = await promptName('Rename', baseName(node._path));
  if (!name || name === baseName(node._path)) return;
  const oldPath = node._path;
  const res = await api.rename(oldPath, name);
  if (res.error) { flash(res.error === 'exists' ? 'Already exists.' : 'Could not rename.'); return; }
  const parent = parentNodeOf(node);
  if (parent) await refreshNode(parent);
  applyPathMove(oldPath, res.path); // re-point any open tab (this file or, for a folder, its notes)
}

const dirName = (p) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');

// Map move/copy error codes to friendly toasts.
function moveCopyError(code) {
  return ({
    exists: 'Already exists there.',
    'same-dir': 'Already in that folder.',
    'into-self': "Can't put a folder inside itself.",
  })[code] || 'Could not complete.';
}

// After a file/folder moved or was renamed from oldPath → newPath, re-point any
// open tab whose file was the item itself OR lived inside a moved folder, moving
// its external-edit watch with it. Mirrors the original rename fix-up but also
// handles a relocated folder subtree.
function applyPathMove(oldPath, newPath) {
  if (!oldPath || !newPath) return;
  let touched = false;
  for (const tab of tabs) {
    if (!tab.path) continue;
    let np = null;
    if (tab.path === oldPath) np = newPath;
    else if (tab.path.startsWith(oldPath + '/')) np = newPath + tab.path.slice(oldPath.length);
    if (!np) continue;
    api.unwatchFile(tab.path);
    api.watchFile(np);
    tab.path = np;
    tab.name = baseName(np);
    tab._row = findNodeByPath(np)?._row || null;
    if (tab.id === activeTabId) setActiveRow(tab._row);
    touched = true;
  }
  if (touched) renderTabs();
}

async function duplicateNode(node) {
  const res = await api.duplicate(node._path);
  if (res.error) { flash('Could not duplicate.'); return; }
  const parent = parentNodeOf(node);
  if (parent) await refreshNode(parent);
}

async function moveNodeTo(node) {
  const dest = await pickFolder('Move to…', node._path);
  if (!dest) return;
  await doMove(node._path, dest);
}

async function copyNodeTo(node) {
  const dest = await pickFolder('Copy to…', node._path);
  if (!dest) return;
  const res = await api.copy(node._path, dest);
  if (res.error) { flash(moveCopyError(res.error)); return; }
  const destNode = findNodeByPath(dest);
  if (destNode && destNode._loaded) await refreshNode(destNode);
}

// Move srcPath into destDir, then fix the tree (item leaves its old spot, appears
// in the destination if it's expanded) and re-point any open tab. Shared by the
// "Move to…" menu and tree drag-and-drop.
async function doMove(srcPath, destDir) {
  const res = await api.move(srcPath, destDir);
  if (res.error) { flash(moveCopyError(res.error)); return; }
  const srcNode = findNodeByPath(srcPath);
  const srcParent = srcNode ? parentNodeOf(srcNode) : null;
  if (srcParent) await refreshNode(srcParent);
  const destNode = findNodeByPath(destDir);
  if (destNode && destNode._loaded) await refreshNode(destNode);
  applyPathMove(srcPath, res.path);
}

async function deleteNode(node) {
  const ok = await confirmDialog(`Move "${baseName(node._path)}" to trash?`);
  if (!ok) return;
  const res = await api.trash(node._path);
  if (res.error) { flash('Could not delete.'); return; }
  closeTabByPath(node._path, true); // skip save — the file is gone, don't re-write it
  const parent = parentNodeOf(node);
  if (parent) await refreshNode(parent);
  else node.remove();
}

// Delete the file backing a tab (right-click → Delete file, #4). Reuse the tree
// delete when the file lives in an open workspace (it also refreshes the panel);
// otherwise trash + close the tab directly. Mirrors the sidebar's move-to-trash.
async function deleteTabFile(tab) {
  const node = tab.path ? findNodeByPath(tab.path) : null;
  if (node) { await deleteNode(node); return; }
  if (!tab.path) { closeTab(tab, true); return; } // never-saved buffer: just drop it
  const ok = await confirmDialog(`Move "${tab.name}" to trash?`);
  if (!ok) return;
  const res = await api.trash(tab.path);
  if (res.error) { flash('Could not delete.'); return; }
  closeTab(tab, true); // skip save — the file is gone
}

async function removeWorkspace(node) {
  await api.removeWorkspace(node._path);
  await loadWorkspaces();
}

// Find a freshly-created/renamed child row inside a node's children container.
function findRow(node, childPath) {
  for (const child of node._children.children) {
    if (child._path === childPath) return child._row;
  }
  return null;
}

// ---- tiny modal (Electron disables window.prompt) -----------------------
function promptName(message, initial = '') {
  return new Promise((resolve) => {
    const back = buildModal(message, true);
    const input = back.querySelector('.modal-input');
    input.value = initial;
    document.body.append(back);
    input.focus();
    const dot = initial.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot); else input.select();
    const done = (val) => { back.remove(); resolve(val); };
    back.querySelector('.modal-ok').onclick = () => done(input.value.trim() || null);
    back.querySelector('.modal-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    back.onclick = (e) => { if (e.target === back) done(null); };
  });
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const back = buildModal(message, false);
    document.body.append(back);
    back.querySelector('.modal-ok').focus();
    const done = (val) => { back.remove(); resolve(val); };
    back.querySelector('.modal-ok').onclick = () => done(true);
    back.querySelector('.modal-cancel').onclick = () => done(false);
    back.onclick = (e) => { if (e.target === back) done(false); };
    back.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
  });
}

function buildModal(message, withInput) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.tabIndex = -1;
  back.innerHTML =
    '<div class="modal">' +
    '<div class="modal-msg"></div>' +
    (withInput ? '<input class="modal-input" type="text" spellcheck="false">' : '') +
    '<div class="modal-row">' +
    '<button class="modal-cancel">Cancel</button>' +
    '<button class="modal-ok">OK</button>' +
    '</div></div>';
  back.querySelector('.modal-msg').textContent = message;
  return back;
}

// In-app destination picker for "Move to…" / "Copy to…". Resolves to a chosen
// directory path, or null if cancelled. Shows the workspace folders as a
// folder-only, lazily-expanded tree; the source item (excludePath) and its
// subtree are disabled so you can't move/copy something into itself.
function pickFolder(title, excludePath = null) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.tabIndex = -1;
    back.innerHTML =
      '<div class="modal modal--picker">' +
      '<div class="modal-msg"></div>' +
      '<div class="modal-tree"></div>' +
      '<div class="modal-row">' +
      '<button class="modal-cancel">Cancel</button>' +
      '<button class="modal-ok" disabled>OK</button>' +
      '</div></div>';
    back.querySelector('.modal-msg').textContent = title;
    const treeEl = back.querySelector('.modal-tree');
    const okBtn = back.querySelector('.modal-ok');
    document.body.append(back);

    let selected = null;       // chosen dir path, or null
    let selectedRow = null;
    const done = (val) => { back.remove(); resolve(val); };
    const isExcluded = (p) => excludePath && (p === excludePath || p.startsWith(excludePath + '/'));

    function select(row, p) {
      if (selectedRow) selectedRow.classList.remove('selected');
      selectedRow = row; selected = p;
      row.classList.add('selected');
      okBtn.disabled = false;
    }

    // One folder row (chevron + icon + label) plus its lazily-filled children box.
    function makeFolderRow(entry, depth) {
      const wrap = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'picker-row' + (isExcluded(entry.path) ? ' disabled' : '');
      row.style.paddingLeft = (8 + depth * 17) + 'px';

      const chev = document.createElement('span');
      chev.className = 'chevron';
      chev.textContent = '▶';
      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.innerHTML = FOLDER_SVG;
      const label = document.createElement('span');
      label.className = 'node-label';
      const txt = document.createElement('span');
      txt.className = 'node-label-text';
      txt.textContent = entry.name;
      label.append(txt);
      row.append(chev, icon, label);

      const kids = document.createElement('div');
      kids.hidden = true;
      let loaded = false, open = false;
      async function toggle() {
        if (open) { kids.hidden = true; open = false; chev.classList.remove('open'); icon.innerHTML = FOLDER_SVG; return; }
        chev.classList.add('open'); icon.innerHTML = FOLDER_OPEN_SVG;
        if (!loaded) {
          const res = await api.readDir(entry.path);
          kids.innerHTML = '';
          if (!res.error) for (const it of res.items) if (it.isDir) kids.append(makeFolderRow(it, depth + 1));
          loaded = true;
        }
        kids.hidden = false; open = true;
      }
      chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      if (!isExcluded(entry.path)) {
        row.addEventListener('click', () => select(row, entry.path));
        row.addEventListener('dblclick', () => { select(row, entry.path); done(entry.path); });
      }
      wrap.append(row, kids);
      return wrap;
    }

    (async () => {
      const list = await api.listWorkspaces();
      for (const ws of list) treeEl.append(makeFolderRow({ name: ws.name, path: ws.path }, 0));
    })();

    okBtn.onclick = () => { if (selected) done(selected); };
    back.querySelector('.modal-cancel').onclick = () => done(null);
    back.onclick = (e) => { if (e.target === back) done(null); };
    back.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && selected) { e.preventDefault(); done(selected); }
    };
    back.focus();
  });
}

// ---- misc ---------------------------------------------------------------
function baseName(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }

let flashTimer = null;
function flash(msg) {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// Suppress hover styling until the mouse actually moves (matches res apps).
window.addEventListener('mousemove', function clearNoHover() {
  document.body.classList.remove('no-hover');
  window.removeEventListener('mousemove', clearNoHover);
});

// ---- update banner --------------------------------------------------------
// Main checked GitHub and found a newer release: a small non-modal banner in
// the bottom-right offers Update (download + open the installer, with
// progress), Skip this version (mutes that version), or × (hide for now —
// re-offered on the next 4-hourly check). Hidden in sticky mode by CSS.
let updateBanner = null;
function hideUpdateBanner() { if (updateBanner) { updateBanner.remove(); updateBanner = null; } }

window.updates.onAvailable(({ version, htmlUrl }) => {
  hideUpdateBanner();
  const el = document.createElement('div');
  el.id = 'update-banner';
  const msg = document.createElement('span');
  msg.className = 'update-msg';
  msg.textContent = `Notation v${version} is available`;
  const update = document.createElement('button');
  update.className = 'update-go';
  update.textContent = 'Update';
  update.addEventListener('click', async () => {
    update.disabled = true;
    update.textContent = 'Downloading…';
    const res = await window.updates.download();
    if (res && res.error) {
      // Couldn't download/open the installer here — hand off to the releases page.
      update.disabled = false;
      update.textContent = 'Open releases page';
      update.onclick = () => api.openExternal(htmlUrl);
      flash('Update failed: ' + res.error);
    } else {
      hideUpdateBanner();
      if (wm.platform !== 'win32') flash('Installer opened — quit Notation to finish updating.');
    }
  });
  const skip = document.createElement('button');
  skip.className = 'update-skip';
  skip.textContent = 'Skip this version';
  skip.addEventListener('click', () => window.updates.skip(version));
  const close = document.createElement('button');
  close.className = 'update-close';
  close.title = 'Dismiss';
  close.innerHTML = TAB_CLOSE_SVG;
  close.addEventListener('click', hideUpdateBanner);
  el.append(msg, update, skip, close);
  document.body.append(el);
  updateBanner = el;
});
window.updates.onProgress(({ percent }) => {
  const btn = updateBanner && updateBanner.querySelector('.update-go');
  if (btn && btn.disabled) btn.textContent = `Downloading… ${percent}%`;
});
window.updates.onDismissed(hideUpdateBanner);

// ---- boot ---------------------------------------------------------------
function initialFileFromHash() {
  const m = location.hash.match(/file=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Rebuild this window from its saved session descriptor (tabs, active tab,
// sidebar + sticky state). Falls back to the single-file hash (detach / open-in-
// new-window) and finally to the empty state.
async function boot() {
  await loadWorkspaces();
  let restored = false;
  booting = true; // don't unfold the tree for every restored tab
  try {
    const r = await wm.session.getRestore();
    if (r && Array.isArray(r.tabs) && r.tabs.length) {
      for (const p of r.tabs) await openFile(p, findRowByPath(p));
      // Re-flag pins from the saved snapshot (the descriptor lists pinned tabs
      // first, so the restored order already keeps the pinned group at the left).
      const pinnedPaths = new Set(
        r.tabs.filter((_, i) => Array.isArray(r.pinned) && r.pinned[i]));
      for (const t of tabs) if (t.path && pinnedPaths.has(t.path)) t.pinned = true;
      if (tabs.length) {
        const idx = Number.isInteger(r.activeIndex) ? r.activeIndex : 0;
        const target = tabs[idx] || tabs[tabs.length - 1];
        if (target) await activateTab(target);
        restored = true;
      }
      if (r.sidebarCollapsed) document.body.classList.add('sidebar-collapsed');
      if (r.sticky) { document.body.classList.add('sticky-mode'); updateStickyTitle(); refreshStickyColor(); }
    }
  } catch {}
  booting = false;
  if (!restored) {
    const f = initialFileFromHash();
    if (f) await openFile(f, findRowByPath(f));
  } else {
    const t = activeTab();
    if (t) revealInTree(t.path); // show just the active note's folder
  }
  renderTabs(); // reflect the restored pin flags (pushpin + left grouping)
}
boot();

// The OS asked us to open a file (file association / a second launch naming a
// path): main routed it to this window.
wm.onOpenPath(({ path }) => { if (path) openFile(path, findRowByPath(path)); });
