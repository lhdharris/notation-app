// Builds a self-contained, print-ready HTML document for "Export to PDF".
//
// window.NotePdf.buildDocument({ title, bodyHtml, dateISO }) returns one HTML
// string (inline <style>, no external assets and no scripts) that the main
// process loads in a hidden window and renders with printToPDF. `bodyHtml` is
// the already-rendered note (window.renderMarkdown), so any inline SVG (gantt)
// carries through verbatim.
//
// The page chrome mirrors res/projector-app's exporter — a system-ui document
// with a bold title, a grey "Generated …" subtitle, a thin rule, and per-page
// numbers stamped by main's footer template — but with NO repo/attribution.
// The body styles are a print-tuned port of style.css's `.markdown-body`.

(function (global) {
  'use strict';

  // Same system-ui stack Projector prints with: keeps the document asset-free.
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDate(dateISO) {
    const d = dateISO ? new Date(dateISO) : new Date();
    if (isNaN(d)) return '';
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  // Print stylesheet: a faithful, paper-tuned port of `.markdown-body` from
  // style.css, plus the document title/subtitle chrome.
  function styles() {
    return `
      @page { size: Letter portrait; margin: 16mm 16mm 18mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #2a2a2a;
        font-family: ${FONT}; font-size: 13px; line-height: 1.65;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; }

      /* Document header — bold title + grey subtitle + thin rule. */
      .doc-head { margin: 0 0 16px; }
      .doc-title { font-size: 22px; font-weight: 700; color: #222; line-height: 1.25; }
      .doc-sub { font-size: 11.5px; color: #777; margin-top: 3px; }
      .doc-rule { border: none; border-top: 1px solid #e6e8ea; margin: 9px 0 0; height: 0; background: none; }

      /* ---- markdown body (ported from style.css .markdown-body) ---- */
      .markdown-body h1, .markdown-body h2, .markdown-body h3,
      .markdown-body h4, .markdown-body h5, .markdown-body h6 {
        line-height: 1.3; margin: 0.47em 0 0.5em; font-weight: 600; break-after: avoid; }
      .markdown-body h1 { font-size: 1.9em; }
      .markdown-body h2 { font-size: 1.5em; }
      .markdown-body h3 { font-size: 1.25em; }
      .markdown-body h4 { font-size: 1.1em; }
      .markdown-body h5, .markdown-body h6 { font-size: 1em; color: #666; }
      .markdown-body p { margin: 0.7em 0; }
      .markdown-body hr { border: none; height: 1px; margin: 1.1em 0; background: #dcdcdc; }
      .markdown-body a { color: #1a73c0; text-decoration: none; }
      .markdown-body strong { font-weight: 600; }
      .markdown-body em { font-style: italic; }
      .markdown-body del { color: #999; }
      .markdown-body mark { background: #fff3a6; padding: 0.05em 0.15em; border-radius: 3px; }
      .markdown-body sup.fn-ref { color: #1a73c0; font-size: 0.75em; }
      .markdown-body section.footnotes { margin-top: 1.2em; color: #5a6b73; font-size: 0.92em; }
      .markdown-body .math-block { margin: 0.8em 0; text-align: center; break-inside: avoid; }
      .markdown-body ul, .markdown-body ol { margin: 0.6em 0; padding-left: 1.6em; }
      .markdown-body li { margin: 0.2em 0; }
      .markdown-body blockquote { margin: 0.8em 0; padding: 0.2em 1em;
        border-left: 3px solid #cfe3ee; color: #5a6b73; background: #f7fafc;
        break-inside: avoid; }
      .markdown-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.88em; background: #f1f1f1; padding: 0.15em 0.4em; border-radius: 4px; }
      .markdown-body pre { background: #f6f8fa; border: 1px solid #ececec; border-radius: 8px;
        padding: 12px 14px; margin: 0.8em 0; white-space: pre-wrap; word-break: break-word;
        break-inside: avoid; }
      .markdown-body pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.5; }
      .markdown-body img { max-width: 100%; border-radius: 6px; }
      .markdown-body table { border-collapse: collapse; margin: 0.8em 0; break-inside: avoid; }
      .markdown-body th, .markdown-body td { border: 1px solid #e2e2e2; padding: 6px 10px; }
      .markdown-body th { background: #f6f6f6; }

      /* gantt card (inline SVG already embedded in bodyHtml) */
      .gantt-block { margin: 0.9em 0; padding: 8px 10px; background: #fff;
        border: 1px solid #ececec; border-radius: 8px; break-inside: avoid; }
      .gantt-block .gantt-svg { display: block; max-width: 100%; }

      /* task lists */
      .markdown-body ul.contains-task-list { list-style: none; padding-left: 0.4em; }
      .markdown-body li.task-list-item { display: flex; align-items: flex-start; gap: 0.55em; }
      .markdown-body .task-checkbox { flex: 0 0 auto; width: 1.05em; height: 1.05em;
        margin-top: 0.34em; accent-color: #1a73c0; }
      .markdown-body .task-body { flex: 1 1 auto; min-width: 0; }
    `;
  }

  function buildDocument(opts) {
    opts = opts || {};
    const title = opts.title || 'Untitled';
    const bodyHtml = opts.bodyHtml || '';
    // extraCss: vendored stylesheet text inlined verbatim (e.g. KaTeX's css
    // when the note contains math) — the document must stay self-contained.
    const extra = opts.extraCss ? `<style>${opts.extraCss}</style>` : '';
    const sub = `Generated ${fmtDate(opts.dateISO)}`;
    return '<!doctype html><html><head><meta charset="utf-8">'
      + `<title>${esc(title)}</title>`
      + `<style>${styles()}</style>${extra}</head><body>`
      + `<div class="doc-head"><div class="doc-title">${esc(title)}</div>`
      + `<div class="doc-sub">${esc(sub)}</div><hr class="doc-rule"></div>`
      + `<div class="markdown-body">${bodyHtml}</div>`
      + '</body></html>';
  }

  global.NotePdf = { buildDocument };
})(typeof window !== 'undefined' ? window : globalThis);
