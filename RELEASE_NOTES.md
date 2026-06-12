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

## Live editor (Typora-style)
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
