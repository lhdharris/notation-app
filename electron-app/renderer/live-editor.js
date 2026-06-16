'use strict';

// ---- live-preview editor (per-line) -------------------------------------
// Every source line is its own always-rendered element (.ln). Inactive lines show
// the rendered look (markers gone, bullets/checkboxes/quote-borders applied) via
// window.renderInline; the single line the caret sits on is the only editable one
// and shows its raw markdown with the markers dimmed (window.highlightInline keeps
// every character verbatim, so the element's textContent equals the source line — a
// 1:1 caret-offset mapping). Because each .ln's box height is fixed by its block
// class and is identical whether or not it is the active line, moving the caret
// between lines never reflows the document vertically.
//
// Multi-line constructs (fenced code / mermaid-gantt / GFM tables) are "block
// regions": rendered whole with window.renderMarkdown when inactive, and edited as
// one <textarea> when clicked (the only place a click can shift layout — rare).
//
// One instance backs both the main editor and the shrunken sticky note.

window.createLiveEditor = function createLiveEditor(container, opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const onOpenLink = typeof opts.onOpenLink === 'function' ? opts.onOpenLink : () => {};
  const onContextMenu = typeof opts.onContextMenu === 'function' ? opts.onContextMenu : null;

  let lines = [''];
  let active = -1;         // active source-line index, or -1 (fully rendered, nothing active)
  let activeEnd = 0;       // exclusive end of the active unit (active+1 for a line; the whole
                           //   span for a block region)
  let blockMode = false;   // true when the active unit is a block region (edited in a <textarea>)
  let pendingCaret = null; // caret column to apply after the next renderAll
  let pendingClick = null; // {x,y} of a click to map to a caret column after renderAll
  let ta = null;           // the active editor element (a .ln contenteditable, or a region <textarea>)
  let composing = false;   // mid-IME-composition (don't re-highlight then)
  let lastCaretCol = 0;    // last known caret column in the active editor
  let goalX = null;        // desired caret viewport-x for a run of consecutive ArrowUp/Down
                           //   presses (kept across the new editor activate() builds when
                           //   crossing source lines), so vertical motion never drifts
                           //   horizontally; reset by any non-vertical action
  let drag = null;         // a pending text-surface gesture (resolved click vs drag on mouseup)

  // ---- undo / redo history ----------------------------------------------
  // The native contenteditable undo only spans the single active line and is wiped
  // on every re-render, so we keep our own document-level stacks. Each entry is a
  // {lines, active, caret} snapshot of the state *before* a change. A run of plain
  // typing on one line coalesces into a single undo step (HISTORY_COALESCE_MS).
  const HISTORY_COALESCE_MS = 450;
  const HISTORY_LIMIT = 300;
  let undoStack = [];
  let redoStack = [];
  let restoring = false;   // true while applying a snapshot (suppresses recording)
  let lastEditKind = null; // groups a typing burst into one undo step
  let lastEditLine = -1;
  let lastEditAt = 0;

  // ---- helpers ----------------------------------------------------------
  const isTaskLine = (ln) => /^\s*([-*+]|\d+[.)])\s+\[([ xX])\]/.test(ln);
  const docText = () => lines.join('\n');
  // Reference-link / footnote definitions are document-wide state: collect them
  // on every change so per-line renderInline can resolve [label][id] / [^id].
  function refreshRefs() {
    if (window.collectMarkdownRefs && window.setMarkdownRefs) {
      window.setMarkdownRefs(window.collectMarkdownRefs(lines));
    }
  }
  function commit() { refreshRefs(); onChange(); }
  const clampLine = (i) => Math.max(0, Math.min(i, lines.length - 1));

  // The block role of a single source line + the length of its leading marker.
  function lineKind(line) {
    if (/^\s*$/.test(line)) return { type: 'blank', markEnd: 0, indent: 0 };
    if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) return { type: 'hr', markEnd: 0, indent: 0 };
    const h = /^( {0,3})(#{1,6})(\s+)/.exec(line);
    if (h) return { type: 'heading', level: h[2].length, markEnd: h[0].length, indent: 0 };
    if (/^ {0,3}>/.test(line)) {
      const q = /^(\s*)((?:>\s?)+)/.exec(line);
      return { type: 'quote', markEnd: q[0].length, indent: 0 };
    }
    const lm = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/.exec(line);
    if (lm) {
      const indent = lm[1].length;
      const ordered = /\d/.test(lm[2]);
      if (lm[4]) return { type: 'task', indent, ordered, checked: /[xX]/.test(lm[4]), number: lm[2], markEnd: lm[0].length };
      return { type: ordered ? 'ol' : 'ul', indent, ordered, number: lm[2], markEnd: (lm[1] + lm[2] + lm[3]).length };
    }
    if (window.isRefDefLine && window.isRefDefLine(line)) return { type: 'refdef', markEnd: 0, indent: 0 };
    return { type: 'paragraph', markEnd: 0, indent: 0 };
  }

  // Contextual line kind: setext headings are the one construct where a line's
  // role depends on its neighbour — a plain text line underlined with === (h1)
  // or --- (h2) is a heading, and the underline itself is a marker line (taking
  // precedence over its hr reading). Everything else is lineKind's answer.
  const SETEXT_RE = /^ {0,3}(=+|-{2,})\s*$/;
  function setextLevelAt(i) {
    if (i < 0 || i + 1 >= lines.length || !SETEXT_RE.test(lines[i + 1])) return 0;
    if (!lines[i].trim() || lineKind(lines[i]).type !== 'paragraph') return 0;
    return lines[i + 1].trim()[0] === '=' ? 1 : 2;
  }
  function lineKindAt(i) {
    const lvl = setextLevelAt(i);
    if (lvl) return { type: 'heading', level: lvl, markEnd: 0, indent: 0, setext: true };
    if (SETEXT_RE.test(lines[i]) && setextLevelAt(i - 1)) return { type: 'setext-under', markEnd: 0, indent: 0 };
    return lineKind(lines[i]);
  }

  function lnClass(k) {
    switch (k.type) {
      case 'blank':   return 'ln ln-blank';
      case 'hr':      return 'ln ln-hr';
      case 'heading': return 'ln ln-h' + k.level;
      case 'quote':   return 'ln ln-quote';
      case 'task':    return 'ln ln-li ln-task';
      case 'ul':      return 'ln ln-li ln-ul';
      case 'ol':      return 'ln ln-li ln-ol';
      case 'setext-under': return 'ln ln-setext';
      case 'refdef':  return 'ln ln-p ln-refdef';
      default:        return 'ln ln-p';
    }
  }

  const spaces = (n) => ' '.repeat(Math.max(0, n));
  const checkboxHtml = (checked) => '<input type="checkbox" class="task-checkbox"' + (checked ? ' checked' : '') + '>';

  // ---- block-region segmentation ----------------------------------------
  // A unit is either a single line or a multi-line region (a fenced code/mermaid
  // block, or a GFM table) edited whole. regionStartingAt returns the region whose
  // first line is `i`, regionAt returns the region that *contains* line `i`.
  function regionStartingAt(i) {
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const mark = fence[1][0];
      let k = i + 1;
      while (k < lines.length && !(/^\s*(`{3,}|~{3,})\s*$/.test(lines[k]) && lines[k].trim()[0] === mark)) k++;
      if (k < lines.length) k++; // include the closing fence
      return { start: i, end: k, type: 'code' };
    }
    // display math: $$...$$ on one line, or $$ ... a line ending in $$ (an
    // unclosed opener runs to EOF, like an unclosed fence). Edited as the raw
    // region <textarea>, same as code.
    if (/^\s*\$\$/.test(lines[i])) {
      const rest = lines[i].replace(/^\s*\$\$/, '');
      if (rest.trim() && /\$\$\s*$/.test(rest)) return { start: i, end: i + 1, type: 'math' };
      let k = i + 1;
      while (k < lines.length && !/\$\$\s*$/.test(lines[k])) k++;
      if (k < lines.length) k++; // include the closing $$ line
      return { start: i, end: k, type: 'math' };
    }
    if (lines[i].includes('|') && i + 1 < lines.length &&
        /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      let k = i + 2;
      while (k < lines.length && lines[k].includes('|') && !/^\s*$/.test(lines[k])) k++;
      return { start: i, end: k, type: 'table' };
    }
    return null;
  }
  function regionAt(i) {
    let j = 0;
    while (j <= i && j < lines.length) {
      const reg = regionStartingAt(j);
      if (reg) { if (i < reg.end) return reg; j = reg.end; }
      else j++;
    }
    return null;
  }

  // ---- per-line element builders ----------------------------------------
  // Inactive line: the rendered look. Its leading block marker is stripped and the
  // remainder rendered with window.renderInline (no markers); the bullet / number /
  // checkbox / quote-border come from the element. Nesting is the line's own leading
  // spaces, kept verbatim and shown by white-space: pre-wrap.
  function makeInactiveLine(i) {
    const line = lines[i];
    const k = lineKindAt(i);
    const el = document.createElement('div');
    el.className = lnClass(k);
    el.dataset.i = String(i);
    let html;
    // list/task lines are split into a leading gutter (nesting spaces + bullet/number/
    // checkbox) and a body (the rendered content). CSS lays them out with flexbox so a
    // wrapped body row hangs under the body's first character, not under the marker.
    const gutterBody = (marker, content) =>
      '<span class="ln-gutter">' + spaces(k.indent) + marker + '</span>' +
      '<span class="ln-body">' + (window.renderInline(content) || '') + '</span>';
    if (k.type === 'blank') html = '<br>';
    else if (k.type === 'hr') html = '';
    // The setext underline and ref/footnote definition lines keep their raw
    // text (dimmed via CSS) — textContent must equal the source line, and the
    // box height must match the active form, so no font-size games here.
    else if (k.type === 'setext-under' || k.type === 'refdef') html = window.highlightInline(line) || '<br>';
    else if (k.type === 'heading') html = window.renderInline(line.slice(k.markEnd)) || '<br>';
    else if (k.type === 'quote') html = window.renderInline(line.replace(/^(\s*)((?:>\s?)+)/, '')) || '<br>';
    else if (k.type === 'task') html = gutterBody(checkboxHtml(k.checked), line.slice(k.markEnd));
    else if (k.type === 'ul') html = gutterBody('<span class="ln-bul">•</span> ', line.slice(k.markEnd));
    else if (k.type === 'ol') html = gutterBody('<span class="ln-num">' + k.number + '</span> ', line.slice(k.markEnd));
    else html = window.renderInline(line) || '<br>';
    el.innerHTML = html;
    return el;
  }

  // Active line: raw markdown with markers dimmed; same block class & box as the
  // inactive form, so swapping one for the other never changes the line's height.
  function makeActiveLine(i) {
    const k = lineKindAt(i);
    const el = document.createElement('div');
    el.className = lnClass(k) + ' ln-active';
    el.dataset.i = String(i);
    el.contentEditable = 'true';
    el.spellcheck = false;
    setActiveHtml(el, lines[i]);
    el.addEventListener('input', onActiveInput);
    el.addEventListener('keydown', onActiveKeydown);
    el.addEventListener('blur', onActiveBlur);
    el.addEventListener('paste', onActivePaste);
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; onActiveInput(); });
    el.addEventListener('keyup', trackCaret);
    el.addEventListener('mouseup', trackCaret);
    return el;
  }

  function setActiveHtml(el, raw) {
    el.innerHTML = window.highlightInline(raw) || '<br>';
  }

  // Block region (code/gantt/table) rendered whole, and its raw <textarea> editor.
  function makeRegion(reg) {
    const el = document.createElement('div');
    el.className = 'ln-region markdown-body';
    el.dataset.start = String(reg.start);
    el.dataset.end = String(reg.end);
    el.innerHTML = window.renderMarkdown(lines.slice(reg.start, reg.end).join('\n'));
    return el;
  }
  function makeRegionEditor(reg) {
    const t = document.createElement('textarea');
    t.className = 'ln-region-edit';
    t.spellcheck = false;
    t.setAttribute('wrap', 'off');
    t.value = lines.slice(reg.start, reg.end).join('\n');
    t.addEventListener('input', onCodeInput);
    t.addEventListener('keydown', onCodeKeydown);
    t.addEventListener('blur', onActiveBlur);
    t.addEventListener('keyup', trackCodeCaret);
    t.addEventListener('mouseup', trackCodeCaret);
    return t;
  }

  function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

  // ---- caret helpers (operate on the active contenteditable) ------------
  // Offsets are raw-string columns; the active editor keeps markers verbatim so its
  // textContent equals the source line, making a character offset == a source column.
  function getSelectionOffsets(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return { start: 0, end: 0 };
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    return { start, end: start + range.toString().length };
  }
  function getCaretOffset(el) { return getSelectionOffsets(el).end; }
  // True when a non-collapsed selection reaches past the active line into other
  // rendered lines (a cross-line drag / Shift selection). getSelectionOffsets clamps
  // such a selection to {0,0} within the active line, so the per-line key handlers
  // must defer to the document-level cross-line handler rather than act on it.
  function selectionEscapesActive() {
    if (!ta) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    return !(ta.contains(range.startContainer) && ta.contains(range.endContainer));
  }
  function setCaretOffset(el, offset) {
    const sel = window.getSelection();
    const range = document.createRange();
    let remaining = Math.max(0, offset);
    let target = null, targetOffset = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (remaining <= len) { target = n; targetOffset = remaining; break; }
      remaining -= len;
    }
    if (target) range.setStart(target, targetOffset);
    else range.selectNodeContents(el);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function setSelectionOffsets(el, s, e) {
    const find = (offset) => {
      let remaining = Math.max(0, offset);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n, last = null;
      while ((n = walker.nextNode())) {
        last = n;
        if (remaining <= n.nodeValue.length) return { node: n, off: remaining };
        remaining -= n.nodeValue.length;
      }
      return last ? { node: last, off: last.nodeValue.length } : null;
    };
    const a = find(s), b = find(e);
    const sel = window.getSelection();
    const range = document.createRange();
    if (a) range.setStart(a.node, a.off); else range.selectNodeContents(el);
    if (b) range.setEnd(b.node, b.off); else if (a) range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function caretColFromPoint(el, x, y) {
    let r = document.caretRangeFromPoint(x, y);
    if (!r || !el.contains(r.startContainer)) {
      const b = el.getBoundingClientRect();
      r = document.caretRangeFromPoint(Math.min(Math.max(x, b.left + 1), b.right - 1), b.top + b.height / 2);
    }
    if (!r || !el.contains(r.startContainer)) return null;
    const pre = r.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }
  function trackCaret() { if (ta && !blockMode) lastCaretCol = getCaretOffset(ta); }
  function trackCodeCaret() { if (ta && blockMode) lastCaretCol = ta.selectionEnd; }

  // ---- undo / redo ------------------------------------------------------
  function currentCaret() {
    if (!ta) return null;
    return blockMode ? ta.selectionEnd
      : (document.activeElement === ta ? getCaretOffset(ta) : lastCaretCol);
  }
  function snapshot() { return { lines: lines.slice(), active, caret: currentCaret() }; }

  // Record the state *before* a mutation so Ctrl+Z can return to it. Call this
  // before touching `lines`. `kind` controls coalescing: consecutive same-kind
  // 'type…' edits on the same line within the window collapse into one step;
  // any structural edit ('struct') is always its own step.
  function recordHistory(kind) {
    if (restoring) return;
    const now = Date.now();
    const coalesce = kind === lastEditKind && /^type/.test(kind) &&
                     active === lastEditLine && (now - lastEditAt) < HISTORY_COALESCE_MS;
    lastEditAt = now; lastEditKind = kind; lastEditLine = active;
    if (coalesce) return;
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function applySnapshot(s) {
    restoring = true;
    lines = s.lines.slice();
    if (lines.length === 0) lines = [''];
    pendingCaret = s.caret;
    renderAll(s.active >= 0 ? clampLine(s.active) : -1);
    commit();
    restoring = false;
    goalX = null;
    lastEditKind = null; // the next edit starts a fresh burst
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
  }
  function clearHistory() {
    undoStack = []; redoStack = [];
    lastEditKind = null; lastEditLine = -1; lastEditAt = 0;
  }

  // ---- line-editing commands (operate on the active single line) --------
  // Move the active line up/down by one, carrying the caret with it.
  function moveLineBy(dir) {
    const j = active + dir;
    if (active < 0 || j < 0 || j >= lines.length) return;
    recordHistory('struct');
    const col = getCaretOffset(ta);
    const cur = lines[active];
    lines[active] = lines[j];
    lines[j] = cur;
    renumberListBlock(j);
    pendingCaret = col; goalX = null; commit(); renderAll(j);
  }
  // Duplicate the active line; the caret lands on the copy in the given direction.
  function duplicateLineBy(dir) {
    if (active < 0) return;
    recordHistory('struct');
    const col = getCaretOffset(ta);
    const copy = lines[active];
    const at = dir < 0 ? active : active + 1;
    lines.splice(at, 0, copy);
    pendingCaret = col; goalX = null; commit(); renderAll(at);
  }
  // Delete the whole active line (Ctrl+Shift+K); collapse to one blank if it's the
  // only line. `silent` skips the history push (the cut command records its own).
  function deleteCurrentLine(silent) {
    if (active < 0) return;
    if (!silent) recordHistory('struct');
    const col = getCaretOffset(ta);
    if (lines.length === 1) { lines[0] = ''; pendingCaret = 0; goalX = null; commit(); renderAll(0); return; }
    lines.splice(active, 1);
    const target = clampLine(active);
    renumberListBlock(target);
    pendingCaret = Math.min(col, lines[target].length);
    goalX = null; commit(); renderAll(target);
  }
  function writeClipboard(text) {
    if (window.api && typeof window.api.clipboardWrite === 'function') window.api.clipboardWrite(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  }
  // Copy / cut the whole active line (incl. its newline, so a paste lands on its
  // own line) — the familiar no-selection behaviour of Ctrl+C / Ctrl+X.
  function copyCurrentLine() {
    if (active < 0) return;
    writeClipboard(lines[active] + '\n');
  }
  function cutCurrentLine() {
    if (active < 0) return;
    writeClipboard(lines[active] + '\n');
    recordHistory('struct');
    deleteCurrentLine(true);
  }

  // ---- formatting commands (Ctrl+B/I and the format bar) -----------------
  // Wrap the active line's selection in an inline marker pair (or insert empty
  // markers with the caret between); repeating with the same marker toggles off.
  function wrapInline(m) {
    if (active < 0 || blockMode || !ta) return;
    recordHistory('struct');
    const value = ta.textContent;
    const { start, end } = getSelectionOffsets(ta);
    const inner = value.slice(start, end);
    // Toggle off whether the markers sit just outside the selection or were
    // swept up inside it (e.g. the whole "**word**" selected).
    const wrapped = value.slice(start - m.length, start) === m && value.slice(end, end + m.length) === m;
    const innerWrapped = !wrapped && inner.length >= m.length * 2 && inner.startsWith(m) && inner.endsWith(m);
    let next, selS, selE;
    if (wrapped) {
      next = value.slice(0, start - m.length) + inner + value.slice(end + m.length);
      selS = start - m.length; selE = end - m.length;
    } else if (innerWrapped) {
      next = value.slice(0, start) + inner.slice(m.length, inner.length - m.length) + value.slice(end);
      selS = start; selE = end - m.length * 2;
    } else {
      next = value.slice(0, start) + m + inner + m + value.slice(end);
      selS = start + m.length; selE = end + m.length;
    }
    lines[active] = next;
    setActiveHtml(ta, next);
    ta.focus();
    setSelectionOffsets(ta, selS, selE);
    lastCaretCol = selE;
    commit();
  }

  // Toggle the active line's block marker: h1/h2/h3 replace any current marker
  // (the same level toggles back to a paragraph); ul/ol/task/quote toggle their
  // prefix, converting between kinds in place.
  function setLineMarker(kind) {
    if (active < 0 || blockMode || !ta) return;
    recordHistory('struct');
    const value = ta.textContent;
    const caret = document.activeElement === ta ? getCaretOffset(ta) : lastCaretCol;
    const k = lineKind(value);
    const indent = spaces(k.indent || 0);
    const body = value.slice(k.markEnd);
    const H = { h1: 1, h2: 2, h3: 3 }[kind];
    let next;
    if (H) next = (k.type === 'heading' && k.level === H) ? body : '#'.repeat(H) + ' ' + body;
    else if (kind === 'quote') next = k.type === 'quote' ? body : '> ' + value;
    else if (kind === 'ul')    next = k.type === 'ul'   ? indent + body : indent + '- ' + body;
    else if (kind === 'ol')    next = k.type === 'ol'   ? indent + body : indent + '1. ' + body;
    else if (kind === 'task')  next = k.type === 'task' ? indent + body : indent + '- [ ] ' + body;
    else return;
    lines[active] = next;
    renumberListBlock(active);
    pendingCaret = Math.max(0, Math.min(next.length, caret + (next.length - value.length)));
    goalX = null; commit(); renderAll(active);
  }

  // Wrap the selection as [selection](url) with the "url" placeholder selected
  // (typing replaces it); a collapsed caret gets the empty-label skeleton.
  function insertLink() {
    if (active < 0 || blockMode || !ta) return;
    recordHistory('struct');
    const value = ta.textContent;
    const { start, end } = getSelectionOffsets(ta);
    const inner = value.slice(start, end);
    const next = value.slice(0, start) + '[' + inner + '](url)' + value.slice(end);
    lines[active] = next;
    setActiveHtml(ta, next);
    ta.focus();
    const s = start + inner.length + 3; // start of the "url" placeholder
    setSelectionOffsets(ta, s, s + 3);
    lastCaretCol = s + 3;
    commit();
  }

  // Insert a markdown footnote: drop a [^N] reference at the caret and append a
  // matching "[^N]: " definition at the foot of the document, leaving the caret in
  // the definition to type the note text. N auto-increments past any existing
  // footnote so references stay unique; definitions group together at the bottom.
  function insertFootnote() {
    if (active < 0 || blockMode || !ta) return;
    recordHistory('struct');
    let max = 0;
    for (const ln of lines) {
      const re = /\[\^(\d+)\]/g;
      let m;
      while ((m = re.exec(ln))) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
    const id = max + 1;
    const value = ta.textContent;
    const { start, end } = getSelectionOffsets(ta);
    lines[active] = value.slice(0, start) + '[^' + id + ']' + value.slice(end);
    const def = '[^' + id + ']: ';
    const NOTE_DEF = /^ {0,3}\[\^[^\]]+\]:\s/;
    let lastDef = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if (NOTE_DEF.test(lines[i])) { lastDef = i; break; } }
    let defLine;
    if (lastDef >= 0) {
      lines.splice(lastDef + 1, 0, def);
      defLine = lastDef + 1;
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', def);
      defLine = lines.length - 1;
    }
    pendingCaret = def.length; goalX = null; commit(); renderAll(defLine);
  }

  // Insert a block construct on its own lines below the active line (replacing
  // it when it's blank): table → a 2×2 skeleton opened in the cell editor;
  // codeblock → a fence pair with the caret inside; hr → a "---" line.
  function insertBlock(kind) {
    if (active < 0 || blockMode || tedit) return;
    recordHistory('struct');
    const blank = !lines[active].trim();
    const at = blank ? active : active + 1;
    const remove = blank ? 1 : 0;
    if (kind === 'hr') {
      lines.splice(at, remove, '---', '');
      pendingCaret = 0; goalX = null; commit(); renderAll(at + 1);
    } else if (kind === 'codeblock') {
      lines.splice(at, remove, '```', '', '```');
      pendingCaret = 4; // just past "```\n" — the blank middle line of the region editor
      goalX = null; commit(); renderAll(at + 1);
    } else if (kind === 'table') {
      lines.splice(at, remove, '|  |  |', '| --- | --- |', '|  |  |', '');
      commit(); renderAll(-1);
      const reg = regionStartingAt(at);
      if (reg && reg.type === 'table') openTableEditor(reg, { r: 0, c: 0 });
    }
  }

  // The format bar can fire with no line active (fresh load, after Escape):
  // activate the end of the document first, like clicking below the text.
  function ensureActive() {
    if (active < 0 && !tedit) activate(lines.length - 1, Infinity);
    return active >= 0 && !blockMode && !tedit;
  }

  // ---- smart structure typing -------------------------------------------
  // One indent level for nested lists. parseList (markdown.js) nests on any
  // deeper indent, so two spaces is enough and keeps lines compact.
  const INDENT = '  ';

  // The marker prefix the *next* item gets when Enter continues this line:
  // same indent + same bullet/delimiter (number bumped, task box emptied), or
  // the exact quote-marker run. Null when the line isn't a continuable block.
  function continuationPrefix(line) {
    const q = /^(\s*)((?:>\s?)+)/.exec(line);
    if (q) return q[1] + q[2];
    const m = /^(\s*)(?:(\d+)([.)])|([-*+]))(\s+)(\[[ xX]\]\s+)?/.exec(line);
    if (!m) return null;
    const marker = m[2] != null ? (parseInt(m[2], 10) + 1) + m[3] : m[4];
    return m[1] + marker + m[5] + (m[6] ? '[ ] ' : '');
  }

  // Renumber every ordered item in the contiguous list block around line `i`,
  // one counter per indent level. Deeper counters reset when the walk returns
  // to a shallower item; a bullet item restarts its level's numbering (parseList
  // treats a marker-type switch as a new list). Mutates `lines` only — callers
  // re-render afterwards.
  function renumberListBlock(i) {
    const item = (j) => /^(\s*)(?:(\d+)([.)])|[-*+])\s+/.exec(lines[j] || '');
    if (!item(i)) return;
    let s = i; while (s > 0 && item(s - 1)) s--;
    let last = i; while (last + 1 < lines.length && item(last + 1)) last++;
    const counters = new Map(); // indent -> last number issued
    for (let j = s; j <= last; j++) {
      const m = item(j);
      const ind = m[1].length;
      for (const key of [...counters.keys()]) if (key > ind) counters.delete(key);
      if (m[2] == null) { counters.set(ind, 0); continue; }
      const n = (counters.get(ind) || 0) + 1;
      counters.set(ind, n);
      if (String(n) !== m[2]) lines[j] = lines[j].replace(/^(\s*)\d+([.)])/, (_, sp, d) => sp + n + d);
    }
  }

  // Live-preview Enter on the active line. Returns true when handled:
  // an unclosed ``` fence auto-closes into a code block, a list/task/quote
  // line continues its marker onto the new line, and Enter on an *empty*
  // item exits the list (outdenting one level first when nested).
  function smartEnter(value, start, end) {
    if (active < 0 || blockMode) return false;
    // Fence auto-close: Enter at the end of an opening ``` line whose region
    // never closes (regionStartingAt ran to EOF without a bare closing fence).
    if (start === value.length && end === start) {
      const reg = regionAt(active);
      if (reg && reg.type === 'code' && reg.start === active &&
          !(reg.end - 1 > reg.start && /^\s*(`{3,}|~{3,})\s*$/.test(lines[reg.end - 1]))) {
        recordHistory('struct');
        const f = /^(\s*)(`{3,}|~{3,})/.exec(value);
        lines.splice(active + 1, 0, '', f[1] + f[2]);
        pendingCaret = value.length + 1; // the blank middle line, inside the region editor
        goalX = null; commit(); renderAll(active + 1);
        return true;
      }
    }
    const k = lineKind(value);
    const listish = k.type === 'ul' || k.type === 'ol' || k.type === 'task' || k.type === 'quote';
    if (!listish || start < k.markEnd) return false;
    if (!value.slice(k.markEnd).trim() && end === value.length) {
      recordHistory('struct');
      if (k.indent > 0) {
        const strip = Math.min(INDENT.length, k.indent);
        lines[active] = value.slice(strip);
        renumberListBlock(active);
        pendingCaret = Math.max(0, start - strip);
      } else {
        lines[active] = '';
        pendingCaret = 0;
      }
      goalX = null; commit(); renderAll(active);
      return true;
    }
    const prefix = continuationPrefix(value);
    if (prefix == null) return false;
    recordHistory('struct');
    lines.splice(active, 1, value.slice(0, start), prefix + value.slice(end));
    const target = active + 1;
    renumberListBlock(target);
    pendingCaret = prefix.length;
    goalX = null; commit(); renderAll(target);
    return true;
  }

  // Map a viewport point to a Selection boundary {node, offset}, working from *any*
  // point — over a textless blank line, the bullet/number gutter, an hr, or the side
  // padding — so a drag can anchor/extend anywhere (the native hit-test can't). Prefer
  // the exact caret under the point; otherwise snap to the nearest line's start/end.
  function pointToCaret(x, y) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) {
      // Accept the hit only if it landed *inside a line*. For a point in a margin gap or
      // padding (e.g. a heading's top margin) caretRangeFromPoint returns the container
      // element itself — container.contains() passes, but it isn't a line position, so fall
      // through to the nearest-line search below rather than anchoring on nothing (which
      // made anchorLineEl null → a click there bounce to the last line of the file).
      const host = r.startContainer.nodeType === Node.TEXT_NODE
        ? r.startContainer.parentNode : r.startContainer;
      if (host && host.closest && host.closest('.ln, .ln-region')) {
        return { node: r.startContainer, offset: r.startOffset };
      }
    }
    const els = container.querySelectorAll('.ln, .ln-region');
    if (!els.length) return null;
    let best = null, bestDist = Infinity;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      const dist = y < b.top ? b.top - y : (y > b.bottom ? y - b.bottom : 0);
      if (dist < bestDist) { bestDist = dist; best = el; if (dist === 0) break; }
    }
    if (!best) return null;
    const b = best.getBoundingClientRect();
    const atEnd = y > b.bottom || (y >= b.top && x > b.left + b.width / 2);
    const walker = document.createTreeWalker(best, NodeFilter.SHOW_TEXT, null);
    let first = null, last = null, n;
    while ((n = walker.nextNode())) { if (!first) first = n; last = n; }
    if (atEnd) return last ? { node: last, offset: last.nodeValue.length } : { node: best, offset: best.childNodes.length };
    return first ? { node: first, offset: 0 } : { node: best, offset: 0 };
  }

  // The .ln / .ln-region that a caret anchor falls inside. Used to activate the nearest
  // line on a plain click that landed in a margin gap (e.g. a heading's top margin) or
  // the editor padding, where the event target is the container rather than a line.
  function anchorLineEl(anchor) {
    if (!anchor) return null;
    let node = anchor.node;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    return node && node.closest ? node.closest('.ln, .ln-region') : null;
  }

  // Geometry of the active line's caret: which wrapped row it sits on (first / last) and
  // the caret's viewport x and top/bottom. Arrow Up/Down cross to the previous/next source
  // line only from the top/bottom row (an interior row is moved natively by the browser);
  // when crossing we reuse x to keep the column and aim just past this caret's top/bottom so
  // the caret lands on the *adjacent* visual row of the neighbour, not its start/end. The
  // rect comes from a one-character probe at the selection focus (a collapsed range often
  // has no client rect); .ln has no vertical padding, so the element box top/bottom are the
  // first/last row edges. Returns null when no rect is measurable (e.g. a blank line).
  function caretGeom(el) {
    const sel = window.getSelection();
    if (!sel || !sel.focusNode || !el.contains(sel.focusNode)) return null;
    const node = sel.focusNode, off = sel.focusOffset;
    let cr = null;
    if (node.nodeType === Node.TEXT_NODE) {
      const probe = document.createRange();
      if (off < node.nodeValue.length) {
        probe.setStart(node, off); probe.setEnd(node, off + 1);
        const rs = probe.getClientRects(); if (rs.length) cr = rs[0];
      }
      if (!cr && off > 0) {
        probe.setStart(node, off - 1); probe.setEnd(node, off);
        const rs = probe.getClientRects(); if (rs.length) cr = rs[rs.length - 1];
      }
    }
    if (!cr) return null;
    const er = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || cr.height || 16;
    return {
      atTop: cr.top - er.top < lh * 0.75,
      atBottom: er.bottom - cr.bottom < lh * 0.75,
      x: cr.left, top: cr.top, bottom: cr.bottom, lh,
    };
  }

  // Keep the caret visible: arrow navigation moves the caret line-by-line but the
  // container doesn't follow on its own, so past the visible frame the caret would
  // slide out of view and motion looked "stuck" at the edge. Nudge container scroll
  // (which is #live in both the normal and the sticky view) so the caret sits inside
  // a small margin. Uses the precise caret rect when measurable, else the active
  // element's box (blank lines / region textareas have no caret rect).
  // In sticky mode a fixed #sticky-title bar paints over the top of #live, so the
  // real usable top sits below it; elsewhere it's 0. Lets scroll math (and the
  // arrow-key row probes) keep the caret out from under the bar.
  function topOverlayInset() {
    const t = document.getElementById('sticky-title');
    if (!t || getComputedStyle(t).display === 'none') return 0;
    return t.getBoundingClientRect().height;
  }
  function scrollCaretIntoView() {
    if (!ta) return;
    const cr = container.getBoundingClientRect();
    const g = !blockMode ? caretGeom(ta) : null;
    let top, bottom;
    if (g) { top = g.top; bottom = g.bottom; }
    else { const er = ta.getBoundingClientRect(); top = er.top; bottom = er.bottom; }
    const pad = 10;
    const topEdge = cr.top + topOverlayInset() + pad;
    if (top < topEdge) container.scrollTop -= topEdge - top;
    else if (bottom > cr.bottom - pad) container.scrollTop += bottom - (cr.bottom - pad);
  }

  // ---- render -----------------------------------------------------------
  // Build the whole document as a flat list of .ln divs (+ block regions). The line
  // index `activeIdx` (or a region containing it) is built in its editable form; the
  // rest are inactive. Used on load and after structural edits / collapse. Heights
  // are identical across active/inactive, so a full rebuild never moves anything.
  function renderAll(activeIdx) {
    const scroll = container.scrollTop;
    container.innerHTML = '';
    ta = null; active = -1; activeEnd = 0; blockMode = false; tedit = null;
    let i = 0;
    while (i < lines.length) {
      const reg = regionStartingAt(i);
      if (reg) {
        // tables never open as a textarea — they get the cell-grid editor,
        // entered via openTableEditor (click / arrow nav), not via renderAll
        if (activeIdx != null && activeIdx >= reg.start && activeIdx < reg.end && reg.type !== 'table') {
          active = reg.start; activeEnd = reg.end; blockMode = true;
          ta = makeRegionEditor(reg);
          container.appendChild(ta);
        } else {
          container.appendChild(makeRegion(reg));
        }
        i = reg.end; continue;
      }
      if (activeIdx === i) {
        active = i; activeEnd = i + 1;
        ta = makeActiveLine(i);
        container.appendChild(ta);
      } else {
        container.appendChild(makeInactiveLine(i));
      }
      i++;
    }
    container.scrollTop = scroll;
    if (ta) { ta.focus(); placeCaret(); }
    pendingCaret = null; pendingClick = null;
  }

  // Drop the active editor's caret at pendingCaret (or the end), then refine to the
  // click point if one is pending (the element wasn't laid out until now).
  function placeCaret() {
    if (!ta) return;
    if (blockMode) {
      const text = ta.value;
      const col = pendingCaret == null ? text.length : Math.min(pendingCaret, text.length);
      ta.selectionStart = ta.selectionEnd = col; lastCaretCol = col; autoGrow(ta);
      scrollCaretIntoView();
      return;
    }
    const raw = lines[active];
    let col = pendingCaret == null ? raw.length : Math.min(pendingCaret, raw.length);
    setCaretOffset(ta, col); lastCaretCol = col;
    if (pendingClick) {
      // For an arrow-cross the click carries a goal x + which edge (visual row) to land on;
      // compute y from the freshly-laid-out neighbour's own rect (the pre-activation y is
      // stale — the raw form may re-wrap). A mouse click carries an absolute {x, y}, no edge.
      let { x, y, edge } = pendingClick;
      if (edge) {
        const r = ta.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
        y = edge === 'bottom' ? r.bottom - lh * 0.5 : r.top + lh * 0.5;
      }
      const c = caretColFromPoint(ta, x, y);
      if (c != null) { setCaretOffset(ta, c); lastCaretCol = c; }
    }
    scrollCaretIntoView();
  }

  const lineEl = (i) => container.querySelector('.ln[data-i="' + i + '"]');

  // Turn the currently-active unit back into its inactive rendered form. A single
  // line is swapped in place (cheap, no reflow); a region may have changed the line
  // count while editing, so it's restored with a full rebuild.
  function collapseActive() {
    if (tedit) { closeTableEditor(); return; }
    if (active < 0) return;
    if (blockMode) { renderAll(-1); return; }
    const el = lineEl(active);
    if (el) el.replaceWith(makeInactiveLine(active));
    // setext pairs make a line's look depend on its neighbour (editing either
    // the text line or the === / --- underline changes both), so refresh the
    // lines around the one that just collapsed.
    for (const j of [active - 1, active + 1]) {
      const nel = j >= 0 && j < lines.length ? lineEl(j) : null;
      if (nel) nel.replaceWith(makeInactiveLine(j));
    }
    active = -1; activeEnd = 0; ta = null;
  }

  // Make line/region `i` the active (editable) unit, in place — no full rebuild for
  // the common line→line case, so cursor movement never rebuilds (or reflows) the doc.
  function activate(i, caret, clickPoint) {
    i = clampLine(i);
    const reg = regionAt(i);
    collapseActive();
    if (reg && reg.type === 'table') {
      // entering from below (i past the table's first line) lands on the last row
      openTableEditor(reg, { r: i > reg.start ? Infinity : 0, c: 0 });
      return;
    }
    pendingCaret = caret == null ? null : caret;
    pendingClick = clickPoint || null;
    if (reg) {
      const el = container.querySelector('.ln-region[data-start="' + reg.start + '"]');
      active = reg.start; activeEnd = reg.end; blockMode = true;
      ta = makeRegionEditor(reg);
      if (el) el.replaceWith(ta); else { renderAll(reg.start); return; }
      ta.focus(); placeCaret();
    } else {
      const el = lineEl(i);
      active = i; activeEnd = i + 1; blockMode = false;
      ta = makeActiveLine(i);
      if (el) el.replaceWith(ta); else { renderAll(i); return; }
      ta.focus(); placeCaret();
    }
    pendingCaret = null; pendingClick = null;
  }

  // ---- active single-line input -----------------------------------------
  function onActiveInput() {
    if (!ta || blockMode) return;
    goalX = null;            // an edit ends any vertical-arrow run
    recordHistory(composing ? 'type-ime' : 'type'); // capture pre-edit state (lines still old here)
    const text = ta.textContent;
    if (composing) { lines[active] = text; commit(); return; }
    if (text.includes('\n')) {
      // a newline slipped in (e.g. a stray block split) — break it into lines
      const parts = text.split('\n');
      const target = active + parts.length - 1;
      lines.splice(active, 1, ...parts);
      pendingCaret = parts[parts.length - 1].length;
      commit();
      renderAll(target);
      return;
    }
    // re-highlight in place, restoring the caret column (textContent === source line,
    // so the offset is stable across the innerHTML rebuild). The block class is left
    // unchanged while the line is active (no mid-type jump); it's recomputed on blur.
    const caret = getCaretOffset(ta);
    lines[active] = text;
    setActiveHtml(ta, text);
    setCaretOffset(ta, caret);
    lastCaretCol = caret;
    commit();
  }

  function onActivePaste(e) {
    if (!ta || blockMode) return;
    e.preventDefault();
    recordHistory('struct');
    const cd = e.clipboardData || window.clipboardData;
    const pasted = cd ? cd.getData('text/plain') : '';
    if (pasted == null) return;
    const value = ta.textContent;
    const { start, end } = getSelectionOffsets(ta);
    const tail = value.slice(end);
    const parts = (value.slice(0, start) + pasted + tail).replace(/\r\n?/g, '\n').split('\n');
    if (parts.length === 1) {
      lines[active] = parts[0];
      setActiveHtml(ta, parts[0]);
      const caret = parts[0].length - tail.length;
      setCaretOffset(ta, caret); lastCaretCol = caret; commit();
    } else {
      lines.splice(active, 1, ...parts);
      const target = active + parts.length - 1;
      pendingCaret = parts[parts.length - 1].length - tail.length;
      commit();
      renderAll(target);
    }
  }

  function onActiveKeydown(e) {
    if (!ta || blockMode) return;
    // A drag / Shift selection that reaches past this line into other rendered lines is a
    // cross-line edit. Hand Backspace/Delete/Enter/typing to the document-level handler
    // (which deletes the span precisely, then types or splits at the join) — acting here
    // would misfire, since getSelectionOffsets clamps such a selection to {0,0} and the
    // line-start Backspace path would merely merge this line into the one above.
    if (!e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter')
        && selectionEscapesActive()) {
      return;
    }
    // Any non-vertical key ends a run of ↑/↓, so the next ↑/↓ re-seeds the goal column.
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') goalX = null;
    const value = ta.textContent;
    const { start, end } = getSelectionOffsets(ta);
    const mod = e.ctrlKey || e.metaKey;
    // Familiar line-editing shortcuts (Ctrl+Z undo/redo is handled at the document
    // level below so it works outside an active line too):
    //   Alt+↑/↓             move the line          Shift+Alt+↑/↓  duplicate the line
    //   Ctrl/Cmd+Shift+K    delete the line        Ctrl/Cmd+X/C   cut/copy the line (no selection)
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (e.shiftKey) duplicateLineBy(dir); else moveLineBy(dir);
      return;
    }
    if (mod && e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); deleteCurrentLine(); return; }
    if (mod && !e.shiftKey && !e.altKey && start === end && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); cutCurrentLine(); return; }
    if (mod && !e.shiftKey && !e.altKey && start === end && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyCurrentLine(); return; }
    // Bold / italic (#6): wrap the selection in **/* (or insert empty markers with the
    // caret between); repeat to toggle off. preventDefault is required — the browser
    // would otherwise inject <b>/<i> via the native execCommand.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'b' || e.key === 'i' || e.key === 'B' || e.key === 'I')) {
      e.preventDefault();
      wrapInline((e.key === 'b' || e.key === 'B') ? '**' : '*');
      return;
    }
    // Tab indents / Shift+Tab outdents a list item one level (with ordered
    // renumbering); on any other line Tab inserts the indent literally (and
    // keeps focus in the editor — the browser default would move it away).
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const k = lineKind(value);
      if (k.type === 'ul' || k.type === 'ol' || k.type === 'task') {
        if (e.shiftKey) {
          const strip = Math.min(INDENT.length, /^ */.exec(value)[0].length);
          if (!strip) return;
          recordHistory('struct');
          lines[active] = value.slice(strip);
          pendingCaret = Math.max(0, start - strip);
        } else {
          recordHistory('struct');
          lines[active] = INDENT + value;
          pendingCaret = start + INDENT.length;
        }
        renumberListBlock(active);
        goalX = null; commit(); renderAll(active);
        return;
      }
      if (e.shiftKey) return;
      recordHistory('struct');
      const next = value.slice(0, start) + INDENT + value.slice(end);
      lines[active] = next;
      setActiveHtml(ta, next);
      setCaretOffset(ta, start + INDENT.length);
      lastCaretCol = start + INDENT.length;
      commit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (smartEnter(value, start, end)) return;
      recordHistory('struct');
      const left = value.slice(0, start), right = value.slice(end);
      lines.splice(active, 1, left, right);
      const target = active + 1;
      pendingCaret = 0; commit(); renderAll(target);
    } else if (e.key === 'Backspace' && start === 0 && end === 0) {
      if (active === 0) return;
      e.preventDefault();
      // Backspacing into a table from the line below deletes the whole table —
      // merging this line into the table's last row would corrupt it.
      const prev = regionAt(active - 1);
      if (prev && prev.type === 'table' && prev.end === active) {
        deleteTableRegion(prev, prev.start, 0);
        return;
      }
      recordHistory('struct');
      const col = lines[active - 1].length;
      lines[active - 1] = lines[active - 1] + lines[active];
      lines.splice(active, 1);
      const target = active - 1;
      pendingCaret = col; commit(); renderAll(target);
    } else if (e.key === 'Delete' && start === value.length && end === value.length) {
      if (active >= lines.length - 1) return;
      e.preventDefault();
      // Mirror of the Backspace case: forward-delete into a table removes it.
      const next = regionStartingAt(active + 1);
      if (next && next.type === 'table') {
        deleteTableRegion(next, active, value.length);
        return;
      }
      recordHistory('struct');
      const col = value.length;
      lines[active] = lines[active] + lines[active + 1];
      lines.splice(active + 1, 1);
      pendingCaret = col; commit(); renderAll(active);
    } else if (e.key === 'ArrowLeft' && !e.shiftKey && !mod && !e.altKey && start === 0 && end === 0) {
      // At the line start, ← crosses to the end of the previous line (native
      // can't leave the per-line contenteditable).
      if (active > 0) { e.preventDefault(); activate(active - 1, Infinity); }
    } else if (e.key === 'ArrowRight' && !e.shiftKey && !mod && !e.altKey
               && start === value.length && end === value.length) {
      // At the line end, → crosses to the start of the next line.
      if (active < lines.length - 1) { e.preventDefault(); activate(active + 1, 0); }
    } else if (e.key === 'ArrowUp' && !e.shiftKey) {
      // Move up one *rendered row* at a stable goal x. Within a wrapped line we drive the
      // caret manually (caretColFromPoint at the goal x, half a row up) rather than leaning
      // on native ↑ — at the top row native ↑ collapses to the line start, the reported jump.
      // From the top row, cross to the previous source line and land on its *last* visual row
      // at the goal x. Let Shift+↑ extend a native selection within the line.
      const g = caretGeom(ta);
      if (goalX == null) goalX = g ? g.x : ta.getBoundingClientRect().left;
      if (g && !g.atTop) {
        e.preventDefault();
        // The target row may sit above the visible frame (under the sticky title or
        // off the top edge); caretRangeFromPoint can't resolve an off-screen point and
        // would snap to the line's middle, so scroll it into view first, then probe.
        const cr = container.getBoundingClientRect();
        let y = g.top - g.lh * 0.5;
        const limit = cr.top + topOverlayInset() + g.lh * 0.5;
        if (y < limit) { const before = container.scrollTop; container.scrollTop -= limit - y; y += before - container.scrollTop; }
        const c = caretColFromPoint(ta, goalX, y);
        if (c != null) { setCaretOffset(ta, c); lastCaretCol = c; }
        scrollCaretIntoView();
      } else if (active > 0) {
        e.preventDefault();
        activate(active - 1, start, { x: goalX, edge: 'bottom' });
      }
      // else: top row of the first line — let native ↑ put the caret at the line start.
    } else if (e.key === 'ArrowDown' && !e.shiftKey) {
      // Mirror of ArrowUp: down one rendered row at the goal x; from the bottom row, cross to
      // the next source line and land on its *first* visual row.
      const g = caretGeom(ta);
      if (goalX == null) goalX = g ? g.x : ta.getBoundingClientRect().left;
      if (g && !g.atBottom) {
        e.preventDefault();
        // The next row often rides just below the visible frame (the caret hugs the
        // bottom margin as we scroll); caretRangeFromPoint can't resolve an off-screen
        // point and would snap to the line's middle — the "stuck on a wrapped line"
        // bug. Scroll it into view first, adjusting the probe y by the real scroll
        // applied (clamped at the document end), then sample the column.
        const cr = container.getBoundingClientRect();
        let y = g.bottom + g.lh * 0.5;
        const limit = cr.bottom - g.lh * 0.5;
        if (y > limit) { const before = container.scrollTop; container.scrollTop += y - limit; y -= container.scrollTop - before; }
        const c = caretColFromPoint(ta, goalX, y);
        if (c != null) { setCaretOffset(ta, c); lastCaretCol = c; }
        scrollCaretIntoView();
      } else if (active < lines.length - 1) {
        e.preventDefault();
        activate(active + 1, end, { x: goalX, edge: 'top' });
      }
      // else: bottom row of the last line — let native ↓ put the caret at the line end.
    } else if (e.key === 'Escape') {
      ta.blur();
    }
  }

  function onActiveBlur() {
    // If focus left the editor entirely, collapse to a clean full render. Deferred so
    // a click re-targeting another line (or a drag selection) wins first.
    setTimeout(() => {
      if (container.contains(document.activeElement)) return;
      if (drag) return;             // a text-surface gesture is mid-flight
      if (active < 0) return;
      renderAll(-1);
    }, 0);
  }

  // ---- block-region (code/gantt/table) input ----------------------------
  function onCodeInput() {
    if (!ta || !blockMode) return;
    recordHistory('type-code'); // capture pre-edit state (lines still hold the old region)
    const parts = ta.value.split('\n');
    lines.splice(active, activeEnd - active, ...parts);
    activeEnd = active + parts.length;
    autoGrow(ta);
    lastCaretCol = ta.selectionEnd;
    commit();
  }
  function onCodeKeydown(e) {
    if (!ta || !blockMode) return;
    if (e.key === 'Escape') { ta.blur(); return; }
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); return; }
    const at = ta.selectionStart, to = ta.selectionEnd;
    if (at !== to) return;
    if (e.key === 'ArrowUp' && !ta.value.slice(0, at).includes('\n')) {
      e.preventDefault();
      if (active > 0) activate(active - 1, Infinity);
    } else if (e.key === 'ArrowDown' && !ta.value.slice(to).includes('\n')) {
      e.preventDefault();
      if (activeEnd < lines.length) activate(activeEnd, 0);
    } else if (e.key === 'ArrowLeft' && at === 0) {
      e.preventDefault();
      if (active > 0) activate(active - 1, Infinity);
    } else if (e.key === 'ArrowRight' && to === ta.value.length) {
      e.preventDefault();
      if (activeEnd < lines.length) activate(activeEnd, 0);
    }
  }

  // ---- checkbox toggle --------------------------------------------------
  function toggleCheckbox(box) {
    const boxes = Array.from(container.querySelectorAll('.task-checkbox'));
    const n = boxes.indexOf(box);
    if (n < 0) return;
    const taskLines = [];
    lines.forEach((ln, idx) => { if (idx !== active && isTaskLine(ln)) taskLines.push(idx); });
    const li = taskLines[n];
    if (li == null) return;
    recordHistory('struct');
    lines[li] = lines[li].replace(/^(\s*([-*+]|\d+[.)])\s+\[)([ xX])(\])/,
      (_, p1, _m, c) => p1 + (/[xX]/.test(c) ? ' ' : 'x') + ']');
    commit();
    const el = lineEl(li);
    if (el) el.replaceWith(makeInactiveLine(li)); else renderAll(active);
  }

  // ---- WYSIWYG table editing ---------------------------------------------
  // A table region opens as a real cell grid instead of a raw textarea: the
  // clicked cell is the one editable spot (raw cell markdown, dimmed markers —
  // the active-line model at cell granularity), every other cell stays
  // rendered. Tab/Shift+Tab walk cells (Tab past the last cell adds a row),
  // Enter moves down a column (adding a row at the bottom), Escape closes,
  // right-click offers row/column operations. The editor root carries
  // .ln-region + data-start/end so selection mapping treats it as a region.
  let tedit = null; // { start, end, model, r, c, cellEl, root } while open

  const cellSrc = (m, r, c) => (r === 0 ? (m.header[c] || '') : ((m.rows[r - 1] || [])[c] || ''));
  function setCellSrc(m, r, c, text) {
    if (r === 0) m.header[c] = text;
    else if (m.rows[r - 1]) m.rows[r - 1][c] = text;
  }

  function makeTableEditor(reg, model) {
    const root = document.createElement('div');
    root.className = 'ln-region ln-table-edit markdown-body';
    root.dataset.start = String(reg.start);
    root.dataset.end = String(reg.end);
    const mk = (tag, r, c) => {
      const cell = document.createElement(tag);
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      if (model.aligns[c]) cell.style.textAlign = model.aligns[c];
      cell.innerHTML = window.renderInline(cellSrc(model, r, c)) || '<br>';
      return cell;
    };
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (let c = 0; c < model.header.length; c++) hrow.appendChild(mk('th', 0, c));
    thead.appendChild(hrow);
    const tbody = document.createElement('tbody');
    for (let r = 0; r < model.rows.length; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < model.header.length; c++) tr.appendChild(mk('td', r + 1, c));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    root.appendChild(table);
    root.addEventListener('input', onTableCellInput);
    root.addEventListener('keydown', onTableCellKeydown);
    root.addEventListener('contextmenu', onTableContextMenu);
    root.addEventListener('focusout', onTableFocusOut);
    root.addEventListener('compositionstart', () => { composing = true; });
    root.addEventListener('compositionend', () => { composing = false; onTableCellInput(); });
    return root;
  }

  function openTableEditor(reg, hint) {
    collapseActive();
    const regionEl = container.querySelector('.ln-region[data-start="' + reg.start + '"]');
    if (!regionEl) return;
    const model = window.parseTableRegion(lines.slice(reg.start, reg.end));
    const root = makeTableEditor(reg, model);
    tedit = { start: reg.start, end: reg.end, model, r: -1, c: -1, cellEl: null, root };
    regionEl.replaceWith(root);
    const rowsN = model.rows.length + 1;
    let r = 0, c = 0;
    if (hint && hint.r != null) {
      r = Math.max(0, Math.min(hint.r, rowsN - 1));
      c = Math.max(0, Math.min(hint.c || 0, model.header.length - 1));
    }
    editCell(r, c);
    if (hint && hint.x != null && tedit && tedit.cellEl) {
      const col = caretColFromPoint(tedit.cellEl, hint.x, hint.y);
      if (col != null) setCaretOffset(tedit.cellEl, col);
    }
  }

  function closeTableEditor() {
    if (!tedit) return;
    tedit = null;
    renderAll(-1);
  }

  // Re-render the cell that was being edited back to its rendered look. The
  // model/lines are already current (synced on every input), so this is DOM-only.
  function commitCellEdit() {
    if (!tedit || !tedit.cellEl) return;
    const cell = tedit.cellEl;
    tedit.cellEl = null;
    cell.contentEditable = 'false';
    cell.classList.remove('cell-editing');
    cell.innerHTML = window.renderInline(cellSrc(tedit.model, tedit.r, tedit.c)) || '<br>';
  }

  function editCell(r, c) {
    if (!tedit) return;
    commitCellEdit();
    const cell = tedit.root.querySelector('[data-r="' + r + '"][data-c="' + c + '"]');
    if (!cell) return;
    tedit.r = r; tedit.c = c; tedit.cellEl = cell;
    const src = cellSrc(tedit.model, r, c);
    cell.classList.add('cell-editing');
    cell.contentEditable = 'true';
    cell.spellcheck = false;
    cell.innerHTML = window.highlightInline(src) || '<br>';
    cell.focus();
    setCaretOffset(cell, src.length);
  }

  // Serialize the model back into the source lines (the table is the one
  // construct whose source is normalised — padding and \| escapes — on edit).
  function syncTableLines() {
    const out = window.serializeTableRegion(tedit.model);
    lines.splice(tedit.start, tedit.end - tedit.start, ...out);
    tedit.end = tedit.start + out.length;
    tedit.root.dataset.end = String(tedit.end);
  }

  function onTableCellInput() {
    if (!tedit || !tedit.cellEl) return;
    recordHistory('type-table');
    const cell = tedit.cellEl;
    const text = cell.textContent.replace(/\n/g, ' ');
    setCellSrc(tedit.model, tedit.r, tedit.c, text);
    syncTableLines();
    if (!composing) {
      const caret = getCaretOffset(cell);
      cell.innerHTML = window.highlightInline(text) || '<br>';
      setCaretOffset(cell, caret);
    }
    commit();
  }

  // A structural table change (rows/columns/alignment): apply to the model,
  // re-serialize, then rebuild the whole document — row-count changes shift
  // every following line index, and renderAll re-derives them all — and reopen
  // the editor on the same table at (r, c). Takes start/model explicitly so a
  // context-menu action still works after the menu click's focusout closed the
  // editor (the captured model stays in sync — cells commit on every input).
  function tableOpAt(start, model, fn, r, c) {
    recordHistory('struct');
    fn(model);
    const cur = regionStartingAt(start);
    if (!cur || cur.type !== 'table') return;
    lines.splice(start, cur.end - start, ...window.serializeTableRegion(model));
    tedit = null;
    commit();
    renderAll(-1);
    const reg = regionStartingAt(start);
    if (reg && reg.type === 'table') openTableEditor(reg, { r, c });
  }
  function tableOp(fn, r, c) {
    if (!tedit) return;
    tableOpAt(tedit.start, tedit.model, fn, r, c);
  }

  // Remove a whole table region (the context menu's "Delete table" and a
  // Backspace/Delete pressed against the table's edge). `target` is the line
  // to activate afterwards (post-splice index), `caret` its caret column.
  function deleteTableRegion(reg, target, caret) {
    recordHistory('struct');
    tedit = null;
    lines.splice(reg.start, reg.end - reg.start);
    if (!lines.length) lines = [''];
    pendingCaret = caret == null ? 0 : caret;
    goalX = null;
    commit();
    renderAll(clampLine(target == null ? reg.start : target));
  }

  function onTableCellKeydown(e) {
    if (!tedit) return;
    const model = tedit.model;
    const cols = model.header.length;
    const rowsN = model.rows.length + 1;
    const emptyRow = () => Array(cols).fill('');
    if (e.key === 'Tab') {
      e.preventDefault();
      let r = tedit.r, c = tedit.c;
      if (e.shiftKey) {
        c--; if (c < 0) { r--; c = cols - 1; }
        if (r >= 0) editCell(r, c);
      } else {
        c++; if (c >= cols) { r++; c = 0; }
        if (r >= rowsN) tableOp((m) => m.rows.push(emptyRow()), rowsN, 0);
        else editCell(r, c);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = tedit.r + 1, c = tedit.c;
      if (r >= rowsN) tableOp((m) => m.rows.push(emptyRow()), r, c);
      else editCell(r, c);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeTableEditor();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (tedit.r > 0) editCell(tedit.r - 1, tedit.c);
      else {
        const start = tedit.start;
        closeTableEditor();
        if (start > 0) activate(start - 1, Infinity);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (tedit.r < rowsN - 1) editCell(tedit.r + 1, tedit.c);
      else {
        const end = tedit.end;
        closeTableEditor();
        if (end < lines.length) activate(end, 0);
      }
    }
  }

  function onTableContextMenu(e) {
    if (!tedit || !onContextMenu) return;
    const cell = e.target.closest('th, td');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const r = parseInt(cell.dataset.r, 10), c = parseInt(cell.dataset.c, 10);
    const br = Math.max(0, r - 1); // body-row index
    const start = tedit.start;
    const model = tedit.model;
    const op = (fn, nr, nc) => tableOpAt(start, model, fn, nr, nc);
    const cols = model.header.length;
    const emptyRow = () => Array(cols).fill('');
    const insCol = (m, at) => {
      m.header.splice(at, 0, '');
      m.aligns.splice(at, 0, '');
      m.rows.forEach((row) => row.splice(at, 0, ''));
    };
    const delCol = (m, at) => {
      m.header.splice(at, 1);
      m.aligns.splice(at, 1);
      m.rows.forEach((row) => row.splice(at, 1));
    };
    onContextMenu(e.clientX, e.clientY, [
      { label: 'Insert row above', disabled: r === 0, action: () => op((m) => m.rows.splice(br, 0, emptyRow()), r, c) },
      { label: 'Insert row below', action: () => op((m) => m.rows.splice(r === 0 ? 0 : br + 1, 0, emptyRow()), r + 1, c) },
      { label: 'Delete row', disabled: r === 0 || model.rows.length <= 1, action: () => op((m) => m.rows.splice(br, 1), Math.min(r, model.rows.length - 1), c) },
      { sep: true },
      { label: 'Insert column left', action: () => op((m) => insCol(m, c), r, c) },
      { label: 'Insert column right', action: () => op((m) => insCol(m, c + 1), r, c + 1) },
      { label: 'Delete column', disabled: cols <= 1, action: () => op((m) => delCol(m, c), r, Math.min(c, cols - 2)) },
      { sep: true },
      { label: 'Align left', action: () => op((m) => { m.aligns[c] = 'left'; }, r, c) },
      { label: 'Align centre', action: () => op((m) => { m.aligns[c] = 'center'; }, r, c) },
      { label: 'Align right', action: () => op((m) => { m.aligns[c] = 'right'; }, r, c) },
      { sep: true },
      { label: 'Delete table', danger: true, action: () => {
        // Re-derive the region at action time: the menu click's focusout may
        // have closed the editor, and earlier ops can have shifted the lines.
        const reg = regionStartingAt(start);
        if (reg && reg.type === 'table') deleteTableRegion(reg, start, 0);
      } },
    ]);
  }

  function onTableFocusOut() {
    // Deferred like onActiveBlur: close only if focus truly left the editor
    // (a cell-to-cell move or an in-flight gesture keeps it open).
    setTimeout(() => {
      if (!tedit || drag) return;
      if (tedit.root.contains(document.activeElement)) return;
      if (container.contains(document.activeElement)) return; // another line took over
      closeTableEditor();
    }, 0);
  }

  // ---- select all (Ctrl/Cmd+A) ------------------------------------------
  function selectAll() {
    goalX = null;
    if (active >= 0 || tedit) renderAll(-1);
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(container);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- pointer: click to activate, drag to select -----------------------
  // We own the selection rather than relying on the browser's native hit-test, which
  // can't anchor on a blank line, a checkbox, the bullet gutter, an hr, or the padding.
  // mousedown records an anchor (via pointToCaret) and collapses the selection there;
  // a drag extends it with setBaseAndExtent across the rendered .ln divs (the whole
  // doc); a plain click (no drag) activates the line for editing on mouseup.
  let lastDrag = null;     // latest pointer {x,y} during a drag (drives edge autoscroll)
  let autoscrollRaf = 0;   // rAF id of the running edge-autoscroll loop, or 0

  // Extend the live selection from the recorded anchor to the caret under (x,y).
  function extendSelectionTo(x, y) {
    if (!drag || !drag.anchor) return;
    const focus = pointToCaret(x, y);
    const sel = window.getSelection();
    if (focus && sel) sel.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, focus.node, focus.offset);
  }

  function stopAutoscroll() { if (autoscrollRaf) { cancelAnimationFrame(autoscrollRaf); autoscrollRaf = 0; } }

  // While a drag's pointer sits past the top/bottom edge, scroll the container toward
  // it and keep extending the selection to the edge, so newly-revealed lines get
  // selected — all the way to the file's top/bottom. Self-perpetuating (independent of
  // further mousemove) until the pointer re-enters or scrolling hits the limit.
  function autoscrollTick() {
    autoscrollRaf = 0;
    if (!drag || !drag.anchor || !lastDrag) return;
    const cr = container.getBoundingClientRect();
    const margin = 24;
    let dir = 0, dist = 0, edgeY = lastDrag.y;
    if (lastDrag.y < cr.top + margin) { dir = -1; dist = (cr.top + margin) - lastDrag.y; edgeY = cr.top + 2; }
    else if (lastDrag.y > cr.bottom - margin) { dir = 1; dist = lastDrag.y - (cr.bottom - margin); edgeY = cr.bottom - 2; }
    if (dir === 0) return;
    const before = container.scrollTop;
    container.scrollTop = before + dir * Math.min(40, 4 + dist * 0.5);
    const x = Math.min(Math.max(lastDrag.x, cr.left + 2), cr.right - 2);
    extendSelectionTo(x, edgeY);
    if (container.scrollTop !== before) autoscrollRaf = requestAnimationFrame(autoscrollTick); // more to scroll
  }
  function maybeAutoscroll() {
    const cr = container.getBoundingClientRect();
    const margin = 24;
    const outside = lastDrag && (lastDrag.y < cr.top + margin || lastDrag.y > cr.bottom - margin);
    if (!outside) { stopAutoscroll(); return; }
    if (!autoscrollRaf) autoscrollRaf = requestAnimationFrame(autoscrollTick);
  }

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    goalX = null;            // a click sets a new caret position; drop any vertical goal
    if (e.target.closest('a[href]')) return;                  // link click handled on click
    const gantt = e.target.closest('.gantt-block');
    if (gantt) {
      const gr = gantt.getBoundingClientRect();
      if (e.clientY >= gr.top + gantt.clientHeight) return;   // native horizontal scrollbar
    }
    // Press inside the line currently being edited: let native handle the caret,
    // word double-click and in-line selection. But still record the gesture so that
    // if the drag leaves this line we can take over and select ACROSS lines — a
    // native contenteditable selection can't extend out of its own element, which is
    // what made multi-line selection "stick" on the active line.
    // Press inside the open table editor: same-cell presses stay native (caret,
    // word select, in-cell drag); another cell commits the current one and moves
    // the edit there at the click point. Either way record a native gesture so a
    // drag that leaves the cell hands off to cross-line selection.
    if (tedit && e.target.closest('.ln-table-edit')) {
      const cell = e.target.closest('th, td');
      if (cell && cell === tedit.cellEl) {
        drag = { x: e.clientX, y: e.clientY, anchor: null, moved: false, native: true, activeEl: cell, target: null, isCheckbox: false };
        return;
      }
      if (cell) {
        e.preventDefault();
        editCell(parseInt(cell.dataset.r, 10), parseInt(cell.dataset.c, 10));
        if (tedit.cellEl) {
          const col = caretColFromPoint(tedit.cellEl, e.clientX, e.clientY);
          if (col != null) setCaretOffset(tedit.cellEl, col);
          drag = { x: e.clientX, y: e.clientY, anchor: null, moved: false, native: true, activeEl: tedit.cellEl, target: null, isCheckbox: false };
        }
      }
      return;
    }
    const editable = e.target.closest('.ln-active') || e.target.closest('.ln-region-edit');
    if (editable) {
      drag = { x: e.clientX, y: e.clientY, anchor: null, moved: false, native: true, activeEl: editable, target: null, isCheckbox: false };
      return;               // no preventDefault: native caret placement stays intact
    }
    const anchor = pointToCaret(e.clientX, e.clientY);
    if (anchor) {
      const sel = window.getSelection();
      if (sel) sel.collapse(anchor.node, anchor.offset);
    }
    drag = {
      x: e.clientX, y: e.clientY, anchor, moved: false,
      target: e.target.closest('.ln, .ln-region'),
      isCheckbox: !!e.target.closest('.task-checkbox'),
    };
    e.preventDefault();   // we drive selection + activation from here
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (!drag.moved && (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4)) drag.moved = true;
    if (!drag.moved) return;
    if (drag.native) {
      // Still within the active line's rows → leave it to native selection. Once the
      // pointer leaves that vertical span, collapse the active line to its rendered
      // form (so the whole doc is uniform .ln divs) and re-anchor at the mousedown
      // point: active/inactive line heights are identical, so the layout doesn't move
      // and the same point maps to the same caret.
      const b = drag.activeEl ? drag.activeEl.getBoundingClientRect() : null;
      if (b && e.clientY >= b.top && e.clientY <= b.bottom) return;
      collapseActive();
      drag.anchor = pointToCaret(drag.x, drag.y);
      drag.native = false;
      if (!drag.anchor) { drag = null; return; }
    }
    if (!drag.anchor) return;
    lastDrag = { x: e.clientX, y: e.clientY };
    extendSelectionTo(e.clientX, e.clientY);
    maybeAutoscroll();
    e.preventDefault();
  });
  document.addEventListener('mouseup', () => {
    stopAutoscroll();
    lastDrag = null;
    const g = drag;
    if (!g) return;
    drag = null;
    if (g.native) return;           // native in-line gesture (click or single-line select)
    if (g.moved) return;            // a drag-selection was made; keep it (native Ctrl+C copies)
    if (g.isCheckbox) return;       // a checkbox toggle is handled by the click listener
    // The line to edit: the one pressed, or — for a click that landed in a margin gap or
    // padding (target is the container) — the nearest line under the point. Only fall back
    // to the last line when nothing resolves at all (e.g. an empty document).
    const targetEl = g.target || anchorLineEl(g.anchor);
    if (!targetEl) {
      activate(lines.length - 1, Infinity);
    } else if (targetEl.classList.contains('ln-region')) {
      const start = parseInt(targetEl.dataset.start, 10);
      const reg = regionStartingAt(start);
      if (reg && reg.type === 'table') {
        // open the cell grid on the clicked cell (the rendered table is still
        // in the DOM here, so the point maps straight to a th/td)
        const hit = document.elementFromPoint(g.x, g.y);
        const cell = hit && hit.closest ? hit.closest('th, td') : null;
        openTableEditor(reg, cell
          ? { r: cell.parentElement.rowIndex, c: cell.cellIndex, x: g.x, y: g.y }
          : { r: 0, c: 0 });
      } else {
        activate(start, Infinity);
      }
    } else {
      activate(parseInt(targetEl.dataset.i, 10), Infinity, { x: g.x, y: g.y });
    }
  });

  container.addEventListener('click', (e) => {
    const box = e.target.closest('.task-checkbox');
    if (box) { e.preventDefault(); toggleCheckbox(box); return; }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      // In-page anchors (#…) have no target here (we emit no heading ids), so ignore them.
      if (href && !href.startsWith('#')) onOpenLink(href);
    }
  });

  // Ctrl/Cmd+A selects the whole note — but only when the editor owns the keystroke
  // (it's visible and either holds focus or nothing else does), so Ctrl+A inside the
  // sidebar's rename field / any other input keeps its native behaviour.
  document.addEventListener('keydown', (e) => {
    if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A'))) return;
    if (container.hidden) return;
    const focused = document.activeElement;
    if (!(container.contains(focused) || focused === document.body || focused === container)) return;
    e.preventDefault();
    selectAll();
  });

  // Undo / redo at the document level (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y).
  // Handled here — not just in the active line — so it still works right after a
  // structural edit that left no line active, and so it overrides the native
  // contenteditable undo (which only spans one line). Same ownership guard as Ctrl+A
  // so undo inside the sidebar's rename field keeps its native behaviour.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const z = e.key === 'z' || e.key === 'Z';
    const y = e.key === 'y' || e.key === 'Y';
    if (!z && !y) return;
    if (container.hidden) return;
    const focused = document.activeElement;
    if (!(container.contains(focused) || focused === document.body || focused === container)) return;
    e.preventDefault();
    if (y || (z && e.shiftKey)) redo(); else undo();
  });

  // Map a DOM selection boundary to a source {line, col}. Exact on a plain line
  // (its rendered textContent equals the source line, so the rendered offset IS the
  // column); on a line carrying markdown markers / inline formatting the rendered
  // text differs from the source and there's no faithful inverse, so the boundary
  // snaps to the nearest line edge. A boundary on a block region (code/table) or on
  // the container itself (Select-All) resolves to the region/child line edge.
  function domPointToSource(node, offset, isEnd) {
    if (node === container) {
      const kids = container.children;
      if (!kids.length) return null;
      const idx = isEnd ? Math.min(offset, kids.length) - 1 : Math.min(offset, kids.length - 1);
      const child = kids[Math.max(0, idx)];
      return domPointToSource(child, isEnd ? child.childNodes.length : 0, isEnd);
    }
    let el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    el = el && el.closest ? el.closest('.ln, .ln-region') : null;
    if (!el) return null;
    if (el.classList.contains('ln-region')) {
      const start = parseInt(el.dataset.start, 10);
      const end = parseInt(el.dataset.end, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return isEnd ? { line: end - 1, col: lines[end - 1].length } : { line: start, col: 0 };
    }
    const i = parseInt(el.dataset.i, 10);
    if (!Number.isFinite(i) || i >= lines.length) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    try { r.setEnd(node, offset); } catch { return { line: i, col: isEnd ? lines[i].length : 0 }; }
    const ro = r.toString().length;
    const rlen = el.textContent.length;
    if (el.textContent === lines[i]) return { line: i, col: Math.min(ro, lines[i].length) };
    return { line: i, col: ro <= rlen / 2 ? 0 : lines[i].length };
  }

  // Backspace / Delete / a typed character / Enter on a selection that spans
  // rendered (inactive) lines — there's no active contenteditable to receive the
  // key, so the doc level handles it. The selection is deleted precisely (keep
  // the head of the first line + tail of the last); a typed character lands at
  // the join, Enter splits there. A selection wholly inside the active line /
  // the editing table cell stays the browser's to handle.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const printable = e.key.length === 1;
    const isDelete = e.key === 'Backspace' || e.key === 'Delete';
    const isEnter = e.key === 'Enter';
    if (!printable && !isDelete && !isEnter) return;
    if (container.hidden) return;
    const focused = document.activeElement;
    if (!(container.contains(focused) || focused === document.body || focused === container)) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    if (active >= 0 && ta && ta.contains(range.startContainer) && ta.contains(range.endContainer)) return;
    if (tedit && tedit.cellEl && tedit.cellEl.contains(range.startContainer) && tedit.cellEl.contains(range.endContainer)) return;
    const a = domPointToSource(range.startContainer, range.startOffset, false);
    const b = domPointToSource(range.endContainer, range.endOffset, true);
    if (!a || !b || a.line > b.line || (a.line === b.line && a.col >= b.col)) return;
    e.preventDefault();
    recordHistory('struct');
    const head = lines[a.line].slice(0, a.col);
    const tail = lines[b.line].slice(b.col);
    goalX = null;
    if (isEnter) {
      lines.splice(a.line, b.line - a.line + 1, head, tail);
      renumberListBlock(a.line + 1);
      pendingCaret = 0;
      commit();
      renderAll(a.line + 1);
    } else {
      const ch = printable ? e.key : '';
      lines.splice(a.line, b.line - a.line + 1, head + ch + tail);
      renumberListBlock(a.line);
      pendingCaret = a.col + ch.length;
      commit();
      renderAll(a.line);
    }
  });

  // ---- public API -------------------------------------------------------
  return {
    load(text, state) {
      lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 0) lines = [''];
      refreshRefs(); // resolve [label][id] / [^id] before the first render
      clearHistory(); // a different document — start its undo history fresh
      pendingCaret = state && state.caret != null ? state.caret : null;
      const idx = state && Number.isInteger(state.active) ? clampLine(state.active) : -1;
      renderAll(idx >= 0 ? idx : -1);
      if (state && state.scrollTop != null) container.scrollTop = state.scrollTop;
    },
    getDoc() { return docText(); },
    getState() {
      return {
        active,
        caret: ta
          ? (blockMode ? ta.selectionEnd
             : (document.activeElement === ta ? getCaretOffset(ta) : lastCaretCol))
          : null,
        scrollTop: container.scrollTop,
      };
    },
    focus() {
      if (active < 0) activate(0, 0);
      else if (ta) ta.focus();
    },
    isEmptyView() { return active < 0; },
    // Formatting commands for the toolbar (app.js #format-bar). Each makes sure
    // a line is active first; block-region/table editors no-op gracefully.
    format(action) {
      switch (action) {
        case 'bold':      if (ensureActive()) wrapInline('**'); break;
        case 'italic':    if (ensureActive()) wrapInline('*'); break;
        case 'strike':    if (ensureActive()) wrapInline('~~'); break;
        case 'code':      if (ensureActive()) wrapInline('`'); break;
        case 'link':      if (ensureActive()) insertLink(); break;
        case 'footnote':  if (ensureActive()) insertFootnote(); break;
        case 'h1': case 'h2': case 'h3':
        case 'ul': case 'ol': case 'task': case 'quote':
          if (ensureActive()) setLineMarker(action); break;
        case 'table': case 'codeblock': case 'hr':
          if (ensureActive()) insertBlock(action); break;
      }
    },
  };
};
