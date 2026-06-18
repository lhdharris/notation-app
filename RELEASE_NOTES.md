# Notation v1.2.6

A minimalist local-first Markdown editor with desktop sticky notes. This release
fixes editing over a selection, makes copy preserve formatting cleanly, and
smooths out plain-text files and sticky-note windows.

## Editor
- **Deleting a selection only deletes what you selected** — pressing Backspace
  over a highlighted span no longer wipes the whole line; it removes exactly the
  text you picked, including inside bold/italic and list items.
- **Copy keeps your formatting (Ctrl+C and right-click)** — copying a selection
  now carries bold, italic, links and the like as clean rich text, while dropping
  fonts and sizes, so it pastes tidily into other apps. Ctrl+C now reliably copies
  the span you've selected.
- **Right-clicking a selection is more forgiving** — your highlight no longer
  vanishes just before the menu appears when you right-click on or near it.

## Files
- **Plain-text files stay plain** — `.txt` (and other non-Markdown files) are now
  shown and exported exactly as written, instead of being rendered as Markdown.
  Markdown formatting still applies to `.md` files.

## Sticky notes
- **Un-maximizing a maximized sticky gives you a normal window** — pulling a
  full-screened sticky back down now returns a properly sized, operable window
  instead of snapping to the tiny post-it size and getting stuck.

## Appearance
- **The unsaved-changes dot matches the tab drag line** — the little "unsaved"
  marker on a tab is now the same blue as the tab-rearrangement indicator.

---

# Notation v1.2.5

A minimalist local-first Markdown editor with desktop sticky notes. This release
reworks how pinned tabs, windows and sticky notes fit together, and smooths out
dragging tabs around.

## Tabs & windows
- **Pinned tabs are now per-window** — pinning a note keeps it pinned in that
  window only; it no longer forces the note open in every window. On your next
  launch, all your pinned notes (and any desktop stickies) gather back into a
  single window as pinned tabs on the left, so you always start from one tidy
  workspace.
- **Drag a tab between windows and it lands where you drop it** — dropping a tab
  onto another window's tab bar now inserts it at that spot instead of jumping to
  the far right.
- **The drag marker stays put** — the blue "drop here" bar that shows where a
  dragged tab will land no longer disappears after you pin, unpin or reorder
  tabs.
- **Right-click the top bar** for a quick menu: New file, Gather all windows, and
  Gather all windows and stickies.

## Sticky notes
- **Stickies return as pins on startup** — closing the whole app and relaunching
  reopens your desktop stickies as pinned tabs in the one consolidated window, so
  nothing gets lost.
- **"Gather all windows" leaves stickies alone** — it no longer pulls a stickied
  note in as a tab; use "Gather all windows and stickies" when you do want to
  absorb the post-its too.

## Editor
- **Paste replaces a multi-line selection** — selecting text across several lines
  and pasting now replaces the whole selection with the clipboard contents, the
  same way paste already worked within a single line.

---

# Notation v1.2.3

A minimalist local-first Markdown editor with desktop sticky notes. This release
fixes how pinned notes interact with sticky notes, plus a multi-line editing
glitch.

