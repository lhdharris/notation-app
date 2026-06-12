// A small, dependency-free Markdown → HTML renderer. No remote/CDN script, so it
// stays inside the renderer's strict CSP. Supports the common subset a notes app
// needs: ATX headings, fenced/inline code, blockquotes, ordered & unordered lists
// (nested by indentation), horizontal rules, GFM tables, and inline emphasis,
// strikethrough, links, images, and bare-URL autolinks. Source comes from the
// user's own local files, but everything is HTML-escaped anyway.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // ---- reference links & footnotes --------------------------------------
  // Definitions ([id]: url and [^id]: text) live on their own source lines.
  // The live editor collects them document-wide (collectRefs via
  // window.collectMarkdownRefs + window.setMarkdownRefs) so per-line
  // renderInline calls can resolve [label][id] / [^id]; renderMarkdown
  // collects from its own source and overlays the editor-set map.
  const LINK_DEF_RE = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(\S+)\s*$/;
  const NOTE_DEF_RE = /^ {0,3}\[\^([^\]]+)\]:\s+(\S.*)$/;
  let REFS = { links: new Map(), notes: new Map() };

  function collectRefs(lines) {
    const links = new Map(), notes = new Map();
    for (const ln of lines) {
      let m = NOTE_DEF_RE.exec(ln);
      if (m) {
        const key = m[1].toLowerCase();
        if (!notes.has(key)) notes.set(key, { n: notes.size + 1, text: m[2] });
        continue;
      }
      m = LINK_DEF_RE.exec(ln);
      if (m) {
        const key = m[1].toLowerCase();
        if (!links.has(key)) links.set(key, m[2]);
      }
    }
    return { links, notes };
  }

  // ---- image path resolution ---------------------------------------------
  // The page is loaded from file://…/renderer/, so a note's relative image path
  // would resolve against the app directory and never show. The app sets the
  // active note's folder here (setMarkdownImageBase) and every rendered <img>
  // src is resolved against it into an absolute file:// URL. Remote/data/file
  // srcs pass through untouched; the PDF exporter converts file:// back to a
  // path when inlining (inlineNoteImages in main.js).
  let IMG_BASE = null;

  function resolveImageSrc(src) {
    src = String(src == null ? '' : src).trim();
    if (!src || /^(?:https?:|data:|file:|\/\/)/i.test(src)) return src;
    let p = src.replace(/\\/g, '/');
    if (!/^\//.test(p)) {
      if (!IMG_BASE) return src;
      p = IMG_BASE.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + p;
    }
    return 'file://' + encodeURI(p).replace(/[?#]/g, encodeURIComponent);
  }

  // ---- inline ----------------------------------------------------------
  function renderInline(text) {
    // Inline math $...$ is lifted out before escaping (KaTeX wants raw TeX) and
    // stashed behind private-use sentinels that survive every later pass. Code
    // spans are shielded first so `$x$` inside backticks stays literal, and \$
    // never opens/closes a span (inside math it stays TeX's \$; outside, the
    // escape is consumed to a plain $).
    const maths = [];
    if (text.indexOf('$') !== -1 && typeof window !== 'undefined' && window.katex) {
      const shield = [];
      text = text.replace(/`[^`]+`/g, (m) => {
        shield.push(m);
        return '\uE003' + (shield.length - 1) + '\uE004';
      });
      text = text.replace(/\\\$/g, '\uE002');
      text = text.replace(/\$([^\s$](?:[^$\n]*[^\s$])?)\$/g, (_, tex) => {
        maths.push(window.katex.renderToString(tex.replace(/\uE002/g, '\\$'),
          { throwOnError: false }));
        return '\uE000' + (maths.length - 1) + '\uE001';
      });
      text = text.replace(/\uE002/g, '$');
      text = text.replace(/\uE003(\d+)\uE004/g, (_, n) => shield[+n]);
    }

    text = escapeHtml(text);

    // Pull code spans out first so their contents are never touched by the
    // emphasis/link passes below.
    const codes = [];
    text = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return ` C${codes.length - 1} `;
    });

    // images, then links (images first so ![..](..) isn't eaten as a link).
    // The path may contain spaces, optionally <>-wrapped (escaped to &lt;/&gt;
    // by the time this pass runs); resolve it against the active note's folder
    // so relative images display.
    text = text.replace(/!\[([^\]]*)\]\(\s*(?:&lt;)?([^)\n]+?)(?:&gt;)?(?:\s+"([^"]*)")?\s*\)/g,
      (_, alt, src, title) =>
        `<img src="${escapeAttr(resolveImageSrc(src))}" alt="${alt.replace(/"/g, '&quot;')}"` +
        `${title ? ` title="${escapeAttr(title)}"` : ''}>`);
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, label, href, title) =>
        `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${label}</a>`);

    // footnote reference [^id] -> superscript number (definition order)
    text = text.replace(/\[\^([^\]\s]+)\]/g, (m0, id) => {
      const def = REFS.notes.get(id.toLowerCase());
      return def ? `<sup class="fn-ref">${def.n}</sup>` : m0;
    });
    // reference link [label][id] / [label][] (resolved via collected definitions)
    text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m0, label, id) => {
      const href = REFS.links.get((id || label).toLowerCase());
      return href ? `<a href="${escapeAttr(href)}">${label}</a>` : m0;
    });

    // emphasis (most specific first)
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

    // bare-URL autolink (only when preceded by start/space/paren so it can't
    // match inside an href="..." attribute we just produced)
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, pre, url) => `${pre}<a href="${escapeAttr(url)}">${url}</a>`);

    // every source newline is a visible line break (the editor treats each Enter
    // as a new source line), and a trailing-space / backslash hard-break marker is
    // absorbed into it
    text = text.replace(/(?: {2,}|\\)?\n/g, '<br>');

    // restore code spans (contents already escaped, don't re-escape)
    text = text.replace(/ C(\d+) /g, (_, n) => `<code>${codes[+n]}</code>`);
    // restore math last — KaTeX HTML must never be touched by the passes above
    text = text.replace(/\uE000(\d+)\uE001/g, (_, n) => maths[+n]);
    return text;
  }

  // ---- block-level helpers --------------------------------------------
  function isBlockStart(line) {
    return /^ {0,3}(`{3,}|~{3,})/.test(line) ||
           /^ {0,3}#{1,6}\s/.test(line) ||
           /^ {0,3}>/.test(line) ||
           /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line) ||
           /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
           /^\s*\$\$/.test(line) ||
           NOTE_DEF_RE.test(line) || LINK_DEF_RE.test(line);
  }

  // Split a pipe row into cell texts, honouring \| escapes (the escape is
  // resolved here, so cells hold plain text; serializeTableRegion re-escapes).
  function splitRow(line) {
    const s = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  // ---- table region model (shared with the live editor's cell-grid editor) --
  // parseTableRegion: the region's source lines -> { header[], aligns[], rows[][] }
  // (cell texts unescaped, widths normalised to the header).
  // serializeTableRegion: the model -> padded pipe source lines.
  function parseTableRegion(regionLines) {
    const header = splitRow(regionLines[0]);
    const w = header.length;
    const fit = (a, fill) => { const b = a.slice(0, w); while (b.length < w) b.push(fill); return b; };
    const aligns = fit(splitRow(regionLines[1] || '').map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    }), '');
    const rows = regionLines.slice(2).map((ln) => fit(splitRow(ln), ''));
    return { header, aligns, rows };
  }
  function serializeTableRegion(t) {
    const esc = (c) => String(c == null ? '' : c).replace(/\|/g, '\\|');
    const row = (cells) => '| ' + cells.map(esc).join(' | ') + ' |';
    const sep = t.aligns.map((a) =>
      a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
    return [row(t.header), '| ' + sep.join(' | ') + ' |', ...t.rows.map(row)];
  }

  function parseTable(lines, start) {
    const header = splitRow(lines[start]);
    const aligns = splitRow(lines[start + 1]).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
      rows.push(splitRow(lines[i]));
      i++;
    }
    const styleOf = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '');
    let html = '<table><thead><tr>';
    header.forEach((c, n) => { html += `<th${styleOf(n)}>${renderInline(c)}</th>`; });
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      header.forEach((_, n) => { html += `<td${styleOf(n)}>${renderInline(row[n] || '')}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    return { html, next: i };
  }

  function parseList(lines, start) {
    const base = lines[start].match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    const baseIndent = base[1].length;
    const ordered = /\d/.test(base[2]);
    let i = start;
    const items = [];

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        // tolerate a blank line between items only if a SAME-TYPE item follows
        // at the same indent (a switch from "-" to "1." starts a new list)
        let j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        const mj = j < lines.length && lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (mj && mj[1].length === baseIndent && /\d/.test(mj[2]) === ordered) { i = j; continue; }
        break;
      }
      const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
      if (!m || m[1].length < baseIndent) break;
      if (m[1].length > baseIndent) break;       // deeper start is handled as a child
      if (/\d/.test(m[2]) !== ordered) break;     // marker type switched -> new list

      const contentIndent = m[1].length + m[2].length + m[3].length;
      // GFM task list: an item whose content starts with `[ ]` / `[x]` becomes a
      // checkbox. We strip the marker here so the rest renders normally; the
      // live editor maps each rendered checkbox back to its source line.
      let task = null;
      let first = m[4];
      const tm = first.match(/^\[([ xX])\]\s+(.*)$/);
      if (tm) { task = /[xX]/.test(tm[1]); first = tm[2]; }
      const itemLines = [first];
      i++;
      // gather continuation + nested (more-indented) lines for this item
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) {
          const l2 = lines[i + 1];
          if (l2 && !/^\s*$/.test(l2) && l2.match(/^(\s*)/)[1].length > baseIndent) {
            itemLines.push(''); i++; continue;
          }
          break;
        }
        const indent = l.match(/^(\s*)/)[1].length;
        if (indent <= baseIndent) break; // sibling or end
        itemLines.push(l.slice(Math.min(contentIndent, indent)));
        i++;
      }
      items.push({ body: renderItemBody(itemLines), task });
    }

    const tag = ordered ? 'ol' : 'ul';
    const hasTask = items.some((it) => it.task !== null);
    const lis = items.map((it) => {
      if (it.task !== null) {
        const box = `<input type="checkbox" class="task-checkbox"${it.task ? ' checked' : ''}>`;
        return `<li class="task-list-item">${box}<span class="task-body">${it.body}</span></li>`;
      }
      return `<li>${it.body}</li>`;
    }).join('');
    const cls = hasTask ? ` class="contains-task-list"` : '';
    return { html: `<${tag}${cls}>${lis}</${tag}>`, next: i };
  }

  function renderItemBody(itemLines) {
    if (itemLines.length === 1) return renderInline(itemLines[0]);
    let inner = renderBlocks(itemLines);
    const single = inner.match(/^<p>([\s\S]*)<\/p>$/);
    if (single && !/<p>/.test(single[1])) inner = single[1]; // tighten single-paragraph items
    return inner;
  }

  function renderBlocks(lines) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // fenced code
      const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[2][0];
        const len = fence[2].length;
        const lang = fence[3].trim();
        const buf = [];
        i++;
        while (i < lines.length) {
          const c = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*$/);
          if (c && c[2][0] === marker && c[2].length >= len) { i++; break; }
          buf.push(lines[i]); i++;
        }
        // A ```mermaid block holding a gantt diagram renders as a chart (styled
        // like res/projector-app), if the renderer is loaded. Anything else — and
        // any failure — falls back to showing the code verbatim.
        const first = buf.find((l) => l.trim());
        if (/^mermaid$/i.test(lang) && first && /^gantt\b/i.test(first.trim())
            && typeof window !== 'undefined' && typeof window.GanttRender === 'function') {
          try {
            const svg = window.GanttRender(buf.join('\n'));
            if (svg) { html += svg; continue; }
          } catch (_) { /* fall through to plain code */ }
        }
        const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
        html += `<pre><code${cls}>${escapeHtml(buf.join('\n'))}\n</code></pre>`;
        continue;
      }

      // display math: $$ ... $$ (single line or a multi-line region closed by a
      // line ending in $$). Rendered with KaTeX when available, else shown as code.
      if (/^\s*\$\$/.test(line)) {
        const buf = [];
        const first = line.replace(/^\s*\$\$/, '');
        i++;
        if (first.trim() && /\$\$\s*$/.test(first)) {
          buf.push(first.replace(/\$\$\s*$/, ''));
        } else {
          if (first.trim()) buf.push(first);
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
          if (i < lines.length) {
            const last = lines[i].replace(/\$\$\s*$/, '');
            if (last.trim()) buf.push(last);
            i++;
          }
        }
        const tex = buf.join('\n');
        if (typeof window !== 'undefined' && window.katex) {
          html += `<div class="math-block">${window.katex.renderToString(tex, { throwOnError: false, displayMode: true })}</div>`;
        } else {
          html += `<pre><code>${escapeHtml(tex)}\n</code></pre>`;
        }
        continue;
      }

      // heading
      const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { html += `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`; i++; continue; }

      // horizontal rule → a subtle grey rule (a block boundary via isBlockStart).
      // Sized to one line tall in CSS so toggling the raw "---" line ↔ the rendered
      // rule doesn't reflow the lines around it (see .markdown-body hr in style.css).
      if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) { html += '<hr>'; i++; continue; }

      // blockquote
      if (/^ {0,3}>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
          buf.push(lines[i].replace(/^ {0,3}>\s?/, '')); i++;
        }
        html += `<blockquote>${renderBlocks(buf)}</blockquote>`;
        continue;
      }

      // table (header row followed by a |---|---| separator)
      if (line.includes('|') && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const t = parseTable(lines, i);
        html += t.html; i = t.next; continue;
      }

      // list
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const l = parseList(lines, i);
        html += l.html; i = l.next; continue;
      }

      // link / footnote definition lines: collected up front (collectRefs),
      // nothing to show in the rendered flow (footnotes get an end section)
      if (NOTE_DEF_RE.test(line) || LINK_DEF_RE.test(line)) { i++; continue; }

      // setext heading: a single text line underlined with === (h1) or --- (h2)
      if (i + 1 < lines.length && /^ {0,3}(=+|-{2,})\s*$/.test(lines[i + 1])) {
        const lvl = lines[i + 1].trim()[0] === '=' ? 1 : 2;
        html += `<h${lvl}>${renderInline(line.trim())}</h${lvl}>`;
        i += 2; continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        buf.push(lines[i]); i++;
      }
      html += `<p>${renderInline(buf.join('\n'))}</p>`;
    }
    return html;
  }

  function renderMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    // Overlay this source's own definitions on the editor-set document map (a
    // region slice rendered mid-document still resolves doc-wide refs).
    const saved = REFS;
    const local = collectRefs(lines);
    REFS = {
      links: new Map([...saved.links, ...local.links]),
      notes: local.notes.size ? local.notes : saved.notes,
    };
    let html;
    try {
      html = renderBlocks(lines);
      if (local.notes.size) {
        html += '<section class="footnotes"><hr><ol>';
        for (const d of local.notes.values()) html += `<li>${renderInline(d.text)}</li>`;
        html += '</ol></section>';
      }
    } finally {
      REFS = saved;
    }
    return html;
  }

  // ---- active-line highlighter ----------------------------------------
  // Like renderInline, but KEEPS the markdown markers (shown dimmed via .le-mark)
  // so the cursor's line can display styled content while staying editable raw
  // text. Every original character is preserved verbatim, so the element's
  // textContent equals the source line — a 1:1 caret-offset mapping the live
  // editor relies on. Used only for the active line, never the rendered document.
  //
  // Each marker-span + styled-content chunk is stashed behind a sentinel token
  // (CharCode 0 <index> CharCode 1) so a later pass can't re-process markers we've
  // already consumed. The sentinels are built at runtime (kept out of the source)
  // and stripped from the input up front, so they can never collide with real
  // text; all are restored before returning.
  const SENT_A = String.fromCharCode(0), SENT_B = String.fromCharCode(1);
  function mark(s) { return '<span class="le-mark">' + s + '</span>'; }

  function highlightInline(src) {
    const raw = String(src == null ? '' : src).split(SENT_A).join('').split(SENT_B).join('');
    let text = escapeHtml(raw);
    const tokens = [];
    const stash = (html) => { tokens.push(html); return SENT_A + (tokens.length - 1) + SENT_B; };

    // Leading block marker (at most one per line): heading #, blockquote >, or a
    // list bullet. Dimmed; the rest of the line is highlighted as inline content.
    text = text.replace(/^(\s*)(#{1,6})(\s+)/, (_, sp, h, s) => sp + stash(mark(h)) + s);
    text = text.replace(/^(\s*)((?:&gt;)+)(\s?)/, (_, sp, q, s) => sp + stash(mark(q)) + s);
    text = text.replace(/^(\s*)([-*+]|\d+[.)])(\s+)/, (_, sp, b, s) => sp + stash(mark(b)) + s);

    // inline code first so its contents are never touched by later passes
    text = text.replace(/`([^`]+)`/g, (_, c) => stash(mark('`') + '<code>' + c + '</code>' + mark('`')));

    // inline math: dimmed $ markers, the TeX between kept verbatim (\$ never
    // delimits; it stays literal in the raw active line)
    text = text.replace(/\\\$/g, '\uE002');
    text = text.replace(/\$([^\s$](?:[^$\n]*[^\s$])?)\$/g, (_, tex) =>
      stash(mark('$') + '<span class="le-math">' + tex.replace(/\uE002/g, '\\$') + '</span>' + mark('$')));
    text = text.replace(/\uE002/g, '\\$');

    // image then link (image first so ![..](..) isn't eaten as a link). The label
    // is styled; the brackets/parens/url are shown as dimmed markers.
    text = text.replace(/!\[([^\]]*)\]\(([^)\n]*)\)/g, (_, alt, srcUrl) =>
      stash(mark('![') + alt + mark('](' + srcUrl + ')')));
    text = text.replace(/\[([^\]]+)\]\(([^)\n]*)\)/g, (_, label, href) =>
      stash(mark('[') + '<a class="le-link">' + label + '</a>' + mark('](' + href + ')')));

    // footnote reference (whole token dimmed), then reference-style link
    text = text.replace(/\[\^([^\]\s]+)\]/g, (_, id) => stash(mark('[^' + id + ']')));
    text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (_, label, id) =>
      stash(mark('[') + '<a class="le-link">' + label + '</a>' + mark('][' + id + ']')));

    // emphasis / strikethrough (most specific first), markers kept
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, (_, c) => stash(mark('***') + '<strong><em>' + c + '</em></strong>' + mark('***')));
    text = text.replace(/\*\*([^*]+)\*\*/g, (_, c) => stash(mark('**') + '<strong>' + c + '</strong>' + mark('**')));
    text = text.replace(/__([^_]+)__/g, (_, c) => stash(mark('__') + '<strong>' + c + '</strong>' + mark('__')));
    text = text.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, (_, pre, c) => pre + stash(mark('*') + '<em>' + c + '</em>' + mark('*')));
    text = text.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, (_, pre, c) => pre + stash(mark('_') + '<em>' + c + '</em>' + mark('_')));
    text = text.replace(/~~([^~]+)~~/g, (_, c) => stash(mark('~~') + '<del>' + c + '</del>' + mark('~~')));
    text = text.replace(/==([^=\n]+)==/g, (_, c) => stash(mark('==') + '<mark>' + c + '</mark>' + mark('==')));

    // restore stashed pieces (loop covers the rare nested case, e.g. code in bold)
    const restore = new RegExp(SENT_A + '(\\d+)' + SENT_B, 'g');
    for (let i = 0; i < 6 && text.indexOf(SENT_A) !== -1; i++) {
      text = text.replace(restore, (_, n) => tokens[+n]);
    }
    return text;
  }

  window.renderMarkdown = renderMarkdown;
  window.highlightInline = highlightInline;
  // The folder of the active note: relative image paths resolve against it.
  window.setMarkdownImageBase = (dir) => { IMG_BASE = dir || null; };
  // Table region model helpers for the live editor's WYSIWYG cell editing.
  window.parseTableRegion = parseTableRegion;
  window.serializeTableRegion = serializeTableRegion;
  // Reference-link / footnote definitions: the live editor collects them from
  // the whole document and sets them here so per-line renderInline resolves.
  window.collectMarkdownRefs = collectRefs;
  window.setMarkdownRefs = (refs) => { if (refs) REFS = refs; };
  window.isRefDefLine = (line) => NOTE_DEF_RE.test(line) || LINK_DEF_RE.test(line);
  // The per-line live editor renders each inactive line's content (after its block
  // marker is stripped) with this — the rendered look, no markers.
  window.renderInline = renderInline;
  // The live editor uses this to tell whether two adjacent source lines belong to
  // the same paragraph (a soft <br> row) so it can match an active line's vertical
  // footprint to its rendered row (see live-editor.js #1a).
  window.isBlockStart = isBlockStart;
})();
