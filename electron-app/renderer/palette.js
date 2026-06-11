// Per-project colour: the single source of truth for the preset pastel
// palette, the status-aware shading used by the Kanban cards and Gantt bars,
// and the project-colour metadata stored in each .md file.
//
// Colour is persisted as a Mermaid comment INSIDE the ```mermaid block, next
// to the profile tag, e.g.  %% projector:color #fbc4ab — Mermaid renders no
// comment, so the diagram stays clean in any other .md/Mermaid editor. It is a
// field on the parsed model (GanttParse handles the round-trip), so ordinary
// task edits preserve it. Older files stored it as an HTML comment outside the
// block; readColor still understands that form and writeColor migrates it.

(function (global) {
  'use strict';

  // Preset pastels, in the same gentle family as the rest of the chrome. Ordered
  // by hue (warm reds → yellows → greens → teal → cyan → blue → violet → magenta
  // → pink), so the 5-wide picker grid groups like colours together — each row is
  // one temperature band. Where two pastels share a hue family they're spread
  // apart in lightness/saturation (e.g. light blue vs deeper cornflower, light
  // periwinkle vs deeper iris) so adjacent swatches never look identical.
  const PRESETS = [
    { name: 'salmon',     hex: '#ffb3a3' },
    { name: 'blush',      hex: '#faceb7' },
    { name: 'peach',      hex: '#ffd39e' },
    { name: 'honey',      hex: '#ffe59e' },
    { name: 'butter',     hex: '#ffffb8' },
    { name: 'lime',       hex: '#d8f59e' },
    { name: 'mint',       hex: '#ccfcc0' },
    { name: 'sage',       hex: '#bbe7c8' },
    { name: 'seafoam',    hex: '#a9efd8' },
    { name: 'aqua',       hex: '#b6f1ed' },
    { name: 'sky',        hex: '#adf1ff' },
    { name: 'blue',       hex: '#add6ff' },
    { name: 'cornflower', hex: '#91a8f3' },
    { name: 'periwinkle', hex: '#bbb8ff' },
    { name: 'iris',       hex: '#b39df1' },
    { name: 'lilac',      hex: '#dcc2ff' },
    { name: 'mauve',      hex: '#ddacf6' },
    { name: 'orchid',     hex: '#f2bef9' },
    { name: 'rose',       hex: '#ffc2f3' },
    { name: 'petal',      hex: '#ffb8db' },
  ];

  // Current form: a Mermaid comment inside the gantt block.
  const COLOR_RE = /%%\s*projector:color\s+(#[0-9a-fA-F]{3,8})/i;
  // Pre-1.1.x form: an HTML comment outside the block. Read for back-compat;
  // the *_LINE form removes its (always standalone) line during migration.
  const LEGACY_COLOR_RE = /<!--\s*projector:color\s+(#[0-9a-fA-F]{3,8})\s*-->/i;
  const LEGACY_COLOR_LINE_RE = /^\s*<!--\s*projector:color\s+#[0-9a-fA-F]{3,8}\s*-->\s*$/i;

  // ---- hex <-> hsl ------------------------------------------------------

  function hexToRgb(hex) {
    let h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  function hexToHsl(hex) {
    const { r, g, b } = hexToRgb(hex);
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
        case gn: h = (bn - rn) / d + 2; break;
        default: h = (rn - gn) / d + 4;
      }
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  function adjust(hex, dl, ds) {
    const { h, s, l } = hexToHsl(hex);
    return hslToHex(h, s + (ds || 0), l + (dl || 0));
  }

  // ---- status-aware shading --------------------------------------------
  // Pastels are already light, so text always stays dark. Status reads as a
  // lightness ramp on top of the project's base hue: To Do faded, In Progress
  // full, Done lighter + desaturated.
  const TEXT = '#2a2a2a';

  function shade(hex, status) {
    const base = hex || '#dcdcdc';
    if (status === 'done') {
      return { fill: adjust(base, +12, -22), stroke: adjust(base, -3, -6), text: TEXT };
    }
    if (status === 'todo') {
      // To Do has the palest fill, so the edge needs real contrast or it
      // vanishes on light pastels — darken (and slightly saturate) the stroke.
      return { fill: adjust(base, +18, -30), stroke: adjust(base, -16, +6), text: TEXT };
    }
    // active / in progress — gentle edge, not a hard outline
    return { fill: base, stroke: adjust(base, -8, -4), text: TEXT };
  }

  // Very light background tint, for small chips/badges.
  function tint(hex) {
    return adjust(hex || '#dcdcdc', +24, -34);
  }

  // Sticky-note styling for a Kanban card: the pastel itself (barely softened
  // so it still clearly reads as the colour) with a faint, slightly darker
  // border instead of a hard outline.
  function cardFill(hex) {
    return adjust(hex || '#dcdcdc', +4, -4);
  }
  function cardBorder(hex) {
    return adjust(hex || '#dcdcdc', -9, +2);
  }
  // Deep, legible version of the hue for coloured text on a light chip.
  function ink(hex) {
    return adjust(hex || '#888888', -52, -8);
  }

  // A brighter, "neon" sibling of the pastel — same hue (so it never clashes
  // with the card) but cranked saturation and a darker, more vivid lightness.
  // Used to ring an in-progress task in the Team view.
  function neon(hex) {
    const { h, s } = hexToHsl(hex || '#9bf6ff');
    return hslToHex(h, Math.min(100, Math.max(s, 90)), 58);
  }

  // A section badge that lives in the project's colour family: same hue, just a
  // small deterministic nudge per section so different sections stay
  // distinguishable without clashing with the sticky-note card.
  function sectionChip(hex, section) {
    const base = hexToHsl(hex || '#dcdcdc');
    const n = hashIndex(section || 'General', 24);
    const hueShift = (n % 5) * 4 - 8;             // -8..+8 deg, same family
    const light = [80, 84, 87, 82][n % 4];        // a few gentle tones
    const sat = Math.max(30, Math.min(62, base.s * 0.55));
    return {
      bg: hslToHex(base.h + hueShift, sat, light),
      fg: hslToHex(base.h + hueShift, Math.max(40, Math.min(72, base.s * 0.8)), 34),
    };
  }

  // ---- markdown metadata round-trip ------------------------------------

  function readColor(md) {
    const text = String(md || '');
    const m = text.match(COLOR_RE) || text.match(LEGACY_COLOR_RE);
    return m ? m[1] : null;
  }

  // Store the colour as a Mermaid comment inside the gantt block, by round-
  // tripping through the model (the same path a task edit takes). Also strips
  // any legacy outside-block HTML comment, so picking a colour migrates the
  // file to the new in-block form. Returns new markdown unchanged if the file
  // has no mermaid block (colour has nowhere meaningful to live).
  function writeColor(md, hex) {
    const G = global.GanttParse;
    const cleaned = String(md || '')
      .split('\n')
      .filter((l) => !LEGACY_COLOR_LINE_RE.test(l))
      .join('\n');
    const block = G.extractMermaidBlock(cleaned);
    if (block.code === null) return cleaned;
    const model = G.parseGantt(block.code);
    model.color = hex;
    return G.writeBackToMarkdown(cleaned, model);
  }

  // ---- fallback colour for projects with no explicit choice ------------
  // Deterministic pick from PRESETS by title hash so the global view is never
  // monochrome before the user assigns colours.
  function hashIndex(name, mod) {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % mod;
  }

  // project: { color?, title?, file? }
  function colorFor(project) {
    if (project && project.color) return project.color;
    const key = (project && (project.title || project.file)) || '';
    return PRESETS[hashIndex(key, PRESETS.length)].hex;
  }

  global.Palette = {
    PRESETS,
    shade,
    tint,
    cardFill,
    cardBorder,
    ink,
    neon,
    sectionChip,
    readColor,
    writeColor,
    colorFor,
    hexToHsl,
    hslToHex,
  };
})(window);