## Sticky notes
- **Moving a pinned note to a sticky no longer scrambles your tabs** — turning a
  pinned note into a desktop post-it now cleanly hands it off: the new sticky
  shows only that one note, and it stops being a global pin (so it leaves your
  other windows and won't keep reappearing after you close it). Previously a
  fresh sticky would silently soak up every pinned note as hidden tabs and
  confuse the tab bar.
- **Stickies stay single-note** — a sticky window no longer pulls in the app's
  pinned notes; it re-syncs with your pins only if you restore it to a normal
  window.

## Editor
- **Cross-line selection edits** — selecting text by dragging or Shift-clicking
  past the current line and then typing, deleting, or pressing Enter now edits
  the whole selection correctly instead of misfiring on the active line.

---

# Notation v1.2.2

A minimalist local-first Markdown editor with desktop sticky notes. Every note is
just a `.md` file in a folder you control — no cloud, no account, just text files.

## Updates & OS integration
- **In-app updater** — Notation now checks for new releases every 4 hours. A small
  banner in the bottom-right corner offers "Update" (downloads the right installer for
  your platform and opens it), "Skip this version", or dismiss. No auto-install:
  you stay in control.
- **Open files from outside your workspace** — double-clicking a `.md` file in Finder
  (or any OS "Open with") now opens it as a tab in Notation, even if it lives outside
  your current workspace folder. A second launch naming a file routes it into the
  running app instead of opening a duplicate window.

## Sticky notes
- **Crossfade restore** — leaving sticky mode now fades out smoothly instead of
  cutting straight to the normal editor.
- **Double-click the title bar to restore** — on all platforms. (Previously worked on
  Linux only; macOS and Windows intercept the gesture at the system level; now handled.)
- **Right-click the sticky title bar** for a "New Window" shortcut.
- **Scroll and arrow-key fixes** — the caret no longer hides under the sticky title
  bar; ↑/↓ through wrapped lines no longer stalls when the target row is off-screen.

## Tabs & pinning
- **Pins sync across all open windows** — pinned notes are now app-global. Every window
  stays in sync: pinning in one window pins it everywhere; unpinning, trashing, or
  renaming a note updates the pin list for the whole app.
- **Pin order is preserved** — reordering tabs in the pinned block propagates to all
  windows.

## Editor
- **Insert footnote** — a new formatting toolbar action drops a `[^N]` reference at the
  caret and appends a matching `[^N]:` definition at the foot of the document, ready to
  type.
- **Arrow keys cross line boundaries** — ← at a line's start moves to the end of the
  previous line; → at a line's end moves to the start of the next.
- **Type or Enter over a multi-line selection** — selecting across lines and typing
  replaces the selection; Enter splits it. Previously only Backspace/Delete worked.
- **Delete table** — Backspace from the line after a table, Delete from the line
  before, or the new "Delete table" context-menu item all remove a table cleanly.
- **Context menu dismissal fix** — clicking in the note body now correctly dismisses
  any open context menu.

---

# Notation v1.2.1

A minimalist local-first Markdown editor with desktop sticky notes. Every note is
just a `.md` file in a folder you control — no cloud, no account, just text files.

A visual refresh. (v1.2.0 below was never published, so this release also carries
everything new since v1.1.1.)

## Design
- **Redesigned app icon** — a fanned stack of pastel sticky notes (the app's own
  post-it palette) on a light greyscale gradient, replacing the plain grey
  document. Carried
  through to all platform icons, the window/taskbar icon, the README banner and
  the in-app empty state.

---

# Notation v1.2.0

A minimalist local-first Markdown editor with desktop sticky notes. Every note is
just a `.md` file in a folder you control — no cloud, no account, just text files.

First release with macOS and Windows builds alongside Linux. New since v1.1.1:

## Editor
- **Inline images** — `![alt](path)` renders in the viewer (relative paths resolve
  against the note's folder) and carries through to PDF export.
- **Formatting toolbar** — a minimalist word-editor strip above the note: bold,
  italic, strikethrough, inline code, link, H1–H3, bullet/numbered/task lists,
  quote, table, code block and horizontal rule. Centered, always visible in
  normal windows (hidden only in sticky mode), acting on the live editor.

## Tabs & windows
- **Pin tabs** — right-click a tab to pin it; pinned tabs group at the left edge
  of the bar and survive restarts.
- **Tree follows your tabs** — opening a file or switching tabs reveals and
  highlights it in the side panel.
- **Gather all windows** — a gentler sibling of "Gather all windows and
  stickies": pulls every normal editor window into the current one while leaving
  post-its floating where they are.
- **Toggle side panel** — the panel button now only collapses the side panel;
  the formatting toolbar stays put.

---

# Notation v1.1.1

A minimalist local-first Markdown editor with desktop sticky notes. Every note is
just a `.md` file in a folder you control — no cloud, no account, just text files.

The first published release. Highlights since the 1.0.0 build:

## Live editor
- **Line-by-line live rendering** — the line under the caret shows its raw Markdown,
  everything else renders in place. Headings, lists, quotes, links, emphasis.
- **In-place table editing** — edit cell-by-cell, Tab/Enter navigation, add rows and
  columns as you type.
- **Math via KaTeX** — `$inline$` and `$$block$$`, rendered offline (KaTeX is bundled).
- **Smart typing** — auto-continued lists and task lists, auto-closed code fences,
  fenced code regions edited raw, Mermaid gantt blocks rendered as charts.
- **PDF export** keeps tables, code, math and gantt charts.

## Sticky notes
- **Move to sticky note** — right-click a tab to peel it straight off into an
  always-on-top post-it (its remembered colour and size apply).
- **Gather all windows and stickies** — one click pulls every window *and* post-it
  back into the current window; unsaved sticky edits are flushed to disk first.
- **Readable to-dos on every pastel** — task checkboxes now take a deep ink colour
  derived from the note's pastel, so they're clearly visible on purple, green and
  every other swatch.
- **Double-click to maximize** — double-click a post-it's title bar to maximize it
  like any window (it stays on top); double-click again to put it back at its
  post-it size. No more flash-and-shrink glitch.
- **Long note titles ellipsize** instead of running under the title-bar buttons.

## Workspaces & windows
- **Live sidebar** — the workspace tree updates within a moment of files being
  created, deleted, renamed or moved outside the app (file manager, scripts, sync).
- **Subtler tab overflow** — a thin blue line marks the clipped edge of the tab bar
  instead of the old gradient.
- Sessions persist across restarts: windows, tabs, stickies, geometry.
